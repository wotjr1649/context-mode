#!/usr/bin/env node
/**
 * Reap orphaned context-mode plugin processes on Windows (SessionStart).
 *
 * Why they exist: node intermittently fails to release the stdin handle on
 * Windows (nodejs/node#22999 — an explicit race), and Windows does not reap
 * children when their parent dies. Hooks, `context-mode statusline`, and the
 * MCP server could all leak through this one mechanism. The upstream
 * flushAndExit fix addresses the root cause, so this reaper is a safety net.
 *
 * Kill criteria — all three must hold:
 *   1. the command line's path sits UNDER the plugin cache root (see isReapable)
 *   2. parent PID is no longer alive (a true orphan; live trees are untouched)
 *   3. older than MIN_AGE_SEC (a freshly spawned hook is not an orphan yet)
 * Descendants of a doomed orphan are reaped with it. This process and every
 * one of its ancestors are protected unconditionally.
 *
 * Safe by default: DRY_RUN unless CONTEXT_MODE_REAPER_ARMED=1 (spec 9.2 —
 * deploy dry first, confirm zero false-positives in the log, then arm).
 * Pure Node.js built-ins only. Best-effort: a failure never blocks session
 * start. Side effects run only on direct execution, never on import (tests
 * import isReapable/reap without spawning PowerShell).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MIN_AGE_SEC = Number(process.env.CONTEXT_MODE_REAPER_MIN_AGE_SEC || 60);
// Safe by default: only a deliberate opt-in arms the reaper. The source
// inverted this (dry only with --dry-run); here dry is the ground state.
const ARMED = process.env.CONTEXT_MODE_REAPER_ARMED === "1";
const DRY_RUN = !ARMED;
const LOG_PATH = process.env.CONTEXT_MODE_REAPER_LOG
  || join(dirname(fileURLToPath(import.meta.url)), "context-mode-reaper.log");

// The kill judgment: the CommandLine's script argument must sit UNDER the
// plugin cache root (…/plugins/cache/<marketplace>/context-mode), not merely
// mention "context-mode" anywhere. The fork's own working directory is named
// context-mode, so a substring match would reap dev processes (vitest, npm
// run dev). We match the cache root as a path prefix, normalized for both
// separators. Anchoring on the cache root (not a version dir) keeps orphans
// left by a previous version in range after a bump. The trailing separator
// prevents a sibling like …/context-mode-js from matching …/context-mode.
export function isReapable(commandLine, cacheRoot) {
  if (typeof commandLine !== "string" || typeof cacheRoot !== "string") return false;
  const norm = (s) => s.replace(/\//g, "\\").toLowerCase();
  return norm(commandLine).includes(norm(cacheRoot) + "\\");
}

// Pure, injectable reaper: the caller passes the process snapshot and the
// self/ancestor pids so this is unit-testable without spawning PowerShell.
export function reap({ dryRun, procs, selfPid, ancestorPids, cacheRoot }) {
  const alive = new Set(procs.map((p) => p.ProcessId));
  // Never kill ourselves or anything we descend from.
  const protectedPids = new Set([selfPid, ...ancestorPids]);

  const isOrphan = (p) =>
    isReapable(p.CommandLine, cacheRoot) &&
    !alive.has(p.ParentProcessId) &&
    Number(p.AgeSec) > MIN_AGE_SEC &&
    !protectedPids.has(p.ProcessId);

  const doomed = new Set(procs.filter(isOrphan).map((p) => p.ProcessId));

  // Sweep in descendants of each orphan (e.g. the node under an orphaned shell).
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (doomed.has(p.ProcessId) || protectedPids.has(p.ProcessId)) continue;
      if (doomed.has(p.ParentProcessId)) { doomed.add(p.ProcessId); grew = true; }
    }
  }

  const killed = [];
  for (const pid of doomed) {
    if (dryRun) { killed.push(pid); continue; }
    try { process.kill(pid); killed.push(pid); } catch { /* already gone */ }
  }
  return { killed, scanned: procs.length };
}

function snapshot() {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine," +
      "@{n='AgeSec';e={((Get-Date) - $_.CreationDate).TotalSeconds}} | ConvertTo-Json -Compress"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000 },
  );
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function cfgDir() {
  const e = process.env.CLAUDE_CONFIG_DIR;
  if (e && e.trim() !== "") {
    return e.startsWith("~") ? resolve(homedir(), e.replace(/^~[/\\]?/, "")) : resolve(e);
  }
  return resolve(homedir(), ".claude");
}

// Cache root = parent of the active version dir. Reuses deps-heal's
// activeInstallPath pattern: find the `context-mode@<marketplace>` key in
// installed_plugins.json (marketplace name not hard-coded, so a rename does
// not break this), take its installPath (the version dir where package.json
// lives), and go up one level to …/cache/<marketplace>/context-mode.
// realpathSync-normalized so a junctioned cache still matches. Returns null if
// the registry can't be read — the caller then reaps nothing.
function pluginCacheRoot() {
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
    const versionDir = plugins[key][0].installPath;
    const root = resolve(versionDir, "..");
    try { return realpathSync(root); } catch { return root; }
  } catch {}
  return null;
}

// Run the reap only when executed directly as a hook — never on import. The
// test imports isReapable/reap, and the side effects below (real PowerShell,
// process.kill, process.exit) must not run then. Same pattern as deps-heal.
function isDirectRun() {
  try {
    return Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // Windows-only: the Win32_Process query is Win32-only and the orphan bug it
  // cleans up does not exist elsewhere. Guard before any PowerShell call.
  if (process.platform !== "win32") process.exit(0);

  let result = { killed: [], scanned: 0 };
  try {
    const cacheRoot = pluginCacheRoot();
    if (!cacheRoot) process.exit(0); // registry unreadable -> reap nothing

    const procs = snapshot();
    const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
    const selfPid = process.pid;
    const ancestorPids = [];
    for (let pid = selfPid; pid && byPid.has(pid); pid = byPid.get(pid).ParentProcessId) {
      if (ancestorPids.includes(pid)) break; // cycle guard
      ancestorPids.push(pid);
    }

    result = reap({ dryRun: DRY_RUN, procs, selfPid, ancestorPids, cacheRoot });
    if (result.killed.length > 0) {
      const stamp = new Date().toISOString();
      const verb = DRY_RUN ? "would-reap" : "reaped";
      appendFileSync(LOG_PATH, `${stamp} ${verb} ${result.killed.length}: ${result.killed.join(",")}\n`);
    }
  } catch { /* never block session start */ }

  if (DRY_RUN) {
    process.stdout.write(`scanned=${result.scanned} would-reap=${result.killed.length} pids=[${result.killed.join(",")}]\n`);
  }

  // Explicit exit: the very bug this hook cleans up (nodejs/node#22999) would
  // otherwise let this process leak too.
  process.exit(0);
}
