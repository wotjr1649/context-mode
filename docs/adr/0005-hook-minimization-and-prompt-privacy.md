# ADR-0005 — Default hook minimization and prompt-capture privacy

- **Status**: Accepted
- **Date**: 2026-07-15
- **Release**: v1.0.3
- **Scope**: `deps-heal.mjs`, `orphan-reaper.mjs`, `UserPromptSubmit` (Codex + Claude Code)

## Context

A maintainer audit reviewed whether three hooks should keep firing on every
default session:

1. **`deps-heal.mjs`** (Claude SessionStart) — detects a partial plugin
   dependency install, then `rmSync`-deletes a `node_modules` subtree and runs
   `npm install`. It is well hardened (`shell:false`, node → `npm-cli.js` never
   `.cmd`, `--ignore-scripts`, a traversal guard, a 45s budget under the ~60s
   host timeout). The problem is placement, not correctness: it arms
   file-deletion + package-install authority on *every* interactive start for a
   defect that only occurs at plugin **auto-update** — an install-time event
   already owned by `scripts/postinstall.mjs` and by explicit `ctx doctor` /
   `ctx upgrade`. The Codex half of the plugin already ships with no deps-heal.

2. **`orphan-reaper.mjs`** (Claude SessionStart) — on Windows it enumerates the
   **entire process table** (PowerShell `Get-CimInstance Win32_Process`) on
   every start, *before* the arm check, then only kills when
   `CONTEXT_MODE_REAPER_ARMED=1`. The default (dry-run) therefore pays the full
   scan cost for zero effect. The root cause of orphaned processes was already
   fixed by `flushAndExit` (session-helpers); the reaper is a self-described
   "safety net" for an already-fixed bug. (Its dry-run log is clean — timestamps,
   counts, PIDs only, to a file, never the model context or `CommandLine`.)

3. **`UserPromptSubmit`** — both platforms stored the **full raw prompt**,
   unredacted, into local SQLite (`session_events.data`). This violates the
   project's own standard, which already redacts `tool_input` before it touches
   SQLite ("under-redaction is a credential leak to SessionDB",
   `src/session/extract.ts`). The remote "platform wire" is *not* the primary
   exposure — it is opt-in (`platform.json`) and already redacts+truncates; the
   leak is the always-on local copy. The documented contracts also disagreed:
   Codex `AGENTS.md` said "user-prompt history not available" while the shipped
   Codex hook captured it anyway, and Claude `CLAUDE.md` advertised prompt
   search.

**Incident separation.** This audit was prompted by an `invalid_id_prefix`
error seen via a `codex://threads` deep link. That error originated in a
**user-global custom subagent-lifecycle hook**, not in ctxscribe. ctxscribe did
**not** cause `invalid_id_prefix`, and this release does not claim to fix it.
ctxscribe's `Stop` hook (turn-end continuity capture) is unrelated to the native
subagent-stop hooks involved in that incident and is retained unchanged.

## Decision

- **deps-heal — removed from default SessionStart.** The `hooks/deps-heal.mjs`
  script and its security unit tests are retained as the manual/explicit-repair
  contract; `postinstall` + `ctx doctor`/`ctx upgrade` remain the owners of
  dependency healing. No package delete/install happens on a normal start.

- **orphan-reaper — removed from default SessionStart.** The script, its
  env-armed kill gate, and its safety tests (never kill a dev node/vitest, self
  and ancestor protection, cache-root prefix match) are retained for explicit
  opt-in use. No process enumeration happens on a normal start.

- **UserPromptSubmit / Codex — unregistered by default.** Honors the AGENTS.md
  contract. Removed from `generateHookConfig()`, `.codex-plugin/hooks.json`, and
  the `configs/codex/hooks.json` template. `configureAllHooks()` actively
  **purges** a stale 1.0.2 entry (often a broken plugin-cache path) from an
  existing user's `~/.codex/hooks.json` on upgrade (`REMOVED_CODEX_HOOKS`);
  `CODEX_HOOK_COMMANDS` / `LEGACY_HOOK_PATH_SUFFIXES` keep the key so the purge
  can recognize it. `ctxscribe hook codex userpromptsubmit` still dispatches for
  back-compat but is gated (below).

- **UserPromptSubmit / Claude Code — kept, but raw capture is OFF by default.**
  The hook still runs and still extracts the structured decision / role / intent
  events that power continuity. The **verbatim** prompt row is only stored when
  `CONTEXT_MODE_PROMPT_CAPTURE=1`.

- **Boundary redaction.** Both hooks now scrub secrets at the input boundary
  (`redactSecretText`, reusing the wire's `SECRETS` patterns) so *no*
  prompt-derived event — structured or the opt-in raw row — can carry a verbatim
  API key / token / PII into SQLite. This is best-effort (regex misses some
  classes, e.g. AWS secret keys, Google, Stripe, connection strings, PEM), which
  is exactly why the safe default is capture-off.

## Consequences

- **Privacy by default.** A fresh install stores no raw prompts on either
  platform; the `source: "user-prompt"` search returns nothing until a Claude
  user opts in. Structured continuity is unaffected.
- **Opt-in.** `CONTEXT_MODE_PROMPT_CAPTURE=1` re-enables raw capture (Claude);
  even then the prompt is redacted before storage. Remote forwarding stays a
  separate opt-in (`platform.json`) and remains redacted.
- **Migration.** Prompts stored by ≤1.0.2 remain in existing per-project DBs
  until their session ages out (`cleanupOldSessions(7)`, lazy) — no destructive
  auto-migration is performed. Users wanting immediate removal run `ctx purge`.
  Standalone Codex upgraders have their stale UserPromptSubmit hook entry removed
  on the next `ctxscribe setup`/upgrade.
- **Intended platform difference (pinned by tests).** Claude Code keeps
  UserPromptSubmit (opt-in raw capture); Codex does not register it. This is a
  deliberate contract difference, not drift — see
  `tests/hooks/default-hook-registration.test.ts` and `tests/adapters/codex.test.ts`.
- **Doctor/upgrade.** No health check flags the removed hooks: Claude validates
  only PreToolUse/SessionStart; Codex derives its expected set from
  `generateHookConfig()`, which no longer lists UserPromptSubmit. Normalizers and
  cache-integrity checks are non-additive and never re-inject.
- **Core hooks unchanged.** PreToolUse, PostToolUse, SessionStart (core),
  PreCompact, and Stop keep their existing behavior on both platforms.
