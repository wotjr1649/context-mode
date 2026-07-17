# R3: Large-Read Guard — design

Date: 2026-07-17
Status: accepted (revised after Codex adversarial review, 2026-07-17 — threshold rescoped 100 KB → 1 MiB)
Scope: ADR-0008 follow-up R3 — large-Read enforcement, scoped in the 2026-07 context audit.

## Problem

- Full-file Reads (no `offset`/`limit`) moved **69.77 MB across 7,463 calls** in the 62-day corpus, vs 18.65 MB across 5,014 windowed Reads (calibration: 3.9 B/tok). The habit, not the need, picks the full read.
- A single 1 MB full Read ≈ **269K tokens** — one call can wreck a context window outright. The tail risk matters more than the average.
- R1 (ADR-0008 amendment) recovers **repeat** full Reads of indexed files (98.8% recovery at 100 KB), but files **> 1 MiB are never indexed** (`MAX_INDEX_FILE_BYTES`, `hooks/core/readstate.mjs`) — neither indexed nor read-guarded, so today every Read of them pays full price forever, and no recall path exists.

## Decision

Deny full-file Reads of **text files > 1 MiB** (`LARGE_READ_GUARD_BYTES = MAX_INDEX_FILE_BYTES = 1_048_576`) at PreToolUse, with a recipe redirecting to `ctx_execute_file` (analysis) or a windowed Read (editing). Kill-switch: `CONTEXT_MODE_LARGE_READ_GUARD=0`. Subagent sessions are exempt (R1 parity).

**R3 denies exactly the band R1 can never index.** Above 1 MiB there is no FTS5 recall to lose, no R1 repeat-recovery to cannibalize, and no legitimate full-Read outcome — the payload (≥ 269K tok) exceeds any usable context window, so the tool call is guaranteed self-harm. The two guards are complementary by construction: R1 owns repeats of ≤ 1 MiB indexed files; R3 owns everything above.

### Codex adversarial review (2026-07-17) — disposition

Verdict was needs-attention on the original > 100 KB scope. Findings and how they landed:

| Finding | Disposition |
|---|---|
| Deny telemetry overwritten by the recovery path (single redirect marker; windowed retry's 50 KB-nudge `redirectMeta` clobbers it) | **Adopted — root-cause fix.** The nudge now attaches `redirectMeta` only to full (non-windowed) Reads. This preserves the `large-read-denied` marker across the windowed retry AND fixes the pre-existing overclaim where a windowed Read of a big file emitted `read-redirected` with `bytes_avoided` = whole file size. Parallel-call last-write-wins remains a pre-existing residual for all redirect types (documented). |
| Hard deny at 100 KB removes the existing 100 KB–1 MiB recall path (R1 indexing + 98.8% repeat recovery) | **Adopted — rescoped to > 1 MiB**, where no recall exists today. Lowering the threshold is a future ADR amendment gated on a raw-source indexing path for denied files (marker-delegated indexing) or a corpus dry-run with defined retry/abandonment ceilings. |
| Subagents stranded (fixed-tool subagents cannot call `ctx_execute_file`) | **Adopted** (was already in the implementation plan): `isSubagent` → fail-open, mirroring R1. Verified livefire with `agent_id`/`agent_type` payloads. |
| Media exemption reused the wrong classifier and omitted `.ipynb` | **Adopted** (was already in the implementation plan): a dedicated Read-renderable predicate `VISUAL_READ_EXTS` (`.png .jpg .jpeg .gif .webp .bmp .ico .pdf .ipynb`) — deliberately narrower than toolindex `BINARY_EXTS`; archives/executables SHOULD be denied (`ctx_execute_file` handles them). |
| Presence-only `offset`/`limit` predicate is bypassable (`offset:0, limit:999999`) | **Rejected with documented residual.** Predicate parity with R1 (`isWindowedRead`) outweighs a speculative bypass: current Claude Code rejects explicit ranges exceeding the token limit at the tool layer, which backstops the > 1 MiB band. Recorded in ADR-0008 as a residual with the client-version caveat. |
| 100 KB threshold unmeasured; no per-call escape | **Resolved by rescoping.** At > 1 MiB the deny is near-tautological (payload exceeds the window), so no whole-file escape is needed beyond the kill-switch. A corpus dry-run is a precondition for any future threshold lowering, not for this release. |

### Options considered (original brainstorm)

| Option | Verdict | Why |
|---|---|---|
| (a) deny + recipe, > 1 MiB | **chosen** | Closes the band R1 structurally cannot cover; zero recall regression; recipe redirects both analysis and edit workflows losslessly. |
| (a′) deny + recipe, > 100 KB | rejected (Codex) | Regresses the working R1 recall path for 100 KB–1 MiB; unmeasured eligible slice; false-positive surface (lockfiles, generated code, explicit whole-file requests). |
| (b) warn-once, pass through | rejected | R1 read-guard already denies repeat full re-Reads; a pass-through warning saves ~0 additional bytes. No effect = no feature. |
| (c) deny + marker-delegated PostToolUse indexing | rejected (revisit for threshold lowering) | Preserves FTS5 recall for denied files, but adds a cross-hook state protocol (orphan markers, staleness hashing, 3-OS mtime/lock semantics). Not needed at > 1 MiB where nothing is indexable anyway; becomes the enabling work if the threshold is ever lowered. |
| `permissionDecision:"ask"` | rejected | Pauses autonomous flows; the guard's purpose is autonomous byte protection. |

### Why hard deny is safe at this scope

- A windowed Read re-arms the Edit gate for the entire file (experimentally confirmed, 2026-07) — the edit workflow survives a deny at the cost of one ~4 KB windowed Read.
- \> 1 MiB full-Read payloads are not usable even when "needed": ≈ 269K tokens exceeds the context window, and current Claude Code truncates or rejects at the tool layer anyway. The deny converts a guaranteed window blowout into a 0.6 KB recipe.

## Mechanism

- **Insertion point:** `hooks/core/routing.mjs` Read branch, immediately **after** the R1 read-guard return, **before** the 50 KB nudge, reusing the nudge's `statSync` (single stat syscall). Priority chain: R1 read-guard → R3 large-read guard → 50 KB nudge (unchanged for ≤ 1 MiB pass-throughs and exempted files).
- `evaluateLargeReadGuard({ toolInput, filePath, st, isSubagent })` lives in `hooks/core/readstate.mjs` beside `evaluateReadGuard`; both share one exported `isWindowedRead` predicate so the guards can never disagree.
- Stateless; fails OPEN on every ambiguity (missing file, stat error, directory, null input) — mirror of R1.
- No MCP-readiness gating (`mcpRedirect`): unlike WebFetch, the deny recipe's windowed-Read escape hatch is a native tool, valid even when MCP is down. R1 precedent.
- **Nudge accounting fix:** the 50 KB nudge attaches `redirectMeta` (type `read-redirected`, `bytesAvoided` = file size) only to **full** Reads. Windowed Reads of big files no longer emit a false whole-file `bytes_avoided` and no longer clobber a pending deny marker.
- **Accounting:** `redirectMeta {tool:"Read", type:"large-read-denied", bytesAvoided:<stat size>}` → existing marker → PostToolUse `redirect` event → post-deploy telemetry (`bytes_avoided`). The denied call has no PostToolUse of its own; the next successful tool call flushes the marker.
- **Deny reason (recipe):** file path + size; `ctx_execute_file(path, language, code)` for analysis; `Read(offset, limit)` for editing, noting that a windowed Read re-arms Edit for the whole file; states the content is NOT indexed (so the agent does not try `ctx_search`); names the kill-switch.

## Expected effect (honest sizing)

- The > 1 MiB slice was not separately measured in the corpus; claim no MB number. Primary value: (1) tail-risk cap — a single guaranteed-fatal call class is eliminated; (2) covers the only Read band with no existing mitigation; (3) `bytes_avoided` telemetry measures reality after deploy (now credible, since the recovery path no longer destroys the event).
- Latency: stat-only on the new path (no hashing); read-guard precedent 68.6 ms deny / ≤ 16 ms same-hash; R3 target < 3 ms p95 in-process (hook-latency budget).

## Discriminating tests

1. > 1 MiB full Read → **deny**; recipe contains `ctx_execute_file` and `offset`/`limit`; `redirectMeta.type === "large-read-denied"`; `bytesAvoided` = file size.
2. > 1 MiB Read **with** `offset`/`limit` → pass (documented residual: presence-only predicate).
3. 120 KB and 800 KB full Reads → not denied (R1 band untouched; nudge may fire).
4. Armed R1 file (≤ 1 MiB, unchanged) → **read-guard deny wins** (`read-guard-denied`, `ctx_search` recipe).
5. `CONTEXT_MODE_LARGE_READ_GUARD=0` → pass (unit + livefire through the shipped hook).
6. > 1 MiB `.png` / `.pdf` / `.ipynb` → pass (Read-renderable exemption).
7. Subagent session (`isSubagent` / `agent_id` payload) → pass (R1 parity), verified against the real `pretooluse.mjs`.
8. Nonexistent path → pass (native error path).
9. Windowed Read of a big file attaches NO `read-redirected` redirectMeta (nudge accounting fix) — and a pending `large-read-denied` marker survives a windowed retry.

## Livefire verification

Spawn the real `pretooluse.mjs` as a child process (recipe from `tests/hooks/redirect-marker-read.test.ts`) against generated 1.5 MB files: assert the deny JSON (~0.6 KB) versus the would-be payload, the marker content, the kill-switch, and the subagent exemption. Latency via the `hook-latency.test.ts` p95 budget with a > 1 MiB file case.

## Documentation

- ADR-0008: second amendment recording R3 adoption (decision, Codex disposition, residuals, threshold-lowering preconditions, telemetry plan).
- Repo CLAUDE.md `### Read (for analysis)`: one line — > 1 MiB full Read is denied with a recipe.
- Kill-switch documented alongside `CONTEXT_MODE_READ_GUARD` (ADR-0008, same placement as R1).

## Out of scope

Bash output indexing (deferred, ADR-0008 amendment); cross-session deny; threshold lowering below 1 MiB (needs raw-source indexing or corpus dry-run per the Codex disposition); marker queue for parallel-call races (pre-existing, all redirect types); any change to R1 indexing gates.
