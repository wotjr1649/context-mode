/**
 * adapters/codex/hooks — Codex CLI hook definitions.
 *
 * Codex CLI hooks run behind the current `hooks` feature flag surface.
 * Prefer `[features].hooks`; the legacy `[features].codex_hooks` alias is still
 * accepted in current Codex builds.
 * 5 registered hook events: PreToolUse, PostToolUse, PreCompact, SessionStart,
 * Stop. UserPromptSubmit is dispatch-capable (see HOOK_TYPES) but is NOT
 * registered by default — Codex honors the AGENTS.md "no raw prompt capture"
 * contract (ADR-0005). PreCompact is runtime-gated on Codex builds that emit
 * the event.
 * Same JSON stdin/stdout wire protocol as Claude Code.
 *
 * Config: $CODEX_HOME/hooks.json or ~/.codex/hooks.json.
 * MCP: full support via [mcp_servers] in $CODEX_HOME/config.toml.
 *
 * Known limitations:
 *   - PreToolUse: deny works on all builds. permissionDecision:"allow" +
 *     updatedInput (command rewrite) and additionalContext are honored on
 *     codex-cli >= 0.141.0 (#845), detected at runtime by
 *     hooks/core/codex-caps.mjs; older builds fail closed (redirect → deny).
 *     `ask` remains unsupported.
 *   - PostToolUse: updatedMCPToolOutput parsed but logged as unsupported
 *   - PostToolUse does not fire on failing Bash calls (upstream bug)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Codex CLI hook types — mirrors Claude Code's continuity events. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

// ─────────────────────────────────────────────────────────
// External MCP routing matcher (#529)
// ─────────────────────────────────────────────────────────

/**
 * External MCP catch-all matcher for Codex CLI (#529, #547 hotfix, matcher-semantics fix).
 *
 * Codex CLI's hook `tool_name` uses `mcp__<server>__<tool>` for any MCP tool. To
 * match that family the matcher MUST be a regex: `mcp__.*`. A charset-clean bare
 * `mcp__` is short-circuited by Codex's `is_exact_matcher`
 * (refs/platforms/codex/codex-rs/hooks/src/events/common.rs) into an EXACT match
 * — it matches a tool literally named "mcp__" and catches ZERO MCP tools.
 * `.*` is NOT look-around, so the Rust `regex` crate accepts it at boot (the #547
 * breaker was look-around). Runtime-verified on codex-cli 0.144.4: `mcp__.*`
 * compiled + loaded clean; a look-around control `mcp__(?!ctx).*` was rejected.
 *
 * Registered as its OWN PreToolUse entry (index.ts generateHookConfig) so the
 * charset-clean exact-name list stays on the is_exact_matcher fast path.
 * ctxscribe's own MCP tools are separated in the hook BODY by `isExternalMcpTool()`
 * (hooks/core/routing.mjs).
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "mcp__.*";

// ─────────────────────────────────────────────────────────
// Routing instructions
// ─────────────────────────────────────────────────────────

/**
 * Path to the routing instructions file for Codex CLI.
 * Used as fallback routing awareness alongside hook-based enforcement.
 */
export const ROUTING_INSTRUCTIONS_PATH = "configs/codex/AGENTS.md";
