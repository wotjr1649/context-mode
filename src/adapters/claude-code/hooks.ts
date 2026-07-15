import { buildHookRuntimeCommand, parseNodeCommand } from "../types.js";

/**
 * adapters/claude-code/hooks — Claude Code hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * Claude Code's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks in settings.json)
 *   - Doctor command (to validate hook configuration)
 *   - hooks.json generation
 *
 * Claude Code hook system reference:
 *   - Hooks are registered in ~/.claude/settings.json under "hooks" key
 *   - Each hook type maps to an array of { matcher, hooks } entries
 *   - matcher: tool name pattern (empty = match all tools)
 *   - hooks: array of { type: "command", command: "..." }
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Claude Code hook types. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// PreToolUse matchers
// ─────────────────────────────────────────────────────────

/**
 * MCP catch-all matcher for Claude Code (#529, #547 hotfix, matcher-semantics fix).
 *
 * Matches EVERY MCP tool (`mcp__<server>__<tool>`), ctxscribe's own included
 * (`mcp__plugin_ctxscribe_mcp__*`); the hook BODY (`isExternalMcpTool()` in
 * hooks/core/routing.mjs) then separates own vs. external tools.
 *
 * MUST be a regex (`mcp__.*`), NOT bare `mcp__`. Per the Claude Code hooks docs,
 * a matcher containing only [A-Za-z0-9_,|-] and spaces is an EXACT / `|`-list
 * match — so bare `mcp__` matches a tool literally named "mcp__" and catches
 * NOTHING. Adding `.*` makes it a JavaScript (unanchored) regex that matches all
 * `mcp__*` tool names. `.*` has no look-around, so it is also valid for Codex
 * CLI's Rust `regex` crate — the #547 lookaround that broke Codex is not
 * reintroduced. (Earlier builds shipped bare `mcp__`, which silently matched no
 * external MCP tools on Claude Code; this restores the intended interception.)
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "mcp__.*";

/**
 * Tools that ctxscribe's PreToolUse hook intercepts.
 * ctxscribe's own MCP tools (ctx_execute / _file / _batch_execute) are NOT
 * listed separately — the `mcp__.*` regex (EXTERNAL_MCP_MATCHER_PATTERN) matches
 * every `mcp__*` tool, ours included. routing.mjs distinguishes external vs. own
 * MCP tools in the hook body via isExternalMcpTool(). (Each simple name below is
 * its own exact matcher; `mcp__.*` is its own regex matcher — they are separate
 * hooks.json entries, never joined, so the exact names keep exact semantics.)
 */
export const PRE_TOOL_USE_MATCHERS = [
  "Bash",
  "WebFetch",
  "Read",
  "Grep",
  "Agent",
  EXTERNAL_MCP_MATCHER_PATTERN,
] as const;

/**
 * Combined matcher pattern for settings.json (pipe-separated).
 * Used by the upgrade command when writing a single consolidated entry.
 */
export const PRE_TOOL_USE_MATCHER_PATTERN = PRE_TOOL_USE_MATCHERS.join("|");

// ─────────────────────────────────────────────────────────
// PostToolUse matchers (#229)
// ─────────────────────────────────────────────────────────

/**
 * Tools that ctxscribe's PostToolUse hook should fire on.
 * Only tools that extractEvents() actually handles — all others
 * produce zero events and cause false "hook error" display.
 */
export const POST_TOOL_USE_MATCHERS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
  "Agent",
  "AskUserQuestion",
  "EnterWorktree",
  "mcp__",
] as const;

/**
 * Combined matcher pattern for PostToolUse in hooks.json / settings.json.
 */
export const POST_TOOL_USE_MATCHER_PATTERN = POST_TOOL_USE_MATCHERS.join("|");

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<HookType, string> = {
  PreToolUse: "pretooluse.mjs",
  PostToolUse: "posttooluse.mjs",
  PreCompact: "precompact.mjs",
  SessionStart: "sessionstart.mjs",
  UserPromptSubmit: "userpromptsubmit.mjs",
  Stop: "stop.mjs",
};

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/** Required hooks that must be configured for ctxscribe to function. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
  HOOK_TYPES.SESSION_START,
];

/** Optional hooks that enhance functionality but aren't critical. */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.POST_TOOL_USE,
  HOOK_TYPES.PRE_COMPACT,
  HOOK_TYPES.USER_PROMPT_SUBMIT,
  HOOK_TYPES.STOP,
];

/**
 * Check if a hook entry points to a ctxscribe hook script.
 * Matches both legacy format (node .../pretooluse.mjs) and
 * CLI dispatcher format (ctxscribe hook claude-code pretooluse).
 */
export function isContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  const cliCommand = buildHookCommand(hookType);
  return (
    entry.hooks?.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    ) ?? false
  );
}

/**
 * Build the hook command string for a given hook type.
 * Uses process.execPath + forward slashes to avoid PATH issues and MSYS
 * path mangling on Windows (#369, #372).
 * Falls back to CLI dispatcher if pluginRoot is not provided.
 */
export function buildHookCommand(hookType: HookType, pluginRoot?: string): string {
  if (pluginRoot) {
    const scriptName = HOOK_SCRIPTS[hookType];
    return buildHookRuntimeCommand(`${pluginRoot}/hooks/${scriptName}`);
  }
  return `ctxscribe hook claude-code ${hookType.toLowerCase()}`;
}

/**
 * Extract the hook script file path from a command string.
 *
 * Algo-D2 twin — same shape as `src/util/hook-config.ts::extractHookScriptPath`.
 * Delegates to `parseNodeCommand` for canonical buildNodeCommand-shape;
 * keeps narrow legacy fallbacks for pre-D3 settings.json entries
 * (`node "X.mjs"` and `node X.mjs` with no internal whitespace).
 *
 * Pre-D2 this matched `node\s+"?([^"]+\.mjs)"?` — the unquoted fallback
 * silently grabbed the tail after the last whitespace, producing the
 * #548 doubled-path FAIL on Windows paths with spaces. The new shape
 * refuses ambiguous input; doctor (Algo-D1) falls through to direct
 * `existsSync` instead of trusting the regex.
 */
export function extractHookScriptPath(command: string): string | null {
  const parsed = parseNodeCommand(command);
  if (parsed) {
    return parsed.scriptPath.endsWith(".mjs") ? parsed.scriptPath : null;
  }
  const legacyQuoted = command.match(/^\s*node\s+"([^"]+\.mjs)"\s*$/);
  if (legacyQuoted) return legacyQuoted[1];
  const legacyBare = command.match(/^\s*node\s+(\S+\.mjs)\s*$/);
  if (legacyBare) return legacyBare[1];
  return null;
}

/**
 * Check if a hook entry is a ctxscribe hook (any hook type).
 * Broader than `isContextModeHook` — matches any ctxscribe script name
 * without requiring a specific hookType.
 */
export function isAnyContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
): boolean {
  const scriptNames = Object.values(HOOK_SCRIPTS);
  return (
    entry.hooks?.some((h) =>
      h.command != null &&
      (scriptNames.some((s) => h.command!.includes(s)) ||
        h.command.includes("ctxscribe hook")),
    ) ?? false
  );
}
