# Phase 4+ candidate backlog

Follow-up items surfaced during phases 3 and 4 that were deliberately deferred.
They lived only in the untracked `.superpowers/sdd/progress.md` ledger; the
phase-3 whole-branch review flagged that as a durability risk, so they are
promoted here. Each item names its origin, evidence, and risk. Nothing here
blocks the current state — these are opt-in improvements.

> Convention: `file:line` references are accurate as of the phase-4 close
> (`main` ≈ `17900e2`) and drift as the tree changes — locate by symbol.

## A. `tests/` type debt (harness now exists)

`npm run typecheck:tests` (added in phase 4, `tsconfig.test.json`) surfaces
**157 TypeScript errors in `tests/`** that were editor-only through phase 3
(no repo command type-checked tests before). Left unfixed by design; the
harness exists so this can be burned down deliberately.

Breakdown (as of phase-4 close):
- **~95 × TS7016** — missing declaration files for `.mjs` modules imported from
  tests (`hooks/*.mjs`, `scripts/*.mjs`). Mostly noise; the repo's convention
  is `// @ts-expect-error — JS module, no TS declarations`. A blanket
  `allowJs`/`checkJs:false` or per-import suppression would clear most.
- **12 × TS2578** — unused `@ts-expect-error` directives (the ones the editor
  flagged all through phase 3, e.g. `heal-installed-plugins.test.ts`).
- **Genuine type mismatches (fix these first):** TS2739/TS2741 fixture shape
  gaps in `tests/analytics/format-report.test.ts` (`misses`/`hit_rate`/
  `categoryCounts` missing from stat fixtures), TS2322 in `tests/benchmark.ts`,
  TS2835 missing `.js` import extensions in `tests/adapters/*.test.ts`.
- Note: `typecheck:tests` is intentionally NOT wired into `build`/`pretest` —
  it is a standalone diagnostic until the debt is burned down.

## B. Runtime hard-fail: init-time enforcement (net-4 completion)

The removed-client hard-fail (`UnsupportedClientError`) fires wherever
`clientInfo` is present — request boundaries today (`ctx_doctor`/`ctx_upgrade`).
At MCP init, `src/server.ts`'s `getClientVersion()` is `undefined`
(connect-then-sync timing), so init does NOT hard-fail today; a removed client
degrades until its first tool call. Phase-3 Task 7's review and Task 11's
PARTIAL both flagged this. Completion = await initialization in `main()` so the
throw lands at boot, plus a source-contract test pinning the boot-path rethrow
against regression to a bare `catch {}`. Behavior change → its own small plan.

## C. deps-heal `|` residual (co-dependent defense)

`hooks/deps-heal.mjs`'s `SAFE_RANGE` keeps `|` (legitimate semver OR, `1||2`).
On an unpatched Node (CVE-2024-27980, fixed only in 18.20.2/20.12.2/21.7.3)
`|` is a pipe primitive, so the whitelist and `execFileSync(shell:false)` are
co-dependent for that one character — neither alone is complete. Not a live
vuln (the range comes from the plugin's own `package.json`, and patched Node
neutralizes it). Optional hardening: parse the range with a real semver
library and reject anything that isn't a valid range, retiring the regex.

## D. orphan-reaper msys path form

`hooks/orphan-reaper.mjs`'s `isReapable` matches native `C:\` paths. A
Cygwin/msys `/c/...` CommandLine would not match — harmless because
`Win32_Process` emits native drive-form paths, never the msys form. Recorded
for completeness; no action unless a future Node build reports msys paths.

## E. Scan allowlist tightening

`scripts/assert-no-removed-platforms.mjs` has two `needle: /.*/` (file-wide)
allowlist entries — `src/adapters/client-map.ts` and
`tests/core/package-exports.test.ts`. Both are "the literals ARE the guard"
files (a denylist and a regression fixture whose whole content is removed-
adapter names), so file-wide is defensible. If either grows non-fixture
content, tighten to a `linePattern`.

## F. The `f*.tmp` root cause

`.gitignore` now ignores `*.tmp`, so the `f0/f1/f2.tmp` crumbs no longer
threaten commits. But some test still writes them cwd-relative on every run.
Root-cause the writing test and redirect it to a temp dir.

## G. `postinstall.mjs` static-import fragility (upstream defect)

`scripts/postinstall.mjs` statically imports from
`scripts/heal-installed-plugins.mjs`. If that sibling is absent at install
time, the static import throws before any `try/catch`, killing `npm install`.
Observed during phase-3 Task 3b (the asymmetric-drift test stages a stub).
A defensive dynamic import (`try { await import(...) } catch {}`) would make
the heal truly best-effort. Predates the fork; out of phase-3/4 scope.

## H. `prune-versions` / `lock-heal` / `cache-heal` absorption

Phase-4 absorbed deps-heal and orphan-reaper (spec §9.0's two named targets).
The other user-level heal hooks were out of scope:
- `cache-heal` — already handled by `start.mjs`'s `healScript` template
  (phase-3 Task 3), regenerated every boot; nothing to absorb.
- `lock-heal` (`.in_use` zombie-PID cleanup) and `prune-versions` — still
  user-level only. Absorb if a rename or cache-layout change breaks them, on
  the same "derive the cache parent, don't hardcode the marketplace" pattern
  deps-heal/orphan-reaper use.

## Not deferred — resolved elsewhere (recorded so they aren't re-opened)

- suppression cluster (`isInProcessPluginPlatform` etc.) — **deleted** in
  phase-3 Task 10 (adjudicated CLEAN by the collision review). Not dead code
  to remove; it is gone.
- `package.json` `main`/`exports` deleted-opencode path — **fixed** in phase-4
  Task 1 (`97f82c0`, repointed at `server.bundle.mjs`).
- product-copy DEFERRED tier (~712 mentions) — **closed** in the 2026-07-11
  product-copy pass (`121300f`); only `tests/fixtures/playwright-snapshot.txt`
  remains as a captured external fixture.
