# Phase 6 release runbook — deploy 1.0.1 and verify I1

**This is a user-run procedure.** It is the only path that deploys the phase-3/4
code (deletions, runtime hard-fail, absorbed hooks) to a live install, and the
only empirical test of hypothesis **I1** — that the plugin `version` string is
the reinstall key. Nothing in this file runs automatically; run each step
yourself and stop if a gate fails.

Prefix a command with `! ` in the Claude Code prompt to run it in-session
(e.g. an interactive login), or run it in a terminal.

## Preconditions (all must hold before you start)

- Local `HEAD` is the 1.0.1 tree and is **ahead** of `origin/main` by the phase-5/6 prep commits (plan, verify-deploy, runbook, 1.0.1 bump) — all unpushed; Step 1 pushes them. (Phases 1–4 were already pushed.)
- `git ls-remote --tags origin` shows exactly `v1.0.0` (phase 5 gate).
- `git tag` locally shows exactly `v1.0.0`.
- Working tree clean; full capped suite failures ⊆ the 6 pre-existing environmental (executor×3 Python-absent, integration×2 node-e-deny, run-hook×1).
- `package.json` version == `1.0.1`, and the 3 manifests match (phase-6a Task 5 did this).

## Step 1 — push the 1.0.1 commit and its tag

```
git push origin main
git tag -a v1.0.1 -m "context-mode-js 1.0.1 — phase 3/4 code (deletions, hard-fail, absorbed hooks)"
git push origin refs/tags/v1.0.1
```

- `v1.0.1` is created HERE (not in phase-6a) and points at the 1.0.1 bump commit — the tree that actually ships.
- `git push origin refs/tags/v1.0.1` pushes **only** that tag. **Never `git push origin --tags`** — it would re-flood the 198 upstream tags you just removed.
- Verify: `git ls-remote --tags origin` → exactly `v1.0.0` and `v1.0.1`, nothing else.

## Step 2 — lightweight cutover (Claude Code)

No uninstall, no restart-kill. The version bump is the reinstall trigger (that is the I1 claim under test):

```
/plugin marketplace update context-mode-js
/plugin update context-mode@context-mode-js
```

Then restart Claude Code normally.

## Step 3 — Codex cutover

```
codex plugin marketplace upgrade context-mode
```

(Codex keys off the marketplace SHA, so `upgrade` re-pulls regardless of the version string. The catalog name stays `context-mode`.)

## Step 4 — verify the deploy (the I1 test)

```
node scripts/verify-deploy.mjs 1.0.1
```

- **PASS (exit 0):** the DEPLOYED tree at the active `installPath` reports `1.0.1` in its own `package.json` (verify-deploy reads the deployed code, not just the directory name — a stale/empty `1.0.1/` dir does not fool it). **I1 confirmed** — the version string reinstall-keyed the deploy. Every future release is a bump + push + `/plugin update`.
- **FAIL (exit 1):** the deployed tree still reports `1.0.0`, or the `1.0.1` dir is empty/half-installed (no readable `package.json`). **I1 refuted** (or the reinstall was incomplete) — a version bump alone did NOT land the new code under the renamed marketplace. Do NOT keep bumping; the reinstall mechanism must be redesigned (a full cutover like phase 2, or a cache-dir intervention). Record the observation and stop.
- **FATAL (exit 2):** `installed_plugins.json` unreadable, or no `<expectedVersion>` argument given — check `CLAUDE_CONFIG_DIR` / that Claude Code has run at least once since the update.

## Step 5 — smoke test (both adapters)

The point is that the phase-3/4 code actually runs, not just installs. In a fresh session of each:

- **Claude Code:** `ctx_execute` (a trivial `console.log`), `ctx_search` (any query), `ctx_fetch_and_index` (any URL — proves the WebFetch→`ctx_fetch_and_index` PreToolUse redirect, i.e. the hooks, are live). Each returns without error.
- **Codex:** same three, in a Codex session.
- Bonus (net-4 proof): if you have a way to send an unsupported `clientInfo.name`, it should hard-fail at a request boundary (`UnsupportedClientError`) rather than silently degrade — but this is not required for release.

## Rollback — if Step 4 FAILs or Step 5 breaks

The old `1.0.0` cache tree persists (rollback window ≈ 7 days before orphan-cache auto-prune, F48). Roll back to `1.0.0`:

1. Hand-edit `package.json` version back to `1.0.0`; run `node scripts/version-sync.mjs`; commit.
2. `git push origin main`
3. `/plugin marketplace update context-mode-js` then `/plugin update context-mode@context-mode-js`; restart.
4. `node scripts/verify-deploy.mjs 1.0.0` → PASS.

The `v1.0.1` tag can stay (it is harmless history) or be removed with `git push origin :refs/tags/v1.0.1` + `git tag -d v1.0.1`. The `.superpowers/sdd/tags.snapshot` still holds the original 198 if a deeper restore is ever needed (individual re-creation only — never `push --tags`).

## What this does NOT change

- Neither `1.0.0` nor `1.0.1` alters the installed BYTES until `/plugin update` runs — the deploy is what ships, the bump is just its key.
- `~/.claude/hooks/*` user-level heals keep working throughout; the absorbed repo copies (`hooks/deps-heal.mjs`, `hooks/orphan-reaper.mjs`) only take over once this deploy lands. `orphan-reaper` ships inert (needs `CONTEXT_MODE_REAPER_ARMED=1`).
