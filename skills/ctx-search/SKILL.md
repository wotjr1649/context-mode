---
name: ctx-search
description: |
  Search ctxscribe's persistent FTS5 knowledge base for previously indexed
  local project content, documentation, or session memory.
  Trigger: /ctxscribe:ctx-search
user-invocable: true
---

# ctxscribe Search

Search indexed content without rereading raw sources into conversation context.

## Instructions

1. Prefer the `ctx_search` MCP tool when it is available.
2. Batch all related questions in one `queries` array.
3. Scope with `source` when the user names a project or indexed label.
4. Use short, specific queries of two to four technical terms.

```javascript
ctx_search({
  source: "project:<name>",
  queries: ["authentication middleware", "token refresh"],
  limit: 5
})
```

5. If MCP tools are unavailable, fall back to the CLI:

```bash
ctxscribe search "authentication middleware" --source project:<name> --limit 5
```

6. If the index is empty, tell the user to run `/ctxscribe:ctx-index` or `ctxscribe index <path>` first.
