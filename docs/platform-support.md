# Platform Support Matrix

This document describes the platforms supported by ctxscribe — a hard fork that supports **Claude Code** and **Codex CLI** only — including their hook paradigms, capabilities, configuration, and known limitations.

## Overview

ctxscribe supports two client platforms, both on the same hook paradigm:

| Paradigm | Platforms |
|----------|-----------|
| **JSON stdin/stdout** | Claude Code, Codex CLI |

The MCP server layer is 100% portable and needs no adapter. Only the hook layer requires platform-specific adapters, and both supported platforms share the JSON stdin/stdout wire protocol.

## Prerequisites

Codex CLI requires a global install; Claude Code can use either the plugin install (Claude plugin registry) or the global binary:

```bash
npm install -g wotjr1649/ctxscribe
```

ctxscribe is distributed from GitHub, not the npm registry, so the install uses npm's `owner/repo` shorthand instead of a package name.

This puts the `ctxscribe` binary in PATH, which is required for:
- **MCP server:** `"command": "ctxscribe"` (replaces ephemeral `npx -y ctxscribe`)
- **Hook dispatcher:** `ctxscribe hook <platform> <event>` (replaces `node ./node_modules/...` paths)
- **Utility commands:** `ctxscribe doctor`, `ctxscribe upgrade`
- **Persistent upgrades:** `ctx-upgrade` updates the global binary in-place

---

## Main Comparison Table

| Feature | Claude Code | Codex CLI |
|---|---|---|
| **Paradigm** | json-stdio | json-stdio |
| **PreToolUse equivalent** | `PreToolUse` | `PreToolUse` |
| **PostToolUse equivalent** | `PostToolUse` | `PostToolUse` |
| **PreCompact equivalent** | `PreCompact` | `PreCompact` (runtime-gated) |
| **SessionStart** | `SessionStart` | `SessionStart` |
| **Stop equivalent** | -- | `Stop` |
| **Can modify args** | Yes | No |
| **Can modify output** | Yes | No |
| **Can inject session context** | Yes | Yes |
| **Can block tools** | Yes | Yes |
| **Config location** | `~/.claude/settings.json` | `~/.codex/hooks.json` + `~/.codex/config.toml` |
| **Session ID field** | `session_id` | N/A |
| **Project dir env** | `CLAUDE_PROJECT_DIR` | N/A |
| **MCP/tool naming** | `mcp__server__tool` | `mcp__server__tool` |
| **Hook command format** | `ctxscribe hook claude-code <event>` | `ctxscribe hook codex <event>` |
| **Hook registration** | settings.json hooks object | `~/.codex/hooks.json` |
| **MCP server command** | `ctxscribe` (or plugin auto) | `ctxscribe` |
| **Plugin distribution** | Claude plugin registry | npm global |
| **Session dir** | `~/.claude/ctxscribe/sessions/` | `~/.codex/ctxscribe/sessions/` |

### Legend

- Yes = Fully supported
- -- = Not supported

---

## Platform Details

### Claude Code

**Status:** Fully supported (primary platform)

**Hook Paradigm:** JSON stdin/stdout

Claude Code is the primary platform for ctxscribe. All hooks communicate via JSON on stdin/stdout. The adapter reads raw JSON input, normalizes it into platform-agnostic events, and formats responses back into Claude Code's expected output format.

**Hook Names:**
- `PreToolUse` -- fires before a tool is executed
- `PostToolUse` -- fires after a tool completes
- `PreCompact` -- fires before context compaction
- `SessionStart` -- fires when a session starts, resumes, or compacts
- `UserPromptSubmit` -- fires when user submits a prompt
- `Stop` -- fires when the assistant turn is about to end

**Blocking:** `permissionDecision: "deny"` in response JSON

**Arg Modification:** `updatedInput` field at top level of response

**Output Modification:** `updatedMCPToolOutput` for MCP tools, `additionalContext` for appending

**Session ID Extraction Priority:**
1. UUID from `transcript_path` field
2. `session_id` field
3. `CLAUDE_SESSION_ID` environment variable
4. Parent process ID fallback

**Hook Commands:**
```
ctxscribe hook claude-code pretooluse
ctxscribe hook claude-code posttooluse
ctxscribe hook claude-code precompact
ctxscribe hook claude-code sessionstart
ctxscribe hook claude-code userpromptsubmit
```

**Known Issues:** None significant.

---

### Codex CLI

**Status:** Supported (MCP active, hooks require `[features].hooks = true`)

**Hook Paradigm:** JSON stdin/stdout

Codex CLI's Rust backend (codex-rs) includes a hook system using the same JSON stdin/stdout wire protocol as Claude Code. Hooks are configured via `hooks.json`.

**Hook Names:**
- `PreToolUse` -- fires before a tool is executed
- `PostToolUse` -- fires after a tool completes
- `PreCompact` -- fires before context compaction on Codex builds that emit it
- `SessionStart` -- fires when a session starts, resumes, or clears
- `UserPromptSubmit` -- fires when user submits a prompt
- `Stop` -- fires when agent turn ends (can continue with followup)

**Blocking:** `permissionDecision: "deny"` in hookSpecificOutput, or exit code 2
**Arg Modification:** NOT supported (updatedInput returns error)
**Output Modification:** NOT supported (updatedMCPToolOutput returns error)
**Context Injection:** `additionalContext` in hookSpecificOutput (PostToolUse, SessionStart only). PreToolUse does NOT support `additionalContext` — the codex formatter handles this automatically (deny works, context/modify/ask responses are dropped).

**Configuration:**
- Hook config: `$CODEX_HOME/hooks.json` or `~/.codex/hooks.json` (JSON format, same structure as Claude Code)
- MCP config: `$CODEX_HOME/config.toml` or `~/.codex/config.toml` (TOML format, `[mcp_servers]` section)
- Feature flags: use `[features].hooks` (or `codex --enable hooks`) if you need
  to force hooks on. Prefer `[features].hooks`; `[features].codex_hooks` remains
  accepted as a legacy alias in current Codex builds.

**Hook Commands:**
```
ctxscribe hook codex pretooluse
ctxscribe hook codex posttooluse
ctxscribe hook codex precompact
ctxscribe hook codex sessionstart
ctxscribe hook codex stop
```
> **UserPromptSubmit is intentionally not registered on Codex (v1.0.3).** Codex
> CLI emits the event, but ctxscribe does not capture raw user-prompt history
> here (see `configs/codex/AGENTS.md`). The `ctxscribe hook codex userpromptsubmit`
> subcommand still dispatches for back-compat but is off by default; Claude Code
> keeps it as opt-in raw capture (`CONTEXT_MODE_PROMPT_CAPTURE=1`).

**Known Issues / Caveats:**
- PreToolUse `additionalContext` is unsupported — context injection works via PostToolUse and SessionStart instead. The codex formatter handles this automatically (deny works, context is dropped). Source: `codex-rs/hooks/src/engine/output_parser.rs:267`.
- PreToolUse input rewriting still needs upstream `updatedInput` support. Track: [openai/codex#18491](https://github.com/openai/codex/issues/18491).
- PreCompact support is runtime-gated: ctxscribe configures it and treats a missing registration as a warning, because older Codex builds may not emit the event. The hook stores the resume snapshot out-of-band and SessionStart restores it.
- Codex emits structured tool names such as `Bash` and `apply_patch`; ctxscribe only normalizes legacy shell aliases.
- updatedInput and updatedMCPToolOutput are in the schema but NOT implemented
- Default hook timeout: 600 seconds
- **Historical (pre-rename) — names below are the OLD identity on purpose.** Releases
  made before the ctxscribe rename used a `plugins/context-mode -> ..` symlink shim
  because Codex rejects the repository root (`"./"`) as an empty local plugin
  source path. On native Windows, Git can check that symlink out as a regular
  file containing only `..`, which made the then-current `codex plugin add context-mode@context-mode`
  fail with `missing plugin.json`. Current releases avoid this by declaring the
  Codex marketplace plugin as a relative Git source (`url: "./"`), so Codex
  materializes the installed marketplace root and finds `.codex-plugin/plugin.json`
  without any symlink or junction. `tests/codex/marketplace-layout.test.ts` keeps a
  regression guard on the OLD `plugins/context-mode` path — the shim predates the
  rename, so only that name can ever come back (via a revert or an upstream port).
  Install today with `codex plugin marketplace add wotjr1649/ctxscribe` (see README).

  After installation succeeds, verify that Codex hooks are enabled in
  `%USERPROFILE%\.codex\config.toml`:

  ```toml
  [features]
  hooks = true
  ```

  Some Codex builds may also require `plugin_hooks = true`. Without hook support,
  the MCP tools can still work, but automatic session capture and persistent
  memory may not record events.

---

## Capability Matrix (Quick Reference)

| Capability | Claude Code | Codex CLI |
|-----------|:-----------:|:---------:|
| PreToolUse | Yes | Yes* |
| PostToolUse | Yes | Yes |
| PreCompact | Yes | Yes** |
| SessionStart | Yes | Yes |
| Stop | -- | Yes |
| Modify Args | Yes | -- |
| Modify Output | Yes | -- |
| Inject Context | Yes | Yes |
| Block Tools | Yes | Yes |
| MCP/native tool support | Yes | Yes |

\* Codex CLI PreToolUse supports deny only (no `additionalContext`); context injection works via PostToolUse and SessionStart
\*\* Codex CLI PreCompact is runtime-gated on builds that emit the event

---

## Hook Response Format Comparison

### Blocking a Tool

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "permissionDecision": "deny", "reason": "..." }` |
| Codex CLI | `{ "hookSpecificOutput": { "permissionDecision": "deny" } }` or exit code 2 |

### Modifying Tool Input

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "updatedInput": { ... } }` |
| Codex CLI | N/A (updatedInput in schema but not implemented) |

### Injecting Additional Context (PostToolUse)

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "additionalContext": "..." }` |
| Codex CLI | `{ "hookSpecificOutput": { "additionalContext": "..." } }` |

---

## CLI Hook Dispatcher

Both hook-based platforms use the CLI dispatcher pattern instead of direct `node` paths:

```
ctxscribe hook <platform> <event>
```

The dispatcher resolves the hook script relative to the installed package and dynamically imports it. Stdin/stdout flow through naturally since it runs in the same process.

**Advantages over `node ./node_modules/...` paths:**
- Works from any directory (no per-project `npm install` needed)
- Single global install serves all projects
- `ctxscribe upgrade` updates hooks in-place
- Short, portable command strings in settings files

**Supported dispatches:**

| Platform | Events |
|----------|--------|
| `claude-code` | `pretooluse`, `posttooluse`, `precompact`, `sessionstart`, `userpromptsubmit` |
| `codex` | `pretooluse`, `posttooluse`, `precompact`, `sessionstart`, `userpromptsubmit`, `stop` |

---

## SQLite Backend Selection

ctxscribe automatically selects the best SQLite backend at runtime based on the environment:

| Priority | Condition | Backend | Why |
|----------|-----------|---------|-----|
| 1 | Bun runtime | `bun:sqlite` | Built-in, no native addon |
| 2 | Linux + Node.js >= 22.5 | `node:sqlite` | Built-in, avoids [SIGSEGV from V8 madvise bug](https://github.com/nodejs/node/issues/62515) |
| 3 | All other environments | `better-sqlite3` | Mature native addon, prebuilt binaries |

**Why node:sqlite on Linux?** Node.js's V8 garbage collector can call `madvise(MADV_DONTNEED)` on memory ranges that overlap `better-sqlite3`'s native addon `.got.plt` section, corrupting resolved symbol addresses and causing sporadic SIGSEGV crashes (1-4/hour on Node v22-v24). `node:sqlite` is compiled into the Node.js binary itself — no separate `.node` file, no `dlopen()`, no `.got.plt` to corrupt.

**Fallback:** If `node:sqlite` is unavailable (Node < 22.5), ctxscribe silently falls back to `better-sqlite3`. No user configuration needed.

**Override:** Not currently supported — backend selection is automatic. If you need to force a specific backend, open an issue.

---

## Utility Commands

Both platforms support utility commands via MCP meta-tools:

| Command | What it does |
|---------|-------------|
| `ctx stats` | Show context savings, call counts, and session statistics |
| `ctx doctor` | Diagnose installation: runtimes, hooks, FTS5, versions |
| `ctx upgrade` | Update from GitHub, rebuild, reconfigure hooks |
| `ctx purge` | Permanently deletes all indexed content from the knowledge base |

**How they work:** The MCP server exposes `stats`, `doctor`, `upgrade`, and `purge` tools. The `<ctx_commands>` section in routing instructions (CLAUDE.md, AGENTS.md) maps natural language triggers to MCP tool calls. The `doctor` and `upgrade` tools return shell commands that the LLM executes and formats as a checklist. The `purge` tool permanently deletes all indexed content from the knowledge base and is the sole reset mechanism.
