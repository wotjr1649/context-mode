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

// defect #1 (shell injection): validate name + range against a charset whitelist
// BEFORE any exec. On Windows, execFileSync(shell:false) on a .cmd (npm.cmd) does
// NOT fully escape arguments (CVE-2024-27980), so execFileSync alone is not a
// defense — this whitelist is load-bearing and MUST gate the exec.
const SAFE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
// First char also allows semver leading operators (^ ~ > < = *) so ranges like
// "^7.2.0" pass; the rest of the class stays tight. A literal space (not \s) is
// the only whitespace a real range needs ("&gt;=1 &lt;2") — newlines and tabs are
// excluded so this control does not lean on execFileSync's newline handling.
// `|` stays for the semver OR (`1||2`); it is the one residual metacharacter the
// whitelist cannot exclude, so on an unpatched Node it is neutralized by
// execFileSync(shell:false) instead — the two layers are co-dependent for `|`.
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
      if (!k.startsWith("context-mode@")) return false;
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

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    log(`partial install detected: ${broken.map((b) => b[0]).join(", ")} — healing (tens of seconds on first run)...`);
    for (const [name, range] of broken) {
      // defect #1: never touch anything whose name/range fails the whitelist.
      if (!validateSpec(name, range)) { log(`skipped (failed whitelist): ${name}@${range}`); continue; }
      // defect #3: only delete a path that provably stays under root/node_modules.
      const dir = resolveModuleDir(root, name);
      if (!dir) { log(`skipped (path escapes node_modules): ${name}`); continue; }
      try { rmSync(dir, { recursive: true, force: true }); } catch {} // clear partial-install remnants before reinstall
      const spec = `${name}@${range}`;
      try {
        // execFileSync(shell:false) + the validateSpec whitelist above. On Windows
        // the .cmd escaping is incomplete (CVE-2024-27980), so the whitelist — not
        // this call — is the real injection defense.
        execFileSync(
          npm,
          ["install", spec, "--prefix", root, "--ignore-scripts", "--no-save",
            "--no-package-lock", "--no-audit", "--no-fund", "--loglevel=error"],
          { stdio: "ignore", timeout: 180000, shell: false },
        );
        log(`healed: ${spec}`);
      } catch (e) {
        log(`heal failed: ${spec} — ${String((e && e.message) || e).split("\n")[0]}`);
      }
    }
  } catch {}
}
