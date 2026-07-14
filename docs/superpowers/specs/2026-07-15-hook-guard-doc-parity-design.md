# Design — Claude/Codex hook · guard · instruction parity (v1.0.4)

- **Status**: Approved (brainstorming)
- **Date**: 2026-07-15
- **Release**: v1.0.4 (repo track only)
- **Scope**: `PRE_TOOL_USE_MATCHERS`, `hooks/hooks.json`, `src/adapters/codex/hooks.ts` (repo);
  `~/.codex/hooks/codex_global_policy.ps1`, `~/.codex/AGENTS.md` (machine)

## Context

Audit of four parity surfaces between the Claude Code and Codex clients, prompted by an
apparent "hook count" mismatch. The audit distinguished three layers that were being
conflated: (1) ctxscribe **product hooks** (this repo), (2) the user's personal **safety
guards** (machine `~/.claude/hooks` and `~/.codex/hooks`), and (3) the **instruction docs**
(repo `configs/` and machine global files).

## Findings

1. **Product hooks — already aligned.** Claude registers 6 lifecycle events, Codex 5. The
   single difference (`UserPromptSubmit`) is the **intended, test-pinned** contract of
   ADR-0005 (v1.0.3): Codex honors "no raw prompt capture", Claude keeps it opt-in. Not a gap.

2. **Product hooks — one real redundancy.** Claude `PreToolUse` lists 9 matcher entries; the 3
   `mcp__plugin_ctxscribe_mcp__ctx_*` entries are already subsumed by the `mcp__` catch-all
   (the code comment itself states "`mcp__` alone is enough"). A tool matching two entries can
   fire `pretooluse.mjs` twice. The per-entry shape is the deliberate #529 architecture
   (guarded by `claude-code.test.ts` drift test), so the fix is to **remove the 3 redundant
   entries from `PRE_TOOL_USE_MATCHERS`** (array → JSON auto-follows; tests compare to the
   array), not to collapse into a single combined matcher.

3. **Guards — one real gap (Codex).** With settings.json deny rules included, Claude and Codex
   enforce equivalent DB / delete / dangerous-git / raw-HTTP / secret-redaction coverage. The
   exception: the **§2 test-OOM cap** is hook-enforced on Claude (`test-guard.mjs`) but only
   advisory (AGENTS.md) on Codex — `codex_global_policy.ps1` has no `dotnet test` / `vitest` /
   `pytest` cap. §2 is a "caused real OOM crashes" invariant, so this is a genuine hole.

4. **Docs — consistent.** `configs/claude-code/CLAUDE.md` vs `configs/codex/AGENTS.md` differ
   only by per-client terminology; the prompt-capture contract was reconciled in ADR-0005.
   Global docs are independently authored but share the safety invariants; the one substantive
   update is reflecting finding 3.

## Decisions

- **A1 (repo):** Remove `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` from
  `PRE_TOOL_USE_MATCHERS` and the matching entries from `hooks/hooks.json` (→ 6 entries:
  `Bash|WebFetch|Read|Grep|Agent|mcp__`). Hook body routing is unchanged (`routing.mjs`
  handles ctx tools regardless of the matcher).
- **A2 (repo):** Correct the stale "6 hook events … UserPromptSubmit" comment in
  `src/adapters/codex/hooks.ts` to "5 registered; UserPromptSubmit dispatch-only per ADR-0005".
- **B1 (machine):** Port `test-guard.mjs`'s OOM-cap logic to `codex_global_policy.ps1`
  (`dotnet test` requires `DOTNET_GCServer=0` + `DOTNET_GCHeapHardLimit`; `vitest` requires
  single-worker; `pytest -n auto/≥2` denied). Fires on PreToolUse + PermissionRequest, fail-open.
- **Doc (machine):** Update `~/.codex/AGENTS.md` §7 to state the OOM cap is now hook-enforced.
- **Skip B2/B3:** dangerous-git already denied in settings.json; prompt secrets already redacted
  (ADR-0005). Net-new value below the YAGNI bar.

## Implementation & verification

1. A1 + A2 edits → `npm run build` (mandatory before committing `src/`) → run affected suites
   capped (`vitest --pool=forks --maxWorkers=1`): `claude-code.test.ts` drift guard,
   `default-hook-registration.test.ts`, `integration.test.ts` ctx routing.
2. B1 edit → smoke-test by piping sample PreToolUse JSON (`dotnet test` capped vs uncapped,
   `echo dotnet test`, `pytest -n auto`) to the script and asserting deny/allow.
3. Cross-model review (CLAUDE.md §7): adversarial-review on the plan (matcher-removal safety,
   B1 false-negative risk), `/codex:review` on the repo diff pre-commit.
4. `npm version patch` (runs version-sync) → push single tag → PR against `wotjr1649/ctxscribe`.

## Consequences

- No double-matching of ctx/MCP tools on Claude; matcher set matches Codex's single-regex intent.
- Codex gains deterministic OOM protection at parity with Claude.
- B2/B3 intentionally not added; the asymmetry is by mechanism, not coverage.
