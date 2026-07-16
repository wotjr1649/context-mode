# ADR-0006 — Always-load ctx_execute and ctx_search; defer the other nine

- **Status**: Accepted
- **Date**: 2026-07-16
- **Release**: v1.0.7 (unreleased)
- **Scope**: `src/server.ts` — `installStrictClientSchemaCompat`, `ctx_execute`, `ctx_search`

## Context

MCP hosts defer tools once the combined tool surface outgrows their budget.
Claude Code loads them upfront only if they fit within ~10% of the context
window; otherwise a `ToolSearch` call must surface the schema before the model
can call anything at all. ctx_* is never the tool that blows that budget — all
eleven together are 6,790 tok, 34% of a 20K allowance — but it shares the fate
of every other MCP server installed alongside it.

The cost of that shared fate was measured, not assumed. Parsing 2,038 local
transcripts (940 MB, 236K lines, 2026-05-15 → 2026-07-16):

| signal | value |
| --- | --- |
| sessions where ctx_* was never loaded | 1,052 / 1,791 (58.7%) |
| sessions that loaded it and then used it | 739 / 773 (95.6%) |
| ctx_* share of all tool calls | 287 / 48,742 (0.59%) |
| `Read` share of bytes entering context | 78.65 MB / 159.1 MB (49%) |

Discovery was the bottleneck, not usefulness: once a schema was in front of
the model it got used almost every time.

The upside is bounded, and the bound is what makes this decision non-obvious.
Of the 1,052 sessions that never loaded ctx_*, **709 (67.4%) had no large
exploratory `Read` at all** — nothing for a sandbox to save. The real miss is
343 sessions (19.2% of all sessions) carrying 16.3 MB of large read-and-discard
at ~12K tok each: a **4,116K tok ceiling**.

Against that ceiling, always-load is not free. It bills *every* session while
the benefit lands in 19.2% of them:

| what is opened | session floor | 1,791-session cost | verdict |
| --- | --- | --- | --- |
| all eleven | 6,790 tok | 12,161K | ~3x net **loss** |
| ctx_execute alone | 1,226 tok | 2,196K | 1.9x gain |
| ctx_execute + ctx_search, trimmed | 1,488 tok | 2,665K | 1.5x gain |

## Decision

Declare `_meta: { "anthropic/alwaysLoad": true }` on **`ctx_execute`** and
**`ctx_search`** only, and pay for the two slots by trimming both tools.

`ctx_execute` earns its slot as the general entry point: 2,872 calls, the
lowest error rate in the family (2.5%, against 7.6% for `ctx_execute_file` and
15.6% for `ctx_fetch_and_index`), and it subsumes most siblings —
`ctx_execute_file` is `readFileSync`, `ctx_batch_execute`'s parallelism is
`Promise.all`, and its auto-indexing is already the `intent` parameter.

`ctx_search` earns its slot for the opposite reason: nothing stands in for it.
It is the only route into the 26 categories of hook-captured session memory,
and its ranking pipeline (Porter + trigram → RRF → proximity rerank →
Levenshtein retry) is not something a sandbox script reproduces.

The other nine stay deferred deliberately: opening them costs more every
session than the deferral costs in missed use.

Injection reuses the existing `tools/list` wrapper
(`installStrictClientSchemaCompat`) rather than adding a second one — that
handler already post-processes the tool list for strict-client schema
sanitisation, and `_meta` is one more field on the same objects.

Trimming, measured against the real `tools/list` response:

```
ctx_execute    1,226 -> 731 tok  (-40%)
ctx_search     1,096 -> 757 tok  (-31%)
session floor  2,322 -> 1,488 tok  = 0.74% of a 200K window
```

Both trimmed descriptions now close by naming their deferred siblings, so the
two always-loaded tools serve as the index for the other nine. This is not
decoration: **`ctx_index` had 0 calls in 62 days** despite being irreplaceable
(recursive directory indexing, content-hash staleness flagging). It was never
unwanted — only unmentioned.

Separately, `ctx_execute`'s `language` enum now derives from `available`, the
same detected-runtime list the description already interpolated into
`Languages: ...`. The static 12-language enum advertised runtimes that were not
installed and the model took the offer; "No Python runtime available" and "C#
not available" were recurring dead ends. An enum that mirrors detection cannot
make an offer the executor will refuse.

## Consequences

- Every session pays a 1,488 tok floor (0.74% of a 200K window) whether or not
  it touches ctx_*. Accepted against the 4,116K ceiling: ~1.5x net. The margin
  is real but thin — a future trim that reopens it should re-measure rather
  than assume.
- The nine deferred tools are unchanged and still reachable via `ToolSearch`,
  exactly as before. **Deferral is lazy loading, not removal.**
- `ctx_purge` staying deferred doubles as a safety property: a destructive tool
  is better hard to reach.
- The enum narrows per host, and per server start. A runtime installed after
  the server boots is not offered until restart — where the previous behaviour
  offered it always and failed at execution instead. Failing at the schema is
  the cheaper failure.
- ADR-0002's `RETURNS:` block style and #697's throttle wording are contracts
  with tests behind them. The first trim broke both and the tests caught it;
  any future trim must keep them.

## Alternatives considered

- **Open all eleven.** Maximises discovery, costs 12,161K against a 4,116K
  ceiling. Rejected on arithmetic: the savings tool would eat the savings.
- **`ENABLE_TOOL_SEARCH=false` in user settings.** One line, but it un-defers
  every MCP server on the host — ctxscribe would be paid for by also loading
  context7, chrome, and codex tools. Rejected: it fixes our discovery by
  worsening the very budget that caused it, and it is a per-user setting a
  plugin cannot ship anyway.
- **Have the PreToolUse hook deny large exploratory `Read`s** instead of
  nudging. The hook cannot know whether a `Read` precedes an `Edit`, and 176 of
  875 large reads (20%) do. Rejected: a guaranteed 20% false-positive rate on
  a path that breaks the edit workflow.

## Measurement note

The figures above come from transcript `tool_result` byte counts — what
actually entered the model's context window — not from `ctx_stats`.
`ctx_stats` credits `bytesAvoided` for `Read` calls that the hook nudges but
does **not** block (`hooks/core/routing.mjs:826`), charging the full file size
even for partial reads and re-reads, so its "kept out" figure counts bytes that
did enter the window. That is a separate defect, tracked separately; it is not
the basis of this decision and its numbers were not used here.
