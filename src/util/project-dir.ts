import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import type { PlatformId } from "../adapters/types.js";
import { workspaceEnvVarsFor } from "../adapters/detect.js";

/**
 * Universal escape hatch. NEVER appears in any platform's workspace-var set
 * (because it isn't registered in PLATFORM_ENV_VARS), so it survives strict
 * mode and bridge env scrubs. Documented as the cross-strict user override
 * for every adapter (set in `~/.<host>/mcp.json` env when nothing else works).
 */
const UNIVERSAL_WORKSPACE_ENV = ["CONTEXT_MODE_PROJECT_DIR"] as const;

/**
 * Frozen legacy candidate list — preserves the relative order seen by every
 * non-strict caller (`start.mjs` and any caller that doesn't pass
 * `strictPlatform`). Order is locked for semver compatibility.
 *
 * Hard fork note: entries owned by removed platforms were pruned — a leaked
 * foreign workspace var must not steer kept-platform (claude-code/codex)
 * session attribution. The surviving entries keep their original order.
 *
 * If a new adapter is added, DO NOT add its workspace var here — register it
 * in `PLATFORM_ENV_VARS` and let strict callers pick it up via
 * `workspaceEnvVarsFor(platform)`. Strict mode is the default forward path.
 */
const LEGACY_NON_STRICT_CANDIDATES: readonly string[] = [
  "CLAUDE_PROJECT_DIR",
  "GEMINI_PROJECT_DIR",
  "VSCODE_CWD",
  "IDEA_INITIAL_DIRECTORY",
  "CONTEXT_MODE_PROJECT_DIR",
];

/**
 * Project-dir resolution helpers — shared between `start.mjs` (the MCP entry
 * point) and `src/server.ts getProjectDir()` (the consumer).
 *
 * Background: when Claude Code runs `/ctx-upgrade`, it kills + respawns the
 * MCP server. The respawn happens with `cwd` set to the plugin install
 * directory (`~/.claude/plugins/cache/wotjr1649/ctxscribe/<version>/`).
 * The legacy `start.mjs` then set `CLAUDE_PROJECT_DIR = originalCwd`, which
 * poisoned every downstream `ctx_stats` / SessionDB / hash computation —
 * sessions silently re-rooted under the plugin install path.
 *
 * Defense-in-depth fix (v1.0.113):
 *   - `start.mjs` calls `isPluginInstallPath(originalCwd)` and skips the env
 *     auto-set when true (no poisoning at the source).
 *   - `getProjectDir()` calls `resolveProjectDir(...)` which rejects plugin-
 *     pathed env vars and the plugin cwd, preferring `process.env.PWD`
 *     (shell-set, survives `process.chdir`) before falling back.
 */

/**
 * Detect whether a path lives inside an agent plugin install tree —
 * specifically `<home>/.claude/plugins/cache/<plugin>/<plugin>/<version>/`,
 * `<home>/.codex/plugins/cache/<plugin>/<plugin>/<version>/`, or the
 * marketplace mirror under `<home>/.{claude,codex}/plugins/marketplaces/...`.
 *
 * Cross-OS: matches both POSIX (`/`) and Windows (`\`) path separators.
 * Independent of `home` location — we only care about the agent plugin
 * suffix pattern.
 */
export function isPluginInstallPath(p: string): boolean {
  if (!p) return false;
  return /[/\\]\.(claude|codex)[/\\]plugins[/\\](cache|marketplaces)[/\\]/.test(p);
}

/**
 * Read the per-session project dir from Claude Code's transcript files.
 *
 * Claude Code writes session transcripts under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Each line is a JSON
 * event; an early line (typically line 2) carries a `cwd` field with the
 * literal project directory the session is running against. The encoded dir
 * name itself is lossy (`/` and `.` both become `-`), so we read the JSONL.
 *
 * This is the strongest available signal when Claude Code does NOT propagate
 * `CLAUDE_PROJECT_DIR` to the spawned MCP env (the common case when Claude
 * Code is launched from the desktop app rather than `cd <project> && claude`).
 *
 * Returns `undefined` when no transcript exists, the projects dir is empty,
 * or no transcript carries a `cwd` field — caller falls through.
 *
 * Multi-window safety: the most-recently-modified jsonl wins. When the user
 * actively talks to one Claude Code window, that window's transcript is the
 * one being written to RIGHT NOW, so its mtime is freshest. Other windows'
 * transcripts have older mtimes and are correctly ignored.
 */
export function resolveProjectDirFromTranscript(opts: {
  projectsRoot: string;
  /**
   * Optional freshness guard. Claude Code updates the active transcript while
   * the session is being used; stale transcripts from previous days must not
   * become a global project-dir signal for other hosts that merely have
   * ~/.claude on disk.
   */
  maxAgeMs?: number;
  /** Test seam for maxAgeMs. Defaults to Date.now(). */
  nowMs?: number;
}): string | undefined {
  if (!fs.existsSync(opts.projectsRoot)) return undefined;

  let bestPath: string | undefined;
  let bestMtime = 0;
  try {
    for (const dir of fs.readdirSync(opts.projectsRoot)) {
      const dirPath = path.join(opts.projectsRoot, dir);
      let stat;
      try { stat = fs.statSync(dirPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let files;
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dirPath, f);
        try {
          const m = fs.statSync(fp).mtimeMs;
          if (m > bestMtime) { bestMtime = m; bestPath = fp; }
        } catch { /* skip */ }
      }
    }
  } catch { return undefined; }

  if (!bestPath) return undefined;
  if (typeof opts.maxAgeMs === "number") {
    const nowMs = opts.nowMs ?? Date.now();
    if (nowMs - bestMtime > opts.maxAgeMs) return undefined;
  }

  // Read first ~10 lines until we find a cwd field. The jsonl is
  // append-only and can be huge (60+ MB on long sessions) — never load it
  // into memory; stream a small head buffer.
  try {
    const fd = fs.openSync(bestPath, "r");
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytes).toString("utf-8");
      for (const line of text.split("\n").slice(0, 10)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { cwd?: unknown };
          if (typeof obj.cwd === "string" && obj.cwd.length > 0) return obj.cwd;
        } catch { /* skip malformed line */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* file vanished mid-read */ }

  return undefined;
}

/**
 * A session log's mtime says which Codex window is *busiest*, never which one
 * spawned us — so it only prefilters the scan. Any log last written before we
 * booted (minus slack for clock skew) cannot belong to our session.
 */
const SESSION_MTIME_SLACK_MS = 60_000;
/**
 * Codex opens the session and spawns its stdio MCP servers together — measured
 * 245 ms apart under Codex Desktop, 808 ms via the codex-companion. Only claim a
 * session as ours when the timing is that tight; a wider net just lets a
 * neighbour that happened to open around the same time slip in. Outside the
 * window (a resumed session whose logged start is hours old, a mid-session
 * respawn) we cannot tell our session from a stranger's, so we fall through to
 * the historical newest-by-mtime pick rather than invent a confident wrong
 * answer — never worse than the behaviour this replaces.
 */
const SESSION_START_MATCH_WINDOW_MS = 5_000;
/**
 * ...but only LOCK a match into the process-lifetime cache when it is this tight
 * — near-certainly our own session, not a neighbour that opened a few seconds
 * after us while our own rollout had not yet been flushed to disk. A match in
 * the `(CACHE_MAX, MATCH_WINDOW]` band is returned for that one call but
 * re-derived on the next, so once our own log lands it supersedes the transient
 * guess instead of being frozen for the life of the process.
 */
const SESSION_START_CACHE_MAX_MS = 2_000;

/**
 * The Codex session that spawned this MCP server cannot change while the process
 * lives, so a match we are confident is ours is safe to cache for the process
 * lifetime — the walk of `~/.codex/sessions` then happens once rather than on
 * every tool call, which is also what lets us inspect *every* concurrently-active
 * log instead of capping the candidate list (the list is mtime-ordered and our
 * own session is frequently the quietest on the box, so any "top N" cut can drop
 * precisely the log we want).
 *
 * "Confident" is the catch: only a match within `SESSION_START_CACHE_MAX_MS` is
 * cached. A looser match, and the newest-by-mtime fallback, are guesses — the
 * usual reason we reach for them is that our own rollout is not on disk yet
 * (Codex writes it a few seconds after it spawns us), so a neighbour that opened
 * right after us can momentarily look best. Caching that would freeze a
 * stranger's cwd for the whole process; leaving it uncached lets our own log
 * supersede it on the very next call.
 */
const confirmedSessionCwd = new Map<string, string>();

type CodexSessionHead = {
  cwd: string;
  /** The session's own start time, when the log records one. */
  startedAtMs: number | null;
};

/**
 * Pull `cwd` — and the session's start timestamp, when present — out of a Codex
 * session log's metadata line. Handles both the CLI shape (`meta.*`) and the
 * Codex Desktop rollout shape (`type: "session_meta"` → `payload.*`).
 *
 * Reads a bounded head chunk: Codex Desktop's first session_meta line can be
 * large (it carries dynamic tool + instruction fields), but the full transcript
 * runs to tens of MB, so it must never be loaded whole.
 */
function readCodexSessionHead(file: string): CodexSessionHead | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(1024 * 1024);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytes).toString("utf-8");
      for (const line of text.split("\n").slice(0, 10)) {
        if (!line.trim()) continue;
        let obj: {
          type?: unknown;
          meta?: { cwd?: unknown; timestamp?: unknown };
          payload?: { cwd?: unknown; timestamp?: unknown };
        };
        try {
          obj = JSON.parse(line);
        } catch {
          return null; // malformed session metadata line
        }
        const rec = obj?.meta ??
          (obj?.type === "session_meta" ? obj?.payload : undefined);
        const cwd = rec?.cwd;
        if (typeof cwd !== "string" || cwd.length === 0) continue;
        if (isPluginInstallPath(cwd)) return null;
        const startedAt = typeof rec?.timestamp === "string"
          ? Date.parse(rec.timestamp)
          : Number.NaN;
        return {
          cwd,
          startedAtMs: Number.isFinite(startedAt) ? startedAt : null,
        };
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* file vanished mid-read */ }
  return null;
}

/**
 * Issue #45 / c4529042182 — recover the project-cwd from a Codex session log,
 * because the spawned MCP child never inherits a usable one. Under the Codex
 * plugin, `.codex-plugin/mcp.json` pins `"cwd": "."`, which Codex re-bases onto
 * the *plugin install dir*; under a hand-rolled `[mcp_servers.*]` entry the
 * child inherits whatever cwd Codex itself was launched from.
 *
 * Codex writes its session transcripts to either
 * `${CODEX_HOME ?? ~/.codex}/sessions/<uuid>.jsonl` (CLI) or a dated desktop
 * layout such as
 * `${CODEX_HOME ?? ~/.codex}/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 * The cwd appears on `meta.cwd` for the CLI shape and on `payload.cwd` in
 * `type: "session_meta"` records for Codex Desktop. Codex publishes NO
 * workspace env var to its MCP children and advertises no MCP `roots`
 * capability (measured on 0.144.2: the `initialize` frame carries only
 * `elicitation`), so — unlike Claude Code — there is no protocol signal at all.
 * The session log is the strongest one available.
 *
 * WHICH session log is the whole problem. "Newest by mtime" is not an identity
 * signal, it is a busyness signal: any other Codex window that happens to be
 * streaming a reply right now has a fresher mtime than ours, so a Codex Desktop
 * window sitting on project B silently re-roots a Codex CLI / companion run on
 * project A — and every file tool in project A is then blocked as "outside the
 * project root".
 *
 * Codex spawns its stdio MCP servers as it opens the session, so the session
 * that spawned US is the one whose START timestamp sits next to our own process
 * start. Measured: 245 ms apart under Codex Desktop, 808 ms via the Claude Code
 * codex-companion — against 519 s for the foreign window that was winning on
 * mtime. Match on that; fall back to newest-by-mtime when nothing started
 * alongside us (see `SESSION_START_MATCH_WINDOW_MS`) — an older Codex whose logs
 * carry no timestamp, or our own rollout not flushed yet, since Codex creates it
 * a few seconds after the MCP server boots.
 *
 * Returns `null` when:
 *   • `codexHome` or its `sessions/` subdir does not exist.
 *   • No `.jsonl` files exist or none has a parseable cwd string.
 *   • The newest log is older than `transcriptMaxAgeMs` (multi-window guard).
 *   • The resolved cwd points at a plugin install path (poisoned).
 */
export function resolveCodexSessionCwd(opts?: {
  /** Defaults to `process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")`. */
  codexHome?: string;
  /**
   * Optional freshness guard — Codex appends to the active log while the
   * session is running, so a stale log from days ago must not become a
   * global project-dir signal.
   */
  transcriptMaxAgeMs?: number;
  /** Test seam for transcriptMaxAgeMs. Defaults to Date.now(). */
  now?: number;
  /**
   * When this MCP process booted, in ms since the epoch. Codex spawns the
   * server as it opens the session, so this dates OUR session. Test seam;
   * defaults to `performance.timeOrigin`.
   */
  processStartMs?: number;
}): string | null {
  const codexHome =
    opts?.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const processStartMs = opts?.processStartMs ?? performance.timeOrigin;

  // Already identified our session on an earlier tool call — it cannot have
  // changed since, and re-deriving it would re-walk the whole sessions tree.
  // Number first: `processStartMs` cannot contain a colon, so the split point is
  // unambiguous and no separator byte can collide with a path.
  const memoKey = `${processStartMs}:${codexHome}`;
  const confirmed = confirmedSessionCwd.get(memoKey);
  if (confirmed) return confirmed;

  const sessionsDir = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  const MAX_SCAN_DEPTH = 4; // sessions/YYYY/MM/DD/<file>.jsonl plus one spare.
  const MAX_SCAN_ENTRIES = 10_000;
  let visitedEntries = 0;
  const logs: { path: string; mtimeMs: number }[] = [];
  const visit = (dir: string, depth: number) => {
    if (visitedEntries >= MAX_SCAN_ENTRIES) return;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    entries.sort().reverse();
    for (const entry of entries) {
      if (visitedEntries >= MAX_SCAN_ENTRIES) return;
      visitedEntries++;
      const fp = path.join(dir, entry);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) visit(fp, depth + 1);
        continue;
      }
      if (!stat.isFile() || !entry.endsWith(".jsonl")) continue;
      logs.push({ path: fp, mtimeMs: stat.mtimeMs });
    }
  };
  try {
    visit(sessionsDir, 0);
  } catch { return null; }

  if (!logs.length) return null;
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (typeof opts?.transcriptMaxAgeMs === "number") {
    const nowMs = opts.now ?? Date.now();
    if (nowMs - logs[0].mtimeMs > opts.transcriptMaxAgeMs) return null;
  }

  // Ours is the session that started when we did — not the one that is loudest.
  // Every log touched since we booted is a candidate; none may be skipped (see
  // `confirmedSessionCwd` on why capping this list is unsafe).
  let best: { cwd: string; deltaMs: number } | undefined;
  for (const log of logs) {
    if (log.mtimeMs < processStartMs - SESSION_MTIME_SLACK_MS) break; // mtime-desc
    const head = readCodexSessionHead(log.path);
    if (!head || head.startedAtMs === null) continue;
    const deltaMs = Math.abs(head.startedAtMs - processStartMs);
    if (deltaMs > SESSION_START_MATCH_WINDOW_MS) continue;
    if (!best || deltaMs < best.deltaMs) best = { cwd: head.cwd, deltaMs };
  }
  if (best) {
    // Only a tight match is our own beyond doubt; a looser one may be a
    // neighbour that opened while our rollout was still unflushed, so return it
    // for this call but let the next call re-derive (see `confirmedSessionCwd`).
    if (best.deltaMs <= SESSION_START_CACHE_MAX_MS) {
      confirmedSessionCwd.set(memoKey, best.cwd);
    }
    return best.cwd;
  }

  return readCodexSessionHead(logs[0].path)?.cwd ?? null;
}

/**
 * Pure project-dir resolver. Mirror of the env-var chain inside
 * `src/server.ts getProjectDir()`, but takes its inputs explicitly so the
 * resolver can be exercised under test without process-level mutation.
 *
 * Resolution order:
 *   1. Adapter-priority env vars (CLAUDE / GEMINI / VSCODE / IDEA /
 *      CONTEXT_MODE) — first non-empty AND non-plugin-path wins.
 *   2. Claude Code transcript heuristic — read `cwd` from the most-recently-
 *      modified `~/.claude/projects/<encoded>/<session>.jsonl`. This is the
 *      most reliable signal when Claude Code launched MCP from a non-project
 *      cwd (desktop-app launch, `/ctx-upgrade` respawn, etc.).
 *   3. `process.env.PWD` — shell-set, NOT updated by `process.chdir()`, so
 *      it survives the `start.mjs` chdir into the plugin dir. Skipped if
 *      it too points at a plugin install path.
 *   4. `cwd` — last resort. Returned even if it is a plugin path; the
 *      caller is responsible for rendering a graceful "no project context"
 *      message rather than panicking. Keeping the function total preserves
 *      operation of project-independent tools (sandbox execute, fetch).
 */
export function resolveProjectDir(opts: {
  env: Record<string, string | undefined>;
  cwd: string;
  pwd: string | undefined;
  /** Optional override; production code passes `~/.claude/projects`. */
  transcriptsRoot?: string;
  /** Optional freshness guard for Claude Code transcript project recovery. */
  transcriptMaxAgeMs?: number;
  /** Test seam for transcriptMaxAgeMs. Defaults to Date.now(). */
  nowMs?: number;
  /**
   * Issue #545 — opt-in tightening. When set, the candidate list is built
   * algorithmically from `workspaceEnvVarsFor(strictPlatform)` plus the
   * universal escape hatch. Foreign workspace vars (e.g. CLAUDE_PROJECT_DIR
   * leaked into another host's MCP child env) cannot win, regardless of
   * cascade order.
   *
   * When `undefined`, the legacy literal candidate order is used (semver lock
   * for `start.mjs` and any non-strict consumer).
   */
  strictPlatform?: PlatformId;
  /**
   * Issue #45 — override `${CODEX_HOME ?? ~/.codex}` for tests. When
   * `strictPlatform === "codex"` and the env cascade yields nothing, the
   * resolver reads `meta.cwd` from the newest session.jsonl under
   * `${codexHome}/sessions/`.
   */
  codexHome?: string;
}): string {
  const {
    env, cwd, pwd, transcriptsRoot, transcriptMaxAgeMs, nowMs, strictPlatform, codexHome,
  } = opts;
  // Build candidate list. Strict path: own workspace vars + universal escape
  // hatch — NO foreign workspace vars, in any order, can win. Non-strict
  // path: frozen legacy literal order for backwards compatibility.
  const candidateVars: readonly string[] = strictPlatform
    ? [...workspaceEnvVarsFor(strictPlatform), ...UNIVERSAL_WORKSPACE_ENV]
    : LEGACY_NON_STRICT_CANDIDATES;
  for (const name of candidateVars) {
    const v = env[name];
    if (v && !isPluginInstallPath(v)) return v;
  }
  if (transcriptsRoot) {
    const fromTranscript = resolveProjectDirFromTranscript({
      projectsRoot: transcriptsRoot,
      maxAgeMs: transcriptMaxAgeMs,
      nowMs,
    });
    if (fromTranscript && !isPluginInstallPath(fromTranscript)) return fromTranscript;
  }
  // Issue #45 — Codex has no workspace env var, so when running under
  // strictPlatform="codex" we fall back to the session-log heuristic
  // between env and PWD. Non-codex platforms skip this branch entirely.
  if (strictPlatform === "codex") {
    const fromCodex = resolveCodexSessionCwd({
      codexHome,
      transcriptMaxAgeMs,
      now: nowMs,
    });
    if (fromCodex) return fromCodex;
  }
  if (pwd && !isPluginInstallPath(pwd)) return pwd;
  return cwd;
}
