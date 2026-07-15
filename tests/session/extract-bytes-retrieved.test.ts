/**
 * Retrieval-byte capture — the OTHER half of the ctxscribe with/without ratio.
 *
 * `bytes_retrieved` (the bytes the model PAID to access kept-out content from
 * ctx_search / ctx_fetch_and_index) is recorded SERVER-SIDE (src/server.ts ->
 * appendRetrievalBytes -> retrieval marker, forwarded once by posttooluse.mjs)
 * from the exact MCP response — the single source of truth.
 *
 * The PostToolUse hook's extractMcpToolCall does NOT also set bytes_retrieved:
 * since the v1.0.4 `mcp__.*` matcher fix the hook DOES now fire for the plugin's
 * OWN MCP tools, so counting bytes here too would DOUBLE-COUNT every retrieval.
 * These tests pin that invariant — the hook emits the mcp_tool_call event but
 * leaves bytes_retrieved unset for every tool.
 */

import { describe, test, expect } from "vitest";
import { extractEvents } from "../../src/session/extract.js";

function mcpEventsOf(toolName: string, toolResponse: string) {
  return extractEvents({
    tool_name: toolName,
    tool_input: { queries: ["q"] },
    tool_response: toolResponse,
  }).filter((e) => e.type === "mcp_tool_call");
}

describe("extractMcpToolCall — bytes_retrieved is server-owned, never set here (no double-count)", () => {
  test("ctx_search emits an mcp_tool_call event WITHOUT bytes_retrieved", () => {
    const events = mcpEventsOf(
      "mcp__plugin_ctxscribe_mcp__ctx_search",
      "matched section A\nmatched section B — retrieved content",
    );
    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBeUndefined();
  });

  test("ctx_fetch_and_index emits an mcp_tool_call event WITHOUT bytes_retrieved", () => {
    const events = mcpEventsOf(
      "mcp__plugin_ctxscribe_mcp__ctx_fetch_and_index",
      "Fetched and indexed 4 sections (12.5KB)",
    );
    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBeUndefined();
  });

  test("a suffix-matching retrieval name (any host prefix) still carries no bytes_retrieved", () => {
    const events = mcpEventsOf("mcp__other_host__ctx_search", "retrieved payload");
    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBeUndefined();
  });

  test("sandbox compute (ctx_execute / ctx_batch_execute) carries no bytes_retrieved", () => {
    for (const name of [
      "mcp__plugin_ctxscribe_mcp__ctx_execute",
      "mcp__plugin_ctxscribe_mcp__ctx_batch_execute",
    ]) {
      const events = mcpEventsOf(name, "stdout: 47 files analyzed");
      expect(events.length, name).toBe(1);
      expect(events[0].bytes_retrieved, name).toBeUndefined();
    }
  });

  test("external MCP tool emits an mcp_tool_call event WITHOUT bytes_retrieved", () => {
    const events = mcpEventsOf("mcp__slack__list_channels", '{"channels":["#general"]}');
    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBeUndefined();
  });
});
