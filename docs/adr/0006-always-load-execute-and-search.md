# ADR-0006 — Always-load ctx_execute and ctx_search; defer the other nine

- **Status**: Accepted
- **Date**: 2026-07-16
- **Revised**: 2026-07-16 — post-release verification re-measured every figure in
  the original draft. The decision stands; most of the numbers that justified it
  did not. See [Revision note](#revision-note).
- **Release**: v1.0.7
- **Scope**: `src/server.ts` — `installStrictClientSchemaCompat`, `ctx_execute`, `ctx_search`

## Context

Claude Code defers MCP tools **unconditionally**. Tool search is enabled by
default: every MCP tool's schema is withheld until a `ToolSearch` call surfaces
it. There is no size budget to stay under and no shared fate with other servers —
ctxscribe would be deferred as the only installed server exactly as it is
alongside nine others. (The "fits within 10% of the context window" rule belongs
to the opt-in `ENABLE_TOOL_SEARCH=auto`, not the default.)

So the model cannot call `ctx_execute` until it already knows to ask for it. A
tool whose entire purpose is to be reached for instead of `Read` cannot be
reached for while it is invisible.

The documented escape is `_meta: { "anthropic/alwaysLoad": true }` on the tool's
`tools/list` entry, honored by Claude Code v2.1.121+.

### What the transcripts actually show

Measured from `tool_result` byte counts in `~/.claude/projects/**/*.jsonl` — what
entered the model's context window — not from `ctx_stats` (see
[Measurement note](#measurement-note)).

**The window matters more than anything else here.** ctxscribe replaced the
`context-mode` plugin mid-series: `context-mode`'s last call was
2026-07-13T11:55Z, ctxscribe's first was 2026-07-13T14:46Z. ctxscribe has
existed for **2.9 days**, not 62. Any rate computed over the full 62-day span
divides ctxscribe's usage by ~59 days of calls from before it was installed.

Restricted to the window where ctxscribe was installed and deferred, and
excluding sessions whose cwd is this repository (a session spent working *on*
ctxscribe uses ctx_* for reasons that do not generalise):

| signal | value |
| --- | --- |
| contexts | 69 (2.9 days) |
| ctxscribe share of all tool calls | 88 / 2,305 = **3.82%** |
| `Read` share of bytes entering context | 75.5% |
| contexts with a large read-and-discard and no ctx_* call | 54% |
| those contexts' exploratory `Read` bytes | 2.85 MB = **713K tok ceiling** |
| session floor × 69 contexts | **105K tok** |
| **break-even realization rate** | **15%** |
| gain if the ceiling were fully realized | 6.8x |

"Contexts" counts subagents, which get their own tool list and pay the floor
too; ~85% of all contexts are subagents.

**The benefit is bounded but the bound is generous.** 15% of the addressable
read-and-discard needs to route through the sandbox for always-load to pay for
itself. That is a bet worth taking, and it is still a bet: see
[Consequences](#consequences) on why the realization rate cannot be read off the
baseline.

## Decision

Declare `_meta: { "anthropic/alwaysLoad": true }` on **`ctx_execute`** and
**`ctx_search`** only, and pay for the two slots by trimming both tools.

`ctx_execute` earns its slot as the general entry point. It is the most-used
member of the family in both plugin generations (2,653 calls as `context-mode`,
259 as ctxscribe), carries the family's lowest error rate (2.4% / 2.9% against
`Read`'s 1.3%), and it subsumes most siblings — `ctx_execute_file` is
`readFileSync`, `ctx_batch_execute`'s parallelism is `Promise.all`, and its
auto-indexing is already the `intent` parameter.

`ctx_search` earns its slot for the opposite reason: nothing stands in for it. It
is the only route into the hook-captured session memory, and its ranking pipeline
(Porter + trigram → RRF → proximity rerank → Levenshtein retry) is not something
a sandbox script reproduces.

The other nine stay deferred: they cost floor without moving the ceiling. The
ceiling is made of large read-and-discard, and `ctx_execute` alone addresses it.

Injection reuses the existing `tools/list` wrapper
(`installStrictClientSchemaCompat`) rather than adding a second one — that
handler already post-processes the tool list for strict-client schema
sanitisation, and `_meta` is one more field on the same objects. Sanitisation
only ever sees `inputSchema`, so it cannot strip `_meta`.

Trimming, measured from live `tools/list` responses — before from the last
pre-trim bundle (v1.0.6), after from the shipped v1.0.7:

```
ctx_execute    1,228 -> 748 tok    (-39%)
ctx_search     1,096 -> 767 tok    (-30%)
session floor  2,324 -> 1,515 tok  (-35%) = 0.76% of a 200K window
all eleven     6,792 -> 5,983 tok
```

`ctx_search`'s schema is environment-dependent: with `CONTEXT_MODE_PROJECT_DIR`
set at module load — which is how the plugin is actually launched — it gains a
`project` field and measures 767 tok. Without, 699. **1,515 is the production
figure**; a measurement taken with that variable unset understates the floor by
68 tok.

Both trimmed descriptions now close by naming their deferred siblings, so the two
always-loaded tools serve as the index for the other nine. This is not
decoration: **`ctx_index` had 0 calls in 62 days** — across *both* plugin
generations, so this one is not a windowing artifact — despite being
irreplaceable (recursive directory indexing, content-hash staleness flagging). It
was never unwanted, only unmentioned.

Separately, `ctx_execute`'s `language` enum now derives from `available`, the same
detected-runtime list the description already interpolated into `Languages: ...`.
An enum that mirrors detection cannot offer a runtime the executor will refuse.

## Consequences

- Every context pays a 1,515 tok floor (0.76% of a 200K window) whether or not it
  touches ctx_*. Accepted against a 713K ceiling on a 105K cost: break-even at a
  15% realization rate.
- **The realization rate is unmeasured, and the baseline cannot measure it.** The
  original draft leaned on "95.6% of sessions that loaded ctx_* then used it" as
  evidence that discovery was the only bottleneck. That figure is a selection
  effect: issuing a `ToolSearch` for a tool *is* the intent to call it, so a high
  follow-through rate is close to tautological. It says nothing about what a
  model does with a schema it never asked for. Only running v1.0.7 answers this.
- The first post-release measurement window (35 min, 8 contexts, 7 of them
  generated by the verification session itself) produced **no usable sample**.
  Re-measure over ~60 organic contexts (~2-3 days at the observed 29 contexts/day),
  excluding this repository's own sessions and any context whose parent session
  started before the v1.0.7 install — a session keeps the plugin build it booted
  with, so subagents of a pre-install parent are not v1.0.7 datapoints.
- The nine deferred tools are unchanged and still reachable via `ToolSearch`,
  exactly as before. **Deferral is lazy loading, not removal.**
- `ctx_purge` staying deferred doubles as a safety property: a destructive tool is
  better hard to reach.
- The enum narrows per host and per server start. A runtime installed after the
  server boots is not offered until restart — where the previous behaviour offered
  it always and failed at execution instead. Failing at the schema is cheaper.
- **The enum inherited a detection bug and now surfaces it.** Runtime detection
  probes with the server's raw `PATH`, while `executor.ts` prepends Git's
  `usr/bin` to every child's `PATH`. Languages reachable only through that
  augmentation — perl on this host — are detected as absent and are now absent
  from the enum, so the model can no longer request a runtime that would in fact
  have worked. Under-promising, not over-promising, but it should be fixed at the
  source: make detection and execution share one `PATH`.
- ADR-0002's `RETURNS:` block style and #697's throttle wording are contracts with
  tests behind them. The first trim broke both and the tests caught it; any future
  trim must keep them.

## Alternatives considered

- **Open all eleven.** 5,983 tok/context, 413K against the same 713K ceiling —
  break-even at 58%. Rejected not on "it costs more than it saves" (at a high
  realization rate it would still net out) but because the marginal nine buy no
  additional ceiling: they cost 4.5K tok/context to address the same
  read-and-discard `ctx_execute` already covers. Paying 4x the floor to move the
  same ceiling is strictly worse than paying 1x.
- **`ENABLE_TOOL_SEARCH=false` in user settings.** One line, but it un-defers
  every MCP server on the host — ctxscribe would be paid for by also loading
  context7, chrome, and codex tools. Rejected: it fixes our discovery by
  worsening every other server's floor, and it is a per-user setting a plugin
  cannot ship anyway. Same for `.mcp.json`'s server-level `alwaysLoad` field: it
  lives in the user's `mcpServers` entry, is all-or-nothing per server, and a
  plugin cannot ship it either. The tool-level `_meta` route is the only
  server-side equivalent, which is why it is the one used here.
- **Have the PreToolUse hook deny large exploratory `Read`s** instead of nudging.
  The hook cannot know whether a `Read` precedes an `Edit`, and ~17% of large
  reads do. Rejected: a guaranteed false-positive rate on a path that breaks the
  edit workflow.

## Measurement note

The figures above come from transcript `tool_result` byte counts — what actually
entered the model's context window — not from `ctx_stats`. `ctx_stats` credits
`bytesAvoided` for `Read` calls that the hook nudges but does **not** block
(`hooks/core/routing.mjs:826`), charging the full file size even for partial reads
and re-reads, so its "kept out" figure counts bytes that did enter the window.
That is a separate defect, tracked separately (upstream #950); it is not the basis
of this decision and its numbers were not used here.

Token counts are `(description + JSON.stringify(inputSchema)).length / 4` — a
heuristic, not a tokenizer. It is used consistently across every figure here, so
comparisons hold even though absolute values carry a few percent of error.

## Revision note

The decision in this ADR was re-verified after release. `_meta` injection works:
on host 2.1.211, `ctx_execute` and `ctx_search` load upfront and the other nine
appear in the deferred list — the exact 2/11 split intended. The decision is
unchanged.

Most of the arithmetic that justified it was wrong, and it is recorded here rather
than quietly overwritten, because the failure mode generalises:

1. **The deferral premise.** The draft claimed hosts defer "once the combined tool
   surface outgrows their budget (~10% of the context window)" and framed
   ctxscribe as collateral damage from other servers. Deferral is unconditional
   by default; the 10% rule is `ENABLE_TOOL_SEARCH=auto` only.
2. **"ctx_* share of all tool calls: 0.59%."** Computed over 62 days, of which
   ctxscribe existed for 2.9. The honest figure for the window where the tool was
   installed is 3.82% (organic) / 7.84% (including this repo's own sessions) —
   an order of magnitude higher.
3. **Counting the predecessor plugin both ways.** The draft credited `ctx_execute`
   with "2,872 calls" — a figure only reachable by including `context-mode`'s
   2,653 — while the 0.59% adoption rate excludes `context-mode` entirely. The
   same data was included where it flattered the tool and excluded where it
   damned it. Whichever convention is chosen, it has to be the same one in both
   rows.
4. **The 4,116K ceiling and the "~1.5x" verdict.** Both inherited the mixed
   window. Re-measured on the clean organic window: a 713K ceiling on a 105K
   cost — break-even at 15%, not 66%. The margin the draft called "real but thin"
   was an artifact of its own baseline.
5. **The session floor.** Stated as 1,488 tok — a figure that belongs to a
   hand-patched prototype bundle which was never released. The shipped v1.0.7
   measures **1,515**. A third figure, 1,447, is the shipped bundle measured with
   `CONTEXT_MODE_PROJECT_DIR` unset — a configuration the plugin never runs in.
   Three artifacts, three numbers, and the one written down was not the product.
   The pre-trim figures (1,228 / 1,096 / 2,324, and 6,792 for all eleven) *do*
   reproduce; only the "after" column was taken from the wrong bundle.
6. **"95.6% used it once loaded."** A selection effect presented as a causal
   rate. See [Consequences](#consequences).

Every error pointed the same way — toward understating the case — so the decision
survived them. That is luck, not method. The correction that matters is not any
single number but the rule they all broke: **a rate needs a denominator drawn from
the period the thing being measured existed, and one convention has to hold across
every row of the table.**
