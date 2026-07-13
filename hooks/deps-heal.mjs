#!/usr/bin/env node
// context-mode runtime JS dependency self-heal (SessionStart).
//
// Problem: on plugin auto-update, pure-JS external packages under the cache's
//   node_modules get partially installed — only a subset (e.g. test/) survives,
//   especially @mixmark-io/domino — so turndown's require("@mixmark-io/domino")
//   throws MODULE_NOT_FOUND, ctx_fetch_and_index (HTML->markdown) crashes, and
//   every WebFetch redirect errors. Reproduced across 6 cache versions = an
//   install-time defect.
//
// context-mode's ensure-deps.mjs heals only better-sqlite3 (native) and checks
//   folder existence alone, so it misses partial installs. This hook reads the
//   active version's package.json dependencies, checks each pure-JS external's
//   integrity by "is its package.json present?", and reinstalls only the broken
//   ones. The range is read from package.json, so future bumps (domino 3.x, ...)
//   are handled automatically. better-sqlite3 is excluded — it needs
//   node-gyp/MSVC and is ensure-deps' responsibility.
//
// Pure Node.js built-ins only, so it loads even when node_modules is broken.
// Best-effort: a failure never blocks session start.
import { existsSync, readFileSync, realpathSync, rmSync, appendFileSync } from "node:fs";
import { resolve, join, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Claude reads a hook's stderr as failure, so every diagnostic goes to a log file
// next to this hook (same pattern as orphan-reaper) — never to stderr. (defect #4)
const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "context-mode-deps-heal.log");
function log(msg) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} [context-mode-deps-heal] ${msg}\n`);
  } catch {
    /* best effort */
  }
}

// defect #1 (shell injection): npm is spawned as `node <npm-cli.js> …` (see
// npmCliPath below), NEVER through the npm.cmd/npm shim. Going through the .cmd
// shim under execFileSync is both unsafe on unpatched Node (CVE-2024-27980
// under-escapes .cmd arguments) and outright broken on patched Node (>=18.20.2/
// 20.12.2/21.7.3 throw EINVAL for a .cmd unless shell:true). Invoking node
// directly bypasses cmd.exe entirely, so any range metacharacter (| > < ^)
// reaches npm as an inert argv element, not shell syntax. The whitelist below is
// defense-in-depth on top of that — not the sole barrier.
const SAFE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
// Allows exactly what a real semver range needs: a leading operator (^ ~ > < = *),
// digits/dots, `|` for the OR (`1||2`), `-` for prereleases / hyphen-ranges, and a
// literal space (not \s, so newlines and tabs stay excluded) for compound ranges
// like ">=1 <2".
const SAFE_RANGE = /^[a-z0-9^~><=*][a-z0-9.^~><=|* +-]*$/i;

export function validateSpec(name, range) {
  if (typeof name !== "string" || typeof range !== "string") return false;
  if (name.includes("..") || !SAFE_NAME.test(name)) return false;
  if (!SAFE_RANGE.test(range)) return false;
  return true;
}

// defect #3 (path traversal): resolve <root>/node_modules/<name> and confirm the
// result stays under node_modules. A dependency name containing ".." would
// otherwise let the rmSync below escape the install root.
export function resolveModuleDir(root, name) {
  if (name.includes("..")) return null;
  const dir = resolve(root, "node_modules", ...name.split("/"));
  const base = resolve(root, "node_modules") + sep;
  if (!dir.startsWith(base)) return null;
  return dir;
}

// Resolve npm's own CLI entry (npm-cli.js) so the install runs as `node <cli> …`
// instead of the npm.cmd/npm shim (see the defect #1 note above). npm ships
// bundled with node, so it lives next to the running node binary. Returns null
// if it can't be located — the caller then heals (and deletes) nothing, which is
// strictly safer than deleting a partial install it can't reinstall.
function npmCliPath() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), // Windows / standard node layout
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // POSIX prefix layout
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // No PATH-based fallback: `where`/`which` on Windows searches the CWD before
  // PATH, so a hostile workspace shipping npm.cmd + node_modules/npm/bin/npm-cli.js
  // could get its JS run via `node <that cli>` at SessionStart. Fail closed
  // instead — a non-standard node layout (npm not next to node) simply no-ops
  // (the user-level heal hook and a manual `npm install` remain the fallback).
  return null;
}

// Build the (file, args) for one heal install. Pure + exported so a test can pin
// that we invoke node with npm-cli.js — never a .cmd shim (defect #1).
export function installInvocation(npmCli, spec, root) {
  return {
    file: process.execPath,
    args: [
      npmCli, "install", spec, "--prefix", root, "--ignore-scripts",
      "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--loglevel=error",
    ],
  };
}

// Total internal budget for the heal loop, kept under the ~60s SessionStart
// host-hook budget (hooks.json sets no per-hook override) so the internal
// ETIMEDOUT fires (throw→caught→logged) before an abrupt host kill. deps-heal's
// other work (registry read, externals parse) is sub-second, so ~45s leaves margin.
const HEAL_BUDGET_MS = 45000;
// Don't rm+start an install we almost certainly can't finish within the deadline:
// if less than this remains, defer the package to next session (its fast-path
// re-detects it) rather than delete a partial we then can't reinstall in time.
const MIN_INSTALL_MS = 5000;

// Pure + exported for tests: ms available for the next heal install given the
// loop deadline and now. Returns 0 — caller stops and defers the rest — when
// less than MIN_INSTALL_MS remains; otherwise the full remaining budget, so N
// slow installs can't sum past the host kill.
export function installBudgetMs(deadlineTs, nowTs) {
  const remaining = deadlineTs - nowTs;
  return remaining >= MIN_INSTALL_MS ? remaining : 0;
}

// Only pure-JS dependencies that are require()d from node_modules at runtime.
// context-mode's esbuild bundle inlines most deps (zod, @modelcontextprotocol/sdk,
// ...) into server.bundle.mjs and leaves only those marked `--external:<pkg>` in
// the bundle script as runtime requires. Read that list dynamically (so future
// externals are covered) and drop better-sqlite3 (native -> ensure-deps' job).
// Bundled deps are unrelated to node_modules integrity, so excluding them avoids
// needless reinstall delay. Falls back to a fixed set if parsing fails.
const RUNTIME_EXTERNAL_FALLBACK = new Set(["turndown", "turndown-plugin-gfm", "@mixmark-io/domino"]);

function runtimeExternals(pj) {
  const bundle = (pj.scripts && pj.scripts.bundle) || "";
  const ext = new Set();
  for (const m of bundle.matchAll(/--external:([^\s"']+)/g)) {
    if (m[1] !== "better-sqlite3") ext.add(m[1]); // native -> ensure-deps' job
  }
  return ext.size ? ext : RUNTIME_EXTERNAL_FALLBACK;
}

function cfgDir() {
  const e = process.env.CLAUDE_CONFIG_DIR;
  if (e && e.trim() !== "") {
    return e.startsWith("~") ? resolve(homedir(), e.replace(/^~[/\\]?/, "")) : resolve(e);
  }
  return resolve(homedir(), ".claude");
}

// Active install path: find the `context-mode@<marketplace>` key in
// installed_plugins.json. The marketplace name is not hard-coded, so a rename
// does not break this. If the registry can't be read we heal nothing — doing
// nothing is safer than repairing the wrong tree.
function activeInstallPath() {
  try {
    const f = resolve(cfgDir(), "plugins", "installed_plugins.json");
    const ip = JSON.parse(readFileSync(f, "utf8"));
    const plugins = (ip && ip.plugins) || {};
    const key = Object.keys(plugins).find((k) => {
      if (!k.startsWith("ctxscribe@")) return false;
      const p = plugins[k] && plugins[k][0] && plugins[k][0].installPath;
      return typeof p === "string" && existsSync(p);
    });
    if (!key) return null;
    const p = plugins[key][0].installPath;
    try { return realpathSync(p); } catch { return p; }
  } catch {}
  return null;
}

// Run the heal only when executed directly as a hook — never on import. The test
// imports validateSpec/resolveModuleDir, and the heal (which reads the real plugin
// registry and may npm install or process.exit) must not run then.
function isDirectRun() {
  try {
    return Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    const root = activeInstallPath();
    if (!root || !existsSync(join(root, "package.json"))) process.exit(0);

    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const deps = pj.dependencies || {};

    // fast path: if every target external has its package.json, exit immediately
    // (just a handful of existsSync probes).
    const targets = runtimeExternals(pj);
    const broken = [];
    for (const [name, range] of Object.entries(deps)) {
      if (!targets.has(name)) continue; // only runtime-required pure-JS externals
      const dir = join(root, "node_modules", ...name.split("/"));
      if (!existsSync(join(dir, "package.json"))) broken.push([name, range]);
    }
    if (!broken.length) process.exit(0);

    // Spawn npm as `node <npm-cli.js>` — never the .cmd/npm shim (defect #1). If
    // npm-cli.js can't be located, heal and delete NOTHING: doing nothing beats
    // deleting a partial install we then can't reinstall.
    const npmCli = npmCliPath();
    if (!npmCli) { log("skipped all: npm-cli.js not found next to node — cannot reinstall safely"); process.exit(0); }
    log(`partial install detected: ${broken.map((b) => b[0]).join(", ")} — healing (tens of seconds on first run)...`);
    // One shared deadline for the whole loop, kept under the ~60s SessionStart
    // host budget (hooks.json sets no per-hook override). Each install's timeout
    // is the REMAINING budget, so N slow packages can't sum past the host kill;
    // when too little is left we stop and defer the rest to next session. The
    // internal ETIMEDOUT throws → caught below (logged, predictable) instead of
    // an abrupt host kill mid-write.
    const healDeadline = Date.now() + HEAL_BUDGET_MS;
    for (const [name, range] of broken) {
      // defect #1: never touch anything whose name/range fails the whitelist.
      if (!validateSpec(name, range)) { log(`skipped (failed whitelist): ${name}@${range}`); continue; }
      // defect #3: only delete a path that provably stays under root/node_modules.
      const dir = resolveModuleDir(root, name);
      if (!dir) { log(`skipped (path escapes node_modules): ${name}`); continue; }
      const spec = `${name}@${range}`;
      // Budget check BEFORE the rm: never delete a partial we then lack time to
      // reinstall — defer it (and the rest) to next session, which re-detects it.
      const budget = installBudgetMs(healDeadline, Date.now());
      if (budget <= 0) { log(`heal budget exhausted — deferring ${spec} and any remaining to next session`); break; }
      try { rmSync(dir, { recursive: true, force: true }); } catch {} // clear partial-install remnants before reinstall
      try {
        const { file, args } = installInvocation(npmCli, spec, root);
        execFileSync(file, args, { stdio: "ignore", timeout: budget, shell: false });
        log(`healed: ${spec}`);
      } catch (e) {
        log(`heal failed: ${spec} — ${String((e && e.message) || e).split("\n")[0]}`);
      }
    }
  } catch {}
}
