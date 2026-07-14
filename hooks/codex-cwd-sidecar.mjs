/**
 * Codex workspace cwd sidecar — the reliable, low-race channel for handing the
 * MCP server the current session's workspace.
 *
 * WHY: Codex gives an MCP child no workspace/session signal (env_clear +
 * allowlist, no roots, no session id — verified against Codex 0.144.4; see
 * docs/superpowers/specs/2026-07-14-codex-cwd-sidecar-design.md). But Codex
 * HOOKS receive the workspace on stdin (input.cwd), and PreToolUse fires —
 * blocking — immediately before each MCP tool call. So each ctxscribe Codex
 * hook records {cwd, sessionId, ppid, ts} here; the MCP server's
 * src/util/project-dir.ts::resolveCodexSessionCwd reads it (ppid-exact →
 * freshest-by-mtime) instead of racing the ~9s-late rollout log.
 *
 * KEEP `SIDECAR_DIR` in sync with CODEX_CWD_SIDECAR_DIR in
 * src/util/project-dir.ts. Dep-free (node:fs/path/os only) so it stays
 * unit-testable without the session-db bundle and safe to import from any hook.
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SIDECAR_DIR = "ctxscribe-cwd";

function resolveCodexHome(codexHome) {
  if (codexHome) return codexHome;
  const env = process.env.CODEX_HOME;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".codex");
}

// Defensive: a hook runs with cwd = workspace, so this practically never fires,
// but we must never advertise the plugin dir itself as a workspace. Uses no
// backslash string literal (String.fromCharCode(92)) so the source cannot fall
// into the \uXXXX / backslash-escaping trap. The MCP-side reader filters plugin
// paths too — this just keeps junk out of the sidecar dir.
function looksLikePluginPath(p) {
  const norm = String(p).split(String.fromCharCode(92)).join("/").toLowerCase();
  return norm.includes("/.claude/plugins/") || norm.includes("/.codex/plugins/");
}

/**
 * Record the current session's workspace so the MCP server can find it. Keyed by
 * sessionId (one file per session) so a concurrent window in another project
 * cannot clobber ours. Atomic (write-tmp-rename) — a torn read must never yield
 * half a path. Best-effort: a hook must never fail on telemetry.
 */
export function writeCodexCwdSidecar({ codexHome, sessionId, cwd, ppid } = {}) {
  try {
    if (typeof cwd !== "string" || cwd.length === 0) return;
    if (looksLikePluginPath(cwd)) return;
    const pid = typeof ppid === "number" ? ppid : process.ppid;
    const dir = join(resolveCodexHome(codexHome), SIDECAR_DIR);
    mkdirSync(dir, { recursive: true });
    const rawId = sessionId ? String(sessionId) : `ppid-${pid}`;
    const safeId = rawId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || `ppid-${pid}`;
    const file = join(dir, `${safeId}.json`);
    const body = JSON.stringify({ cwd, sessionId: sessionId ?? null, ppid: pid, ts: Date.now() });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, file); // atomic — a torn read must never yield a half cwd
  } catch { /* best effort — a hook must never fail on telemetry */ }
}

/**
 * Delete sidecars older than maxAgeMs (default 7 days). Called from SessionStart
 * so a long-lived machine never accumulates dead-session records. Best-effort.
 */
export function pruneCodexCwdSidecars({ codexHome, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now } = {}) {
  try {
    const dir = join(resolveCodexHome(codexHome), SIDECAR_DIR);
    const nowMs = typeof now === "number" ? now : Date.now();
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const fp = join(dir, entry);
      try {
        if (nowMs - statSync(fp).mtimeMs > maxAgeMs) unlinkSync(fp);
      } catch { /* skip */ }
    }
  } catch { /* dir absent — nothing to prune */ }
}
