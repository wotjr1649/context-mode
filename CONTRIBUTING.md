# Contributing

This repository is a personal **hard fork** of
[`mksglu/context-mode`](https://github.com/mksglu/context-mode), maintained for
private use. Its scope is deliberately narrow: it supports **only two clients,
Claude Code and Codex**, and it does not merge upstream — changes are read and
ported selectively.

**Improvements to the upstream project itself belong upstream.** Open pull
requests and issues for the original project at
[`mksglu/context-mode`](https://github.com/mksglu/context-mode); they reach every
downstream, this fork included.

**Out of scope here:** anything about the 16 removed platform integrations.
A request to restore a removed client, or a bug report against one, is closed as
out of scope — the removal is intentional and enforced by
`scripts/assert-no-removed-platforms.mjs`, which fails the build if a removed
identifier re-enters the source, configs, docs, or product copy.

## Build

```bash
npm install
npm run build     # tsc → 7 esbuild bundles → assert-bundle → asymmetric-drift → removed-platform scan
git config core.hooksPath .githooks   # once per clone — installs the bundle-freshness pre-commit guard
```

`tsc` compiles `src/` → `build/`; `start.mjs` loads the committed
`server.bundle.mjs`. Run `npm run build` end-to-end before any commit that
touches `src/`: the committed bundles ship as-is, and the pre-commit guard
rejects a stale bundle.

## Test

Run the suite with a capped heap and a single worker — an uncapped run has
caused out-of-memory crashes:

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
```

`npm run typecheck` runs the type check alone. Follow test-driven development:
write a failing test first, make it pass, then refactor.

## License

By contributing you agree that your contributions are licensed under the
[Elastic License 2.0](LICENSE), the same terms as upstream.
