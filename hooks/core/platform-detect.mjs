/**
 * Platform detection from process env vars.
 *
 * Each supported platform sets a distinctive env var when invoking
 * hook scripts; we use those to pick the correct tool-namer prefix
 * and routing block. Falls back to "claude-code" when nothing matches
 * so existing CC behavior is preserved.
 *
 * SINGLE SOURCE OF TRUTH: this table mirrors `PLATFORM_ENV_VARS` in
 * `src/adapters/detect.ts:33-77`. Every entry has been verified against
 * the platform's own runtime source code (full audit May 2026, see
 * git blame). DO NOT add platform env vars here that aren't also in
 * detect.ts — the two MUST stay in lock-step or detection will diverge
 * between MCP-server-side and hook-script-side.
 *
 * Order matters — same as detect.ts.
 */

// Mirror of `PLATFORM_ENV_VARS` in src/adapters/detect.ts:33-77.
// Keep in lock-step. If you change one, change the other.
const PLATFORM_ENV_VARS_MIRROR = [
  ["claude-code",        ["CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID"]],
  ["codex",              ["CODEX_THREAD_ID", "CODEX_CI"]],
];

export function detectPlatformFromEnv(env = process.env) {
  for (const [platform, vars] of PLATFORM_ENV_VARS_MIRROR) {
    if (vars.some((v) => env[v])) return platform;
  }
  return "claude-code";
}

// Re-exported for tests so they can assert against the same canonical table.
export { PLATFORM_ENV_VARS_MIRROR };
