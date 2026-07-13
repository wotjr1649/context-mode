# ctxscribe

> ### ⚠️ This is a modified fork
>
> This repository is a **modified fork** of [mksglu/context-mode](https://github.com/mksglu/context-mode),
> maintained for personal use. It is **not** the upstream project and is not affiliated with it.
>
> **Modifications vs upstream:**
> - `hooks/`: entry points now exit explicitly after writing their response, fixing a
>   Windows orphan-process leak ([nodejs/node#22999](https://github.com/nodejs/node/issues/22999)).
>   Also submitted upstream as [mksglu/context-mode#937](https://github.com/mksglu/context-mode/pull/937).
>
> Licensed under the Elastic License 2.0, the same terms as upstream — see [LICENSE](LICENSE).

ctxscribe is an MCP server that keeps large tool output out of the model's
context window: it runs commands and code in a sandbox, indexes the output into
a local FTS5 knowledge base, and returns only what a search matches. The model
receives the answer, not the raw bytes.

## This fork

A personal **hard fork** of [`mksglu/context-mode`](https://github.com/mksglu/context-mode).
It tracks upstream by reading and porting changes selectively — never by
merging — and it deliberately supports **only two clients: Claude Code and
Codex**.

- **16 other platform integrations were removed.** Only the Claude Code and
  Codex adapters remain (`src/adapters/claude-code/`, `src/adapters/codex/`).
- **Unsupported clients hard-fail.** A 24-name denylist in
  `src/adapters/client-map.ts` raises an explicit error for a removed client
  rather than silently degrading it to Claude Code.
- **No upstream infrastructure is called.** No CDN purge, no shared status
  badges, no automated links or sponsorship funnels to the upstream project.
  (Editorial pointers back to the original project are kept, by policy — see below.)
- **`private: true`.** This fork is not published to npm; it installs from this
  repository through the plugin marketplaces below.

A permanent guard — `scripts/assert-no-removed-platforms.mjs`, run on every
build — fails the build if any removed-platform identifier re-enters the source,
configs, docs, or product copy.

## Install

Requires Node.js >= 22.5 (or [Bun](https://bun.sh)). On Linux, Node.js below
22.5 without Bun is unsupported — the doctor check reports it as a hard failure.

### Claude Code

The fork ships under its own marketplace name, `wotjr1649`, so its plugin cache
stays isolated from upstream's (sharing a cache parent would let upstream's
higher version win).

```
/plugin marketplace add wotjr1649/ctxscribe
/plugin install ctxscribe@wotjr1649
```

Restart Claude Code, then verify with `/ctxscribe:ctx-doctor`.

### Codex

Codex resolves plugins by commit SHA. The fork's catalog name is `ctxscribe`.
Add the fork's marketplace:

```
codex plugin marketplace add wotjr1649/ctxscribe
```

Enable the plugin hooks in `~/.codex/config.toml`:

```toml
[features]
hooks = true
# Some Codex builds also require the line below for plugin-provided hooks:
plugin_hooks = true
```

Restart Codex and verify with `ctx stats`. The plugin provides its MCP server,
hooks, and skills from `.codex-plugin/`; the server self-identifies through
`CONTEXT_MODE_PLATFORM=codex`. To pull a newer commit of the fork later, run
`codex plugin marketplace upgrade ctxscribe`. The fork's catalog is a separate
marketplace from upstream's, so an existing upstream Codex install is left
untouched — remove it separately if you no longer want it.

The plugin's PreToolUse hook (from `.codex-plugin/hooks.json`) intercepts the
context-flooding tools before they run — this matcher is kept in sync with the
adapter constant in `src/adapters/codex/index.ts`:

```json
"PreToolUse": [{ "matcher": "local_shell|shell|shell_command|exec_command|Bash|Shell|apply_patch|Edit|Write|grep_files|ctx_execute|ctx_execute_file|ctx_batch_execute|ctx_fetch_and_index|ctx_search|ctx_index|mcp__", "hooks": [{ "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/codex/pretooluse.mjs\"" }] }]
```

## Development

```bash
npm install
npm run build     # tsc → 7 esbuild bundles → assert-bundle → asymmetric-drift → removed-platform scan
git config core.hooksPath .githooks   # once per clone — installs the bundle-freshness pre-commit guard
```

Run the test suite with a capped heap and a single worker (an uncapped run has
caused out-of-memory crashes):

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
```

Always run `npm run build` before committing a change under `src/`: the
committed bundles ship as-is, and the pre-commit guard rejects a stale bundle.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. Improvements to the
original project belong upstream at
[`mksglu/context-mode`](https://github.com/mksglu/context-mode).

## License

[Elastic License 2.0](LICENSE) — the same terms as upstream. Copyright 2026 Mert Koseoglu.
