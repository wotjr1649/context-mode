---
name: ctx-stats
description: |
  Show how much context window ctxscribe saved this session.
  Displays token consumption, context savings ratio, and per-tool breakdown.
  Read-only — shows stats only, no reset capability.
  To wipe the knowledge base entirely, use ctx_purge instead.
  Trigger: /ctxscribe:ctx-stats
user-invocable: true
---

# ctxscribe Stats

Show context savings for the current session.

## Instructions

1. Call the `mcp__plugin_ctxscribe_mcp__ctx_stats` MCP tool (no parameters needed).
2. **CRITICAL**: You MUST copy-paste the ENTIRE tool output as markdown text directly into your response message. Do NOT summarize, do NOT collapse, do NOT paraphrase. The user must see the full tables without pressing ctrl+o. Copy every line exactly as returned by the tool.
3. After the full output, add ONE sentence highlighting the key savings metric, e.g.:
   - "ctxscribe saved **12.4x** — 92% of data stayed in sandbox."
   - If no data yet: "No ctxscribe calls yet this session."

## Purge

- **`ctx_purge(confirm: true)`** — Permanently deletes all indexed content from the knowledge base. Use `/ctxscribe:ctx-purge` for this.
