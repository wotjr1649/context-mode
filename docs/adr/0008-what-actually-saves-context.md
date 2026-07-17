# ADR-0008 — What actually saves context: measured levers, ranked

- **Status**: Proposed — R1 implemented & amended 2026-07-17 (see Amendment)
- **Date**: 2026-07-17
- **Scope**: roadmap; no code in this ADR. Companion instrument:
  `scripts/measure-adoption.mjs` (calibrated against the ERA-2 baseline).
- **Inputs**: 62-day transcript corpus on the maintainer's machine
  (2,068 transcripts / ~965 MB / 49,977 tool_use; conventions: UTF-8 bytes,
  3.9 bytes/token, KB=1024), the ERA-2 organic baseline (N=69 contexts,
  adoption 3.82%, Read byte share 75.5%, "missed" ≈55%), and vendor-published
  numbers collected 2026-07-17.

## Context

The 2026-07 audit falsified this project's original savings story (see
ADR-0006's revision note and BENCHMARK.md's caption). The honest question
left standing: **which mechanisms actually reduce context consumption, by how
many bytes, on a real corpus?** Every candidate below is quantified on the
same 62 days; anything unquantifiable was dropped.

Two ledgers are kept separate throughout, because they buy different things:

- **Window ledger** — bytes that enter the *parent* context window. This is
  what compaction, truncation, and reasoning degradation respond to.
- **Token ledger** — total tokens spent anywhere (parents + subagents).
  This is what money and latency respond to.

Vendor numbers each measure a *different denominator* — never mix axes:
tool-definition deferral **85%** (fixed prompt cost; Anthropic advanced-tool-use),
code-execution-with-MCP **98.7%** (tool-definition loading for one workflow),
programmatic tool calling **37%** (tool-result tokens on complex research),
context editing **84%** (retroactive clearing, 100-turn eval),
prompt caching **~90% cost** (dollars only — frees zero window bytes).
Cursor publishes accuracy (not tokens) for semantic search; Aider publishes a
budget (1k-token repo map), not a saving. Measured byte-savings on a real
corpus — this document's lane — has no incumbent number.

## Measured levers, ranked by corpus ceiling

| # | Lever | Ceiling (62 d) | Realistic take | Ledger | Effort |
|---|-------|----------------|----------------|--------|--------|
| 1 | **Repeat-Read recall** — 2nd+ Reads of the same path were 58.2 MB in-session + 38.8 MB cross-session (of 88.4 MB total Read bytes). Serving repeats from the index at ~0.8 KB/hit | 51.7 MB (+34.6 cross) | 15–30 MB (staleness discounts; a Read after an Edit is a *legitimate* re-read) | both | hook change |
| 2 | **Session fixed cost** — median first-turn context 52.0 K tok/parent session; 13.5 M tok across 272 parent sessions; **subagents pay it too: 53.4 K × 1,733 = 92–107 M tok**, 7.9× the parents' total. Interactive sessions median 79.5 turns → fixed context re-occupies the window every turn | 100+ M tok | tens of M tok (subagent `tools:` allowlists; plugin diet; `ENABLE_TOOL_SEARCH` already defers MCP by default) | token (window: 52 K/200 K = 26% of every window pre-burnt) | config/docs |
| 3 | **Large-Read windowing** — Reads >20 KB: 1,151 calls / 36.5 MB (43.3% later edited same-session — higher than the 20–30% previously claimed, so hard-deny has real false-positive cost). Cap the 20.8 MB no-edit share at 20 KB → 8.0 MB; at 4 KB windows → 18.2 MB | 18.2 MB | 4–8 MB (soft enforcement only) | both | hook change |
| 4 | **Subagent discipline** — isolation moved 135.2 MB internal → 7.3 MB returned (median leverage 15.8×): the *window* ledger's best mechanism. But each spawn costs ~53.4 K tok fixed, and 39.8% of 1,733 spawns did <50 KB of internal work — 45.2 M tok of fixed cost for sub-break-even jobs. Net token ledger: **−70 M tok** | +34 M tok window / −70 M tok total | spawn rule: expected exploration > ~50 K tok (≈200 KB) or parent-window pressure is the binding constraint | window↑ token↓ | docs |
| 5 | **Code-echo removal** (shipped, this PR) — 26% of ctx_execute response bytes; live-fired 1,741 B → 18 B on a 1.7 KB-code call | 0.37 MB | 0.37 MB (done) | both | done |
| 6 | **Persuasion** — ERA-2 organic adoption was 3.82% *with maximal prompting* (CLAUDE.md walls, per-call hook tips, skill docs). Nudges do not move the needle; defaults and enforcement do. 80% of ctx_execute volume arrived via the auto-injected subagent routing block — an *enforced* channel | — | treat as a constraint, not a lever | — | — |

Reference per-call costs (post-echo-removal): Read 7.26 KB · ctx_execute ≈3.3 KB ·
Agent 3.17 KB · Grep 1.87 KB · Bash 1.43 KB. Grep-preceded Reads averaged −22%
bytes (6.09 vs 7.83 KB) — search-first correlates with windowed reads.

## Decision (roadmap, in order)

1. **R1 — Passive indexing (build next).** A PostToolUse hook already observes
   every tool result. Index large Read/Bash results (>4 KB) into FTS5 with
   file-backed source labels (content-hash staleness already exists in the
   store). This attacks lever #1 *without requiring any model adoption* —
   the honest answer to #6. Expected: converts a meaningful slice of the
   51.7 MB repeat-read ceiling into ~0.8 KB recall hits.
2. **R2 — Subagent fixed-cost diet (document now).** Subagent definitions
   inherit the full tool surface by default; `tools:`/`disallowedTools:`
   allowlists cut the ~53 K tok spawn tax. Add the spawn rule to CLAUDE.md:
   *spawn when expected exploration exceeds ~200 KB or the parent window is
   the binding constraint; otherwise stay inline.*
3. **R3 — Soft large-Read enforcement.** PreToolUse: deny Reads of >100 KB
   files without `offset/limit`, with a message carrying the exact
   Grep→windowed-Read recipe. Soft threshold (not 20 KB) because 43.3% of
   large Reads precede same-file Edits; ADR-0006's block-rejection stands for
   aggressive thresholds. Requiring a *window* is compatible with Edit —
   Edit needs the target region's bytes, not the whole file.
4. **R4 — Fleet diet (user action, this machine).** First-turn fixed context
   is directly measurable per session; disabling unused plugins is the only
   lever for the 52 K/session floor. Re-measure weekly via
   `scripts/measure-adoption.mjs`.
5. **R5 — Claims stay pinned to measurements.** BENCHMARK.md (13–99% per
   scenario) remains the only citable savings number until T1's
   post-install window (2026-07-19+, ≥60 organic contexts) reports.

## Consequences

- The project's honest identity: **a good search index over session history
  plus a prompt that makes the model write scripts** — R1 doubles down on the
  part that is real (the index) and removes dependence on the part that is
  not (voluntary adoption).
- R1 adds index-write volume; FTS5 disk cost is accepted (store already
  sweeps stale DBs).
- The two-ledger framing becomes policy: subagents and sandboxes are
  *window* tools, not *cost* tools, and documentation must never conflate
  the two again.
- T1 (2026-07-19+) arbitrates ADR-0007's always-load bet with
  `scripts/measure-adoption.mjs`; its exclusion rules and calibration are
  documented in the script header.

## Amendment (R1 implemented — Read-only scope + read-guard adopted, 2026-07-17)

R1 shipped with two deliberate deviations from the paragraph above and one
addition, all stress-tested by an independent adversarial review of the
design before implementation:

1. **Read-only (Bash deferred).** Large Bash output routinely carries
   secrets (`printenv`, CI logs, tokens in test failures); passively
   persisting it would convert transient conversation exposure into durable,
   project-wide searchable storage. Lever #1's measured bytes are entirely
   Read traffic, so Bash indexing buys risk without ceiling. Revisit only
   behind an explicit opt-in or a vetted secret filter.
2. **Full-file Reads only.** Windowed (`offset`/`limit`) reads are neither
   indexed nor recorded. Indexing a whole file behind a 4 KB windowed
   response was the worst-case synchronous-latency path in the hook, and the
   corpus repeat volume is dominated by full re-reads.
3. **Read-guard adopted (stage 2 of R1, distinct from R3).** A PreToolUse
   deny fires ONLY when all hold: main conversation (hook input carries
   `agent_id`/`agent_type` for subagents — those never deny), no
   `offset`/`limit`, a same-session sidecar record armed by successful
   indexing, content-store identity unchanged (ino+birthtime of the db file,
   so `ctx_purge`/db recreation auto-invalidates), and file size+mtime+sha256
   all unchanged; records expire after 48 h; `CONTEXT_MODE_READ_GUARD=0`
   disables. Everything else falls through — fail-open. This is *not* R3's
   size-based soft enforcement: it denies only byte-identical duplicates
   whose content is provably recallable, and R3 remains future work.
   Edit-safety was verified live before adoption: a windowed Read re-arms
   Edit for the whole file (an edit outside the read window succeeded), so
   the deny recipe's escape hatch can never permanently block an Edit flow;
   first reads are never denied (no record) and post-Edit re-reads pass
   (hash mismatch).
4. **Volume + sensitivity caps.** Per file ≤1 MiB (larger files are skipped
   entirely so the deny recipe never overclaims searchability); per session
   ≤300 files / 24 MiB (subagent reads consume the byte budget too, and a
   re-read of the same path replaces its byte contribution instead of
   accumulating); per project store ≤800 sources; a built-in
   sensitive-basename floor (`.env*`, `*.pem`, `*.key`, `id_rsa*`,
   `credential*`, `secret*`, …) beneath the user's Read deny patterns;
   binary detection (extension + NUL sniff). Containment and sensitivity
   are checked against both the lexical path and the symlink-resolved real
   path. `CONTEXT_MODE_TOOL_INDEX=0` disables indexing and recording.
5. **Search-time cost stays bounded.** `searchWithFallback` examined every
   file-backed source before each search; passive indexing multiplies those
   sources. `REFRESH_BUDGET` now caps expensive stale-source examinations
   per search (leftovers refresh on later searches), and a same-hash
   examination advances `indexed_at` so mtime-only touches (git checkout,
   build steps) leave the stale set instead of re-hashing forever; the
   iteration order is randomized so a persistently failing source cannot
   starve the same tail rows on every search.
6. **Accounting reuses existing channels.** Guard denies ride the
   rejected-approach and redirect (`bytes_avoided`) event categories that
   PreToolUse↔PostToolUse markers already carry; `ctx_stats` gains no new
   derived-savings claim (the 2026-07 audit rule).
7. **Plumbing.** `src/store.ts` is now also bundled as
   `hooks/store.bundle.mjs` (soft-fallback in the boot integrity gate;
   `loadStore()` falls back to `build/store.js`), mirroring the session-db
   bundle contract from ADR-0001 — hook-process writes go through the same
   `withRetry`/WAL multi-writer path the store already uses.
8. **Measured (livefire, 2026-07-17, n=7 per size, maintainer machine).**
   Marginal hook-process cost of cold indexing over the ~80–93 ms
   pre-existing PostToolUse baseline: ~37 ms @8 KB, ~42 ms @100 KB,
   ~200 ms @1 MB (the cap); a same-hash re-read adds ≤16 ms. A denied
   100 KB re-read: 602 B deny JSON + 658 B real-server ctx_search recall
   vs 102,442 B re-entering the window — 98.8% recovered, deny decision
   68.6 ms, windowed escape verified live against the armed guard. The
   recall size matches the R1 paragraph's ~0.8 KB/hit estimate.
