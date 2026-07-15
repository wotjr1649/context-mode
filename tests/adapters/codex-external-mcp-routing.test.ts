/**
 * External MCP routing — Codex slice (#529 follow-up).
 *
 * PR #532 added the plugin-prefixed negative-lookahead PreToolUse matcher for
 * Claude Code so external MCP servers (slack, telegram, gdrive, notion …)
 * trigger the context-guidance nudge before their large payloads spill into
 * context. This slice extends the same protection to Codex CLI.
 *
 * Codex MCP wire shape: `mcp__<server>__<tool>` (verified in
 * configs/codex/hooks.json line 5 which already matches `mcp__.*__ctx_execute`
 * style — proving hook tool_name carries the `mcp__` prefix for MCP-namespaced
 * tools). Codex own ctxscribe tools surface as bare `ctx_execute` AND as
 * `mcp__<server>__ctx_execute` (the existing PRE_TOOL_USE_MATCHER_PATTERN
 * already wires both). The matcher below is a bare `mcp__` catch-all; our own
 * tools are carved out in the hook BODY by `isExternalMcpTool()`, which keys
 * off the `ctx_` tool-leaf rather than the server segment.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { EXTERNAL_MCP_MATCHER_PATTERN } from "../../src/adapters/codex/hooks.js";

describe("CodexAdapter — external MCP routing (#529)", () => {
  let adapter: CodexAdapter;
  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  it("exports EXTERNAL_MCP_MATCHER_PATTERN constant", () => {
    expect(typeof EXTERNAL_MCP_MATCHER_PATTERN).toBe("string");
    expect(EXTERNAL_MCP_MATCHER_PATTERN.length).toBeGreaterThan(0);
  });

  it("EXTERNAL_MCP_MATCHER_PATTERN is the `mcp__.*` regex (no look-around; Codex-boot-safe)", () => {
    // A charset-clean bare `mcp__` is an is_exact_matcher no-op on Codex — it
    // matches only a tool literally named "mcp__". Matching the MCP family needs
    // the regex `mcp__.*` (Codex hooks docs). `.*` has no look-around, so Codex's
    // Rust regex crate accepts it at boot (the #547 breaker was look-around).
    // Own tools are separated in the hook BODY by isExternalMcpTool().
    expect(EXTERNAL_MCP_MATCHER_PATTERN).toBe("mcp__.*");
    expect(EXTERNAL_MCP_MATCHER_PATTERN).not.toMatch(/\(\?[=!<]/); // no look-around

    // Regex semantics — matches every external MCP tool name Codex emits
    // (`mcp__<server>__<tool>`) but not bare non-MCP tool names.
    const re = new RegExp(EXTERNAL_MCP_MATCHER_PATTERN);
    expect(re.test("mcp__slack__list_channels")).toBe(true);
    expect(re.test("mcp__plugin_telegram__list_messages")).toBe(true);
    expect(re.test("local_shell")).toBe(false);
    expect(re.test("Bash")).toBe(false);
  });

  it("generateHookConfig registers the external MCP `mcp__.*` regex as its OWN entry", () => {
    const config = adapter.generateHookConfig("/some/plugin/root") as Record<
      string,
      Array<{ matcher: string }>
    >;
    const matchers = (config.PreToolUse ?? []).map((e) => e.matcher);
    expect(matchers).toContain(EXTERNAL_MCP_MATCHER_PATTERN); // === "mcp__.*"
    // A SEPARATE entry, not folded into the charset-clean exact-name list.
    expect(matchers[0]).not.toContain(EXTERNAL_MCP_MATCHER_PATTERN);
  });

  it("both Codex hook manifests register the `mcp__.*` entry with NO look-around (#547)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const files = [
      ["configs", "codex", "hooks.json"],
      [".codex-plugin", "hooks.json"],
    ];
    for (const rel of files) {
      const path = resolve(__dirname, "..", "..", ...rel);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        hooks: { PreToolUse: Array<{ matcher: string }> };
      };
      const matchers = parsed.hooks.PreToolUse.map((e) => e.matcher);
      expect(matchers, path).toContain(EXTERNAL_MCP_MATCHER_PATTERN); // "mcp__.*" as its own entry
      // #547: Codex's Rust regex rejects look-around at boot — every entry must be free of it.
      for (const m of matchers) expect(m, path).not.toMatch(/\(\?[=!<]/);
    }
  });
});
