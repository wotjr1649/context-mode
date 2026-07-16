# ADR-0007 — ctx_execute: conditional keep, judged by the post-install window

- **Status**: Accepted
- **Date**: 2026-07-17
- **Scope**: fate of `ctx_execute` (and its always-load `_meta`); `ctx_insight`
  removal is recorded here as context. Companion roadmap: ADR-0008.
- **Method**: adversarial — two independently argued briefs (keep / kill) over
  the same 62-day corpus, judged on the numbers. Falsified audit figures
  (ADR-0006 revision note) were barred from both briefs.

## Context

The 2026-07 audit left `ctx_execute` in an uncomfortable spot. Against it:
ERA-2 organic adoption was **3.82%** under maximal promotion (CLAUDE.md
routing walls, per-call hook tips, always-load); `intent` — the one capability
Bash lacks (output → FTS5 auto-index) — was used in only **130 of 3,041 calls
(4.3%)**; **1,136 calls (37%)** used `language:"shell"`, a strictly worse
envelope around Bash; and the always-load schema costs **748 tok in every
context** — ≈**1.5 M tok over 62 days** across 272 parent sessions + 1,733
subagent contexts. For it: **2,267 organic calls** came from real projects
where the tool was not the topic (DAS 1,167, SORTER 961); **80% of volume was
issued by subagents**, whose prompts carry the auto-injected routing block —
an *enforced* adoption channel that works, unlike persuasion; the index it
feeds is actually consumed (**275 ctx_search calls × 5.05 queries**); and it
is the only compliant execution surface on this machine for sandboxed web
fetch and for deny-policy-enforced non-Bash execution
(`extractShellCommands`, live-fire verified).

`ctx_insight` had no such tension: **0 calls in 62 days**, an
upstream-hosted dashboard funnel violating the fork charter. Removed
2026-07-17 along with its CLI twin (11 → 10 tools).

## Decision

1. **Keep `ctx_execute`, and keep its always-load `_meta` untouched until the
   T1 measurement window closes.** ADR-0006's always-load is a *bet with a
   stated losing condition* (realized adoption < 15%, its own break-even).
   The instrument for that bet is the post-install organic window
   (2026-07-19+, ≥60 organic contexts, `scripts/measure-adoption.mjs` with
   its documented exclusions). Judging the bet today with ERA-2
   (pre-install) numbers would repeat the era-mixing error this audit spent
   a week correcting: whether always-load *changes* adoption is exactly the
   hypothesis under test.
2. **Pre-registered verdict rule** (so the judgment cannot be moved later):
   - post-install organic adoption **< 15%** → demote to deferred: remove
     `ctx_execute` from the always-load set at `src/server.ts`
     (`installStrictClientSchemaCompat` `_meta` hook), keeping `ctx_search`
     always-loaded. One-line change, recorded as an amendment here.
   - **≥ 15%** → always-load stands; re-measure next quarter.
3. **Full deletion (option C) is rejected** — both briefs converged on this.
   Deletion breaks the 2,436 subagent-issued think-in-code calls while
   saving nothing beyond what demotion already recovers (the schema tokens);
   the per-call response tax was eliminated by the echo removal
   (1,741 B → 18 B live-fired, this release).
4. **Passive indexing (ADR-0008 R1) proceeds regardless of the verdict.**
   Both briefs agree it decouples the real feature (the searchable index)
   from voluntary adoption: PostToolUse already observes every tool result,
   and the corpus's largest prize (repeat-Read recall, 58.2 MB) depends on
   index *coverage*, not on ctx_execute usage. The keep-side's point stands
   that passive indexing complements rather than replaces think-in-code
   (a 700 KB log reduced to a 3 KB answer only happens in a sandbox).
5. **`language:"shell"` guidance follow-up** (non-blocking): 37% of calls
   pay the ctx_execute envelope for work Bash does cheaper. The hooks'
   guidance tip should steer plain shell one-liners to Bash/ctx_batch_execute.
   Not enforced by deny — batch/piped shell via the sandbox stays legitimate.

## What would change our minds

- T1 shows adoption ≥ 15% but "missed context" unchanged → the tool is being
  used without saving anything; revisit with per-call substitution analysis
  (did each ctx_execute replace a Read, or add to it?).
- Passive indexing (R1) ships and recall covers the repeat-Read prize on its
  own → the marginal case for always-load shrinks to think-in-code alone;
  the 15% bar rises accordingly at the next review.

## Consequences

- Zero code changes today; the demotion path is one line and pre-agreed.
- The Bash-vs-ctx_execute asymmetry becomes documented policy: *analysis in
  the sandbox, observation and mutation in Bash* — per-call byte costs
  (post-echo): ctx_execute ≈3.3 KB vs Bash 1.43 KB; the envelope only pays
  for itself when it replaces a Read (7.26 KB) or externalizes a large
  output, not when it wraps `git status`.
- ADR-0006 remains the always-load record; this ADR adds the judgment
  protocol its revision note lacked.
