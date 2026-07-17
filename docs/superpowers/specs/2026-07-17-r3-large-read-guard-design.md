# R3: Large-Read Guard — design

Date: 2026-07-17
Status: draft (pending Codex adversarial review)
Scope: ADR-0008 follow-up R3 — soft large-Read enforcement, scoped in the 2026-07 context audit.

## Problem

- Full-file Reads (no `offset`/`limit`) moved **69.77 MB across 7,463 calls** in the 62-day corpus, vs 18.65 MB across 5,014 windowed Reads (calibration: 3.9 B/tok). The habit, not the need, picks the full read.
- A single 1 MB full Read ≈ **269K tokens** — one call can wreck a context window. The tail risk matters more than the average.
- R1 (ADR-0008 amendment) recovers **repeat** full Reads of indexed files (98.8% recovery at 100 KB), but:
  1. the **first** large Read still pays full price, and
  2. files **> 1 MiB are never indexed** (`MAX_INDEX_FILE_BYTES`, `hooks/core/toolindex.mjs`) — neither indexed nor read-guarded, so today every re-Read of them pays full price forever.

## Decision

Deny full-file Reads of **text files > 100 KB** (`LARGE_READ_GUARD_BYTES = 102_400`) at PreToolUse, with a recipe redirecting to `ctx_execute_file` (analysis) or a windowed Read (editing). Kill-switch: `CONTEXT_MODE_LARGE_READ_GUARD=0`.

### Options considered

| Option | Verdict | Why |
|---|---|---|
| (a) deny + recipe | **chosen** | Saves the first-read swallow; closes the > 1 MiB R1 gap; recipe redirects both analysis and edit workflows losslessly. |
| (b) warn-once, pass through | rejected | R1 read-guard already denies repeat full re-Reads; a pass-through warning saves ~0 additional bytes. No effect = no feature. |
| (c) deny + marker-delegated PostToolUse indexing | rejected (revisit on telemetry) | Preserves FTS5 recall for denied files, but adds a cross-hook state protocol (orphan markers, staleness hashing, 3-OS mtime/lock semantics). `ctx_execute_file` outputs already provide derived recall; fresh windowed Reads average 3.81 KB. Complexity > value today. |
| `permissionDecision:"ask"` | rejected | Pauses autonomous flows on every large read; the guard's purpose is autonomous byte protection. |

### Why hard deny is safe now

The strongest prior objection — 43.3% of large Reads are followed by an Edit of the same file — collapsed: a **windowed Read re-arms the Edit gate for the entire file** (experimentally confirmed, 2026-07). The false-positive cost of a deny is one ~4 KB windowed Read instead of a 100 KB+ swallow.

## Mechanism

- **Insertion point:** `hooks/core/routing.mjs` Read branch, immediately **after** the read-guard return (`:834`), **before** the 50 KB nudge. Priority chain:
  1. **read-guard deny** (file already indexed → `ctx_search` recall recipe — the better recipe wins for known content);
  2. **R3 deny** (unindexed large files: first reads and the > 1 MiB band → `ctx_execute_file`/windowed recipe);
  3. **50 KB nudge** (unchanged, keeps covering 50–100 KB pass-throughs and exempted files).
- Reuse the nudge's existing `statSync` (single stat syscall) and the read-guard's windowed-read predicate (shared helper so the two guards can never disagree on what "windowed" means).
- **Media/visual exemption:** image/PDF files pass through — the Read tool renders them visually and no ctx tool can substitute. Follow the binary/sensitive detection approach already in `toolindex.mjs`.
- Missing file, directory, stat error → pass through (preserve Read's native error).
- **Accounting:** attach `redirectMeta {tool:"Read", type:"large-read-denied", bytesAvoided:<stat size>}` — flows through the existing marker → PostToolUse `redirect` event → **built-in post-deploy telemetry** (`bytes_avoided`), so R3's real-world effect is measured, not asserted.
- **Deny reason (recipe):** file path + size; `ctx_execute_file(path, language, code)` for analysis; `Read(offset, limit)` for editing, noting that a windowed Read re-arms Edit for the whole file; states the content is NOT indexed (so the agent does not try `ctx_search` recall).

## Expected effect (honest sizing)

- Corpus modeling at a 20 KB cap threshold bounded savings at 4.02–8.03 MB/62d; the > 100 KB-only slice is **smaller and not directly measured**. Claim no number.
- Primary value: (1) tail-risk cap — no more 100 KB–2 MB single-call swallows; (2) closes the > 1 MiB R1 gap; (3) `bytes_avoided` telemetry measures reality after deploy.
- Latency: stat-only on the new path (no hashing for unknown files); read-guard precedent: 68.6 ms deny, ≤ 16 ms same-hash.

## Discriminating tests

1. > 100 KB full Read → **deny**; recipe contains `ctx_execute_file` and `offset`/`limit`; `redirectMeta.type === "large-read-denied"`.
2. > 100 KB Read **with** `offset`/`limit` → pass.
3. 60 KB full Read → not denied (nudge may fire).
4. File already indexed + guarded, > 100 KB → **read-guard deny wins** (`read-guard-denied`, `ctx_search` recipe).
5. `CONTEXT_MODE_LARGE_READ_GUARD=0` → pass.
6. > 100 KB `.png` → pass (media exemption).
7. > 1 MiB text file → deny (R1 gap covered).
8. Nonexistent path → pass (native error path).
9. First-ever Read of a file is denied the same as any other (no warn-pass state) — covered by (1).

## Livefire verification

Spawn the real `pretooluse.mjs` as a child process (recipe from `tests/hooks/r1-posttooluse-index.test.ts`) against generated 200 KB and 1.5 MB files: assert the deny JSON (~0.6 KB) versus the would-be payload; measure hook latency before/after the change. Any full-server boot uses the `tests/core/echo-commands.test.ts` JSON-RPC recipe with test-env isolation so manifests stay clean.

## Documentation

- ADR-0008: second amendment recording R3 adoption (options, decision, caps, telemetry plan).
- Repo CLAUDE.md `### Read (for analysis)`: one line — > 100 KB full Read is denied with a recipe.
- Kill-switch documented alongside `CONTEXT_MODE_READ_GUARD` / `CONTEXT_MODE_TOOL_INDEX`.

## Out of scope

Bash output indexing (deferred, ADR-0008 amendment); cross-session deny; threshold auto-tuning; any change to R1 indexing gates.
