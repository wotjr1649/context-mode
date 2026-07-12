# ctxscribe Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-identify the ELv2 fork from `context-mode`/`context-mode-js` to `ctxscribe`/`wotjr1649` across both Claude Code and Codex, keeping the codebase, ELv2 attribution, and the `ctx_*` tool surface.

**Architecture:** Rule-based identity substitution verified by a new `assert-identity-clean` grep gate (the completeness guarantee — built FIRST as the failing "test"). Rename proceeds subsystem-by-subsystem; each task drives the gate count down and ends green on build + relevant tests. Deploy/migration is a final approval-gated task. Spec: `docs/superpowers/specs/2026-07-13-ctxscribe-rename-design.md`.

**Tech Stack:** Node.js ESM, TypeScript (`src/`), esbuild bundles, vitest, Claude Code + Codex plugin manifests, SQLite/FTS5.

**Review status:** v2 — 2 Claude plan-review subagents applied (gate false-clean/false-fail fixed, `assert-asymmetric-drift` ordering fixed, `skills/` scope added, sentinel couplings + branch step added). Codex cross-review was launched but hung (~1h20m, log-silent ~60m) and was cancelled — no Codex findings folded.

## Global Constraints

- **Identity map** (spec §2): plugin/pkg/bin `context-mode`→`ctxscribe`; marketplace `context-mode-js` & Codex `context-mode`→`wotjr1649`; key→`ctxscribe@wotjr1649` (**plugin@marketplace**); MCP server key→`mcp`; Claude prefix→`plugin_ctxscribe_mcp`; repo→`wotjr1649/ctxscribe`; skill ns→`ctxscribe:`; active data-dir→`ctxscribe/`; version→**1.0.0**.
- **NEVER touch (spec §4b invariants):** `CONTEXT_MODE_*` env-var NAMES (uppercase — never matched by the gate's case-sensitive grep anyway); any `mksglu/context-mode`; `registry.npmjs.org/context-mode`; `assert-no-upstream-mksglu.mjs` needles; `.claude-plugin/plugin.json` `author.url` (`github.com/mksglu`); `context-mode-ops` in credits; `docs/UPSTREAM-CREDITS.md`; legacy home dot-dir `~/.context-mode` (`server.ts:628/4355`, `platform-bridge.mjs:38`); the `context-mode-cache-heal` OLD hook name where `start.mjs` cleans it up (N1).
- **`ctx_*` tool names + `ctx-*` skill sub-names stay.**
- **Bundles:** any `src/` edit → `npm run build`; `.githooks/pre-commit` enforces bundle drift 0. Commit source + regenerated bundles together.
- **Tests (capped, OOM guard):** `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 <path>`. Baseline = **6 known pre-existing failures**. Acceptance = **no NEW failures**.
- **`node -e`/`node -p` are DENY-listed** — never put them in a step; use `node --check <file>` or a `.mjs` one-off.
- **No git tag `v1.0.0`** (exists in context-mode lineage); never `git push origin --tags`. Deploy/migration = **approval-gated**.
- **Branch:** all work on `spec/ctxscribe-rename` (already created off `main`; verify with `git branch --show-current` before Task 1).

---

### Task 0: Confirm branch

- [ ] **Step 1: Verify the working branch**

Run: `git branch --show-current`
Expected: `spec/ctxscribe-rename`. If it prints `main`, run `git checkout spec/ctxscribe-rename` (the branch already exists with the committed spec). Do NOT commit rename work to `main`.

---

### Task 1: Build the `assert-identity-clean` completeness gate (the measuring stick)

**Files:**
- Create: `scripts/assert-identity-clean.mjs`

**Interfaces:**
- Produces: `node scripts/assert-identity-clean.mjs` → exits 0 if no functional identity token remains, else exits 1 and prints `file:line` offenders. Every later task uses it to verify its delta.

- [ ] **Step 1: Write the gate script**

```js
// scripts/assert-identity-clean.mjs
// Fails if any FUNCTIONAL context-mode / context-mode-js identity token remains
// outside the spec §4b whitelist. The rename's completeness guarantee.
//
// NOTE: the grep is CASE-SENSITIVE for "context-mode" (lowercase-hyphen), so
// CONTEXT_MODE_* env-var names (uppercase-underscore) are NEVER matched — no env
// whitelist is needed, and NONE must be added (a line-level CONTEXT_MODE_ whitelist
// would false-clean real targets that co-occur with an env var, e.g.
// routing.mjs `const CONTEXT_MODE_SUBSTRING = "context-mode"`).
import { execFileSync } from "node:child_process";

const SCAN = [
  "src", "hooks", "scripts", "configs", "bin", "skills",
  ".claude-plugin", ".codex-plugin", ".agents",
  "tests", "start.mjs", "package.json",
  ".mcp.json.example", ".mcp.json.codex.example",
];

// Lines that legitimately contain the lowercase token and MUST be kept (spec §4b).
const WHITELIST = [
  /mksglu\/context-mode/i,               // upstream attribution + D9 needle
  /registry\.npmjs\.org\/context-mode/i, // upstream npm needle
  /context-mode-ops/,                    // credits skill name
  /\.context-mode\b/,                    // legacy home dot-dir ~/.context-mode (NOT the data-dir "context-mode/")
  /context-mode-cache-heal/,             // N1: start.mjs legitimately retains the OLD hook name to clean it up
];
// Whole files that are pure attribution / generated — never scanned.
const SKIP_FILE = /(UPSTREAM-CREDITS\.md|\.bundle\.mjs$|assert-identity-clean\.mjs$|bun\.lock$)/;

let raw = "";
try {
  raw = execFileSync("git", ["grep", "-n", "-I", "-E", "context-mode(-js)?", "--", ...SCAN],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  if (e.status === 1 && !e.stdout) { console.log("assert-identity-clean: OK (0 refs)"); process.exit(0); }
  if (!e.stdout) throw e;            // real git error (128) → surface, do NOT false-clean
  raw = e.stdout;
}

const offenders = raw.split("\n").filter(Boolean).filter((line) => {
  const path = line.slice(0, line.indexOf(":"));
  if (SKIP_FILE.test(path)) return false;
  return !WHITELIST.some((re) => re.test(line));
});

if (offenders.length) {
  console.error(`assert-identity-clean: FAIL — ${offenders.length} functional identity ref(s) remain:`);
  console.error(offenders.slice(0, 200).join("\n"));
  if (offenders.length > 200) console.error(`… and ${offenders.length - 200} more`);
  process.exit(1);
}
console.log("assert-identity-clean: OK (0 functional refs)");
```

- [ ] **Step 2: Run it to establish the failing baseline**

Run: `node scripts/assert-identity-clean.mjs 2>&1 | head -1`
Expected: `FAIL — N functional identity ref(s) remain` (N large). This is the target to drive to 0.

- [ ] **Step 3: Sanity-check the whitelist retains invariants**

Run: `node scripts/assert-identity-clean.mjs 2>&1 | grep -iE "mksglu|\.context-mode|context-mode-ops|context-mode-cache-heal|registry\.npmjs" | head`
Expected: **no output** (invariants correctly whitelisted). Also confirm `routing.mjs` `CONTEXT_MODE_SUBSTRING` line IS listed as an offender (the trap must be caught):
Run: `node scripts/assert-identity-clean.mjs 2>&1 | grep -i "CONTEXT_MODE_SUBSTRING"`
Expected: one line (routing.mjs) — proving the env co-occurrence is NOT false-cleaned.

- [ ] **Step 4: Commit** (script only; not wired into build until Task 11)

```bash
git add scripts/assert-identity-clean.mjs
git commit -m "build(ctxscribe): add assert-identity-clean completeness gate"
```

---

### Task 2: Claude manifests + declarations + the drift-gate key

**Files:**
- Modify: `package.json` (`name`, `version`, `bin` key, `repository.url`, `homepage`, `bugs`)
- Modify: `.claude-plugin/marketplace.json` (`name`, `owner`, `plugins[].name`, `description`; remove `owner.email`)
- Modify: `.claude-plugin/plugin.json` (`name`, `mcpServers` key, `homepage`, `repository`)
- Modify: `.mcp.json.example` (`mcpServers` key)
- Modify: `scripts/assert-asymmetric-drift.mjs:45` (**the build gate that reads the server key**)

**Interfaces:**
- Produces: manifests declaring plugin `ctxscribe`, marketplace `wotjr1649`, server key `mcp`. Task 3's MCP prefix and the `assert-asymmetric-drift` gate depend on the `mcpServers` key being `mcp`.

- [ ] **Step 1: Edit `package.json`** — `"name": "ctxscribe"`, `"version": "1.0.0"`, `"bin": { "ctxscribe": "./cli.bundle.mjs" }`, and repoint `repository.url`/`homepage`/`bugs` from `wotjr1649/context-mode` to `wotjr1649/ctxscribe`.

- [ ] **Step 2: Edit `.claude-plugin/marketplace.json`** — top `"name": "wotjr1649"`; `owner` → `{ "name": "Kim Jae Seok" }` (DELETE the `email` line); `plugins[0].name` → `"ctxscribe"`; keep `description`/`keywords`/`category`.

- [ ] **Step 3: Edit `.claude-plugin/plugin.json`** — `"name": "ctxscribe"`; rename the `mcpServers` key `"context-mode"` → `"mcp"` (keep its `command`/`args`); repoint `homepage`/`repository`. **Leave `author.url` (`github.com/mksglu`) untouched.**

- [ ] **Step 4: Edit `.mcp.json.example`** — rename the `mcpServers` key `"context-mode"` → `"mcp"`.

- [ ] **Step 5: Fix the drift gate (CRITICAL — keeps `npm run build` green from Task 3 on)** — `scripts/assert-asymmetric-drift.mjs:45` `const PLUGIN_KEY = "context-mode"` → `const PLUGIN_KEY = "mcp"`. This is the **server key** (it indexes `mcpServers[PLUGIN_KEY]`), NOT the plugin name — do **not** write `"ctxscribe"` (that leaves the lookup undefined and the gate fails). Update the `:29` comment accordingly.

- [ ] **Step 6: Sync versions**

Run: `npm run version-sync`
Expected: version fields align to 1.0.0 (this step also `JSON.parse`s package.json + the manifests, catching malformed JSON); exit 0.

- [ ] **Step 7: Verify manifests parse + gate delta**

Run: `node --check .mcp.json.example 2>/dev/null; node scripts/assert-identity-clean.mjs 2>&1 | head -1`
(Do NOT use `node -e` — deny-listed. `version-sync` already validated the JSON manifests in Step 6; `.mcp.json.example` isn't JS so `node --check` is not applicable — instead confirm via the gate delta.)
Expected: the FAIL count is lower than the Task 1 baseline.

- [ ] **Step 8: Commit**

```bash
git add package.json .claude-plugin/ .mcp.json.example scripts/assert-asymmetric-drift.mjs
git commit -m "feat(ctxscribe): rename Claude manifests + drift-gate key to ctxscribe@wotjr1649/mcp, v1.0.0"
```

---

### Task 3: Claude MCP prefix + key/path matchers + verify-deploy

**Files:**
- Modify (MCP prefix `plugin_context-mode_context-mode`→`plugin_ctxscribe_mcp`): `hooks/core/tool-naming.mjs`, `src/adapters/claude-code/hooks.ts`, `src/session/extract.ts`, `hooks/hooks.json`
- Modify (plugin-KEY matchers): `src/adapters/claude-code/index.ts:383,412,530,645`, `src/adapters/detect.ts:53`, `hooks/deps-heal.mjs:160`, `hooks/pretooluse.mjs:91,126`, `hooks/orphan-reaper.mjs:117`, `src/util/sibling-mcp.ts:75,84`
- Modify (cache-path/version-drift regexes `context-mode/context-mode/<v>`→`wotjr1649/ctxscribe/<v>`): `src/adapters/claude-code/index.ts:439-440`, `hooks/heal-partial-install.mjs:335,337,365`, `hooks/normalize-hooks.mjs:27,43,142,199`
- Modify (deploy gate): `scripts/verify-deploy.mjs` (`PLUGIN_KEY`→`"ctxscribe@wotjr1649"`, `cacheDir`→`wotjr1649/ctxscribe`)

**Interfaces:**
- Consumes: server key `mcp` (Task 2) → prefix second segment.
- Produces: `getToolName("claude-code", t)` → `mcp__plugin_ctxscribe_mcp__${t}`. `verify-deploy.mjs` targets the new key (used only in gated Task 12, set here so it's not left stale).

- [ ] **Step 1: MCP prefix** — in the 4 prefix files, replace literal `plugin_context-mode_context-mode` with `plugin_ctxscribe_mcp` (e.g. `hooks/core/tool-naming.mjs:13` + doc comment `:8`; `claude-code/hooks.ts` regex/allow-list; `extract.ts`; `hooks/hooks.json` matchers).

- [ ] **Step 2: Key matchers** — replace `"context-mode"`/`"context-mode@"` literals with `"ctxscribe"`/`"ctxscribe@"` at the listed lines. Prefer path-derivation where a helper exists, else the literal. `hooks/orphan-reaper.mjs:117`: `if (!k.startsWith("ctxscribe@")) return false;`

- [ ] **Step 3: Cache-path / version-drift regexes** — replace the doubled `context-mode/context-mode/` (and the `cache/context-mode/context-mode` fallback in `claude-code/index.ts:439-440`) with `wotjr1649/ctxscribe/` in `index.ts`, `heal-partial-install.mjs`, `normalize-hooks.mjs` (`CACHE_VERSION_RE`).

- [ ] **Step 4: verify-deploy** — `scripts/verify-deploy.mjs` `PLUGIN_KEY = "ctxscribe@wotjr1649"` and `cacheDir` path segments → `wotjr1649`/`ctxscribe`.

- [ ] **Step 5: Build (bundles) + typecheck**

Run: `npm run build && npm run typecheck`
Expected: exit 0; bundle regenerated; drift-gate green (Task 2 Step 5); no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ctxscribe): repoint Claude MCP prefix + key/path matchers + verify-deploy"
```

---

### Task 4: cache-heal hook rename (INLINE literal in start.mjs) + orphan cleanup (spec N1)

**Files:**
- Modify: `start.mjs:324` (`healHookPath` literal `context-mode-cache-heal.mjs`→`ctxscribe-cache-heal.mjs`), `:388` (written body if it self-references the name), `:405` (command-match), and `:326` area (ADD: unlink the OLD `context-mode-cache-heal.mjs` + prune its `settings.json` SessionStart entry, mirroring the existing old-`.sh` cleanup)
- Modify: `hooks/cache-heal-utils.mjs:184` (`includes("context-mode-cache-heal")`→`ctxscribe-cache-heal`)
- Modify: `hooks/hooks.json` (any cache-heal hook reference)

**NOTE:** the cache-heal hook is NOT a repo file to `git mv` — it is an INLINE string literal that `start.mjs` writes to `~/.claude/hooks/` at boot. The "rename" = change the literal at `start.mjs:324` + `:405` + `cache-heal-utils.mjs:184`, and ADD old-name cleanup.

**Interfaces:**
- Produces: on boot, `start.mjs` writes `~/.claude/hooks/ctxscribe-cache-heal.mjs`, unlinks the stale `context-mode-cache-heal.mjs`, and removes its `settings.json` entry.

- [ ] **Step 1: Rename the inline literal** at `start.mjs:324`/`:405` + `cache-heal-utils.mjs:184` + `hooks/hooks.json`.

- [ ] **Step 2: Add old-hook cleanup in `start.mjs`** beside the existing `.sh` cleanup (`:326`):

```js
// after existing old-.sh cleanup in start.mjs
const oldMjs = resolve(globalHooksDir, "context-mode-cache-heal.mjs");
try { if (existsSync(oldMjs)) unlinkSync(oldMjs); } catch {}
// prune stale settings.json SessionStart entry whose command matches "context-mode-cache-heal" (best-effort; guard all fs ops)
```
(The literal `context-mode-cache-heal` here is intentionally the OLD name — whitelisted in the gate, §4b/Task 1.)

- [ ] **Step 3: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ctxscribe): rename cache-heal hook literal + add stale-hook cleanup (N1)"
```

---

### Task 5: Non-mechanical Claude edge cases — funnels, routing, sentinels, self-name

**Files:**
- Funnels → marketplace path: `src/cli.ts:644-645`, `src/util/plugin-cache-integrity.ts:150`, `scripts/plugin-cache-integrity.mjs:244` (+ check `src/server.ts` upgrade strings)
- Routing own-tool detection: `hooks/core/routing.mjs:576,585` (the `CONTEXT_MODE_SUBSTRING` value + usage); redirect-marker emitters `:656,742,773,786,850`
- Sentinel couplings (rename BOTH sides): `src/session/extract.ts:111-113` ↔ `hooks/core/formatters.mjs:163`; `src/retrieval-marker.ts:32` ↔ `hooks/posttooluse.mjs:188` (`context-mode-retrieval-*.txt`)
- Command-matchers: `src/adapters/claude-code/hooks.ts:212`, `src/adapters/claude-code/index.ts:530` (`includes("context-mode hook")`); `scripts/postinstall.mjs:170,175,182,210,215,267`
- MCP self-name: `src/server.ts:146`

- [ ] **Step 1: Funnels → marketplace path** — replace `npm install -g context-mode` / `bun add -g context-mode` guidance with the marketplace-install instruction (fork is `private`; do NOT print a nonexistent `ctxscribe` npm pkg). e.g. `Reinstall via: claude plugin install ctxscribe@wotjr1649`.

- [ ] **Step 2: Routing own-tool detection (definite change)** — in `hooks/core/routing.mjs`, replace `const CONTEXT_MODE_SUBSTRING = "context-mode"` with detection keyed off the stable `ctx_` tool-name leaf: `const OWN_TOOL_LEAF = "ctx_"` and update `:585` usage. Rename the emitted redirect-marker prefix (`:656,742,773,786,850`) from `"context-mode:"` to `"ctxscribe:"`. **The const's NAME is env-shaped but its VALUE must change** — the gate (Task 1) will flag it if forgotten.

- [ ] **Step 3: Sentinels (both sides in lockstep)** — `formatters.mjs:163` emits `"context-mode: …"` → `"ctxscribe: …"`, AND `extract.ts:111-113` matcher `startsWith("context-mode:")` → `startsWith("ctxscribe:")`. Also `retrieval-marker.ts:32` writer literal `context-mode-retrieval-` ↔ `posttooluse.mjs:188` reader literal → `ctxscribe-retrieval-` (both).

- [ ] **Step 4: Command-matchers + self-name** — `includes("context-mode hook")` → `includes("ctxscribe hook")` (hooks.ts:212, index.ts:530); `postinstall.mjs` bin/pkg/upgrade-dir literals → `ctxscribe`; `server.ts:146` `name:"context-mode"` → `"ctxscribe"`.

- [ ] **Step 5: Build + typecheck + routing test (informational)**

Run: `npm run build && npm run typecheck`
Expected: exit 0. (Routing/tests fail until Task 9 updates expectations — expected mid-sequence.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ctxscribe): rename Claude edge cases (funnels->marketplace, routing leaf, both sentinels)"
```

---

### Task 6: Codex identity

**Files:**
- `.agents/plugins/marketplace.json:2,4,8` (`name`, `displayName`, plugin `name`)
- `.codex-plugin/plugin.json` (`name`, `homepage`/`repository`); `.codex-plugin/mcp.json:3` + `.mcp.json.codex.example:4` (server key → `mcp`)
- `configs/codex/config.toml:7` (`[mcp_servers.mcp]`), `:8` (`command = "ctxscribe"`); `configs/codex/hooks.json:7,14,21,28,35,42` (`command: "ctxscribe hook codex <event>"`)
- `src/adapters/codex/index.ts:102-107` (`HOOK_MAP` → `ctxscribe hook codex <event>`), `:166` (plugin-list regex), `:201` (`plugins."ctxscribe@wotjr1649"`), `:206,807,881-882` (`mcp_servers.mcp`)

**Interfaces:**
- Produces: Codex detection/hook-launch keyed to the new identity; `HOOK_MAP` (`:102-107`) MUST equal the committed `configs/codex/hooks.json` commands (asserted by `tests/core/cli.test.ts:3062`).
- **Excluded here:** Codex data-dir literals (`codex/index.ts:452-453,480`) → Task 7.

- [ ] **Step 1: Codex manifests + configs** — apply the transform tokens across the listed files (marketplace `wotjr1649`, plugin `ctxscribe`, key `ctxscribe@wotjr1649`, server key `mcp`, `command`/hook commands `ctxscribe`).

- [ ] **Step 2: `codex/index.ts`** — update `HOOK_MAP` (`:102-107`), plugin-list regex (`:166`), toml-section reads (`:201`, `:206/807/881-882`). Leave `:452-453/480` data-dir for Task 7.

- [ ] **Step 3: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ctxscribe): rename Codex identity (manifests, configs, hooks, index.ts)"
```

---

### Task 7: Active on-disk data dir rename (spec §4d) — all sites, override + default

**Files (data-dir literal `<configDir>/context-mode/`→`ctxscribe/`):**
- `src/adapters/base.ts:67-68` (**sessions — both branches carry the segment**), `:120` (**memory OVERRIDE path carries the segment; the `:121` default `join(getConfigDir(),"memory")` does NOT — flip the override, leave the default as-is**)
- `src/adapters/codex/index.ts:452-453,480-481` (override paths), `src/adapters/claude-code/index.ts:109-110`, `src/session/analytics.ts`, `src/session/db.ts`, `src/db-base.ts:417` (`defaultDBPath(prefix="ctxscribe")`), `hooks/platform-bridge.mjs:31-36`, `hooks/run-hook.mjs:43`, `hooks/sessionstart.mjs:443`, `hooks/precompact.mjs:31`, `hooks/codex/precompact.mjs:27`, `hooks/heal-partial-install.mjs:426`, `scripts/ctx-debug.sh:596-597,761`
- Tmp-DB cleanup regex (lockstep with `defaultDBPath`): `src/store.ts:185` (`/^ctxscribe-\d+\.db$/`), `:423` (tmp name)
- **DO NOT MODIFY (legacy dot-dir, §4b):** `src/server.ts:628,4355`, `hooks/platform-bridge.mjs:38` (`~/.context-mode`)

**Interfaces:**
- Produces: runtime writes go to `<configDir>/ctxscribe/{sessions,memory,content}/`. No migration — new dir starts empty unless the user renames the physical dir (spec §9 D1).

- [ ] **Step 1: Enumerate exact sites**

Run: `git grep -n -E "context-mode/(sessions|memory|memories|content)|defaultDBPath|context-mode-\\\\d|\"context-mode\"" -- src hooks scripts | grep -v "\.context-mode"`
Expected: the data-dir site list. Note the `base.ts:120` override-vs-`:121` default asymmetry.

- [ ] **Step 2: Flip the literal at every override/carrying site** to `ctxscribe`, including `base.ts:67-68` + `:120` (override) and `codex/index.ts:452-453/480-481`. Update `db-base.ts:417` `defaultDBPath` prefix + the paired `store.ts:185/423` tmp-DB regex/name. Leave default paths that build from `getConfigDir()` without an explicit segment untouched.

- [ ] **Step 3: Verify legacy dot-dir untouched**

Run: `git grep -n "\.context-mode" -- src hooks`
Expected: `server.ts:628,4355` + `platform-bridge.mjs:38` still present.

- [ ] **Step 4: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ctxscribe): rename active data dir to <config>/ctxscribe (keep legacy ~/.context-mode)"
```

---

### Task 8: repo / isForkOrigin / clone URLs + fallback literal

**Files:**
- `src/cli.ts` (isForkOrigin regex repo half `wotjr1649/context-mode`→`wotjr1649/ctxscribe`, clone URL, marketplace dir refs)
- `src/server.ts` (clone URL — NOT the legacy `.context-mode` cleanup)
- `start.mjs:152` (fallback `"context-mode@context-mode"`→`"ctxscribe@wotjr1649"`; also the `:146` comment)

**Interfaces:**
- Produces: `isForkOrigin("https://github.com/wotjr1649/ctxscribe.git") === true`; upstream/other → `false`.

- [ ] **Step 1: isForkOrigin + clone URLs** — `cli.ts`: change the regex repo path `wotjr1649\/context-mode`→`wotjr1649\/ctxscribe` (keep host-authority anchoring); clone URL → `https://github.com/wotjr1649/ctxscribe.git`. `server.ts` clone URL likewise.

- [ ] **Step 2: start.mjs fallback + comment** — `:152` → `"ctxscribe@wotjr1649"`; `:146` comment token.

- [ ] **Step 3: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ctxscribe): repoint repo/isForkOrigin/clone URLs to wotjr1649/ctxscribe"
```

---

### Task 9: Tests sweep (~1049 occ / 93 files; preserve ~274 `CONTEXT_MODE_`)

**Files:** `tests/` broadly. High-risk: `tests/util/heal-installed-plugins.test.ts` (153), `tests/core/cli.test.ts` (90), `tests/adapters/codex.test.ts` (89), `tests/hooks/shell-snapshot-heal.test.ts` (64), `tests/hooks/tool-naming.test.ts`, `tests/hooks/core-routing.test.ts`, `tests/scripts/asymmetric-drift-assert.test.ts`, `tests/hooks/cache-heal-self-heal.test.ts`, `tests/core/cli-fork-origin.test.ts`, `tests/util/project-dir.test.ts`

**Interfaces:**
- Consumes: all new identity values (Tasks 2-8). Produces: green suite (baseline, no new failures).

- [ ] **Step 1: Sweep identity tokens in tests** — apply the transform rules across `tests/`: prefix `mcp__plugin_ctxscribe_mcp__`, key `ctxscribe@wotjr1649`, cache paths `wotjr1649/ctxscribe`, server key `mcp`, hook name `ctxscribe-cache-heal`, data-dir `ctxscribe/`. **Preserve every `CONTEXT_MODE_*` env NAME.**

- [ ] **Step 2: `cli-fork-origin.test.ts`** — accept-case URLs `wotjr1649/context-mode`→`wotjr1649/ctxscribe`; **KEEP** the `mksglu/context-mode` + `attacker` REJECT cases (still `false`).

- [ ] **Step 3: `core-routing.test.ts` + `tool-naming.test.ts` + `asymmetric-drift-assert.test.ts`** — new prefix + `ctx_`-leaf own-tool detection (Task 5) + server key `mcp` in the drift assertion.

- [ ] **Step 4: Run the affected test files**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/hooks/tool-naming.test.ts tests/hooks/core-routing.test.ts tests/core/cli-fork-origin.test.ts tests/scripts/asymmetric-drift-assert.test.ts tests/hooks/cache-heal-self-heal.test.ts`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test(ctxscribe): update suite to ctxscribe identity (keep CONTEXT_MODE_ env + mksglu reject cases)"
```

---

### Task 10: Cosmetic sweep + skills/ + CLAUDE.md + docs

**Files:** `skills/` (namespace `context-mode:`→`ctxscribe:`, dir `skills/context-mode/`, `Trigger: /context-mode:ctx-*` lines, `context-mode index` bin refs), `README.md`, `CONTRIBUTING.md`, `BENCHMARK.md`, `CLAUDE.md`, `.github/ISSUE_TEMPLATE/*`, `bin/statusline.mjs`, `.gitignore`, remaining comment/log strings.

- [ ] **Step 1: skills/** — rename the `skills/context-mode/` directory + skill-namespace refs (`/context-mode:ctx-*` → `/ctxscribe:ctx-*` in every `ctx-*/SKILL.md` Trigger line) + `context-mode index`/bin refs → `ctxscribe`.

- [ ] **Step 2: CLAUDE.md** — marketplace `wotjr1649`, cache path `cache/wotjr1649/ctxscribe/`, routing examples `mcp__plugin_ctxscribe_mcp__ctx_*`, and **remove the obsolete upstream-semver collision workaround** (spec §3.4). Preserve every `mksglu`/attribution reference.

- [ ] **Step 3: README/CONTRIBUTING/BENCHMARK/templates/statusline/.gitignore** — swap brand tokens to `ctxscribe`, preserving "fork of mksglu/context-mode" attribution + `mksglu` links.

- [ ] **Step 4: Drive the gate to zero**

Run: `node scripts/assert-identity-clean.mjs`
Expected: `OK (0 functional refs)`. Fix any remaining until zero.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(ctxscribe): sweep skills/docs/CLAUDE.md to ctxscribe; drop obsolete collision workaround"
```

---

### Task 11: Wire the gate + full verification

- [ ] **Step 1: Wire `assert-identity-clean` into `npm run build`** — add `node scripts/assert-identity-clean.mjs` to the `build` script chain, alongside `assert-bundle`/`assert-asymmetric-drift`/`assert-no-upstream-mksglu`/`assert-no-removed-platforms`.

- [ ] **Step 2: Full gate run**

Run: `npm run typecheck && npm run build`
Expected: exit 0 — bundle drift 0, `assert-bundle`, `assert-asymmetric-drift`, `assert-no-upstream-mksglu`, `assert-no-removed-platforms`, `assert-identity-clean` (0).

- [ ] **Step 3: Capped full test suite**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1`
Expected: only the **6 known baseline failures**; no new failures.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "build(ctxscribe): wire assert-identity-clean into build; full verification green"
```

---

### Task 12: Migration / deploy — APPROVAL-GATED (destructive-remote)

> **Do NOT execute without explicit user approval at execution time.** (`verify-deploy.mjs` was already repointed in Task 3 Step 4 — verify here.)

- [ ] **Step 1: Verify the deploy gate** — confirm `scripts/verify-deploy.mjs` targets `ctxscribe@wotjr1649` + `cache/wotjr1649/ctxscribe`.
- [ ] **Step 2 (gated): GitHub repo rename** `wotjr1649/context-mode` → `wotjr1649/ctxscribe`; `git remote set-url origin …/ctxscribe.git`. Do NOT `marketplace update` the old marketplace afterward.
- [ ] **Step 3 (gated): merge `spec/ctxscribe-rename` → main, push** (after user OK).
- [ ] **Step 4 (gated): install new identity** — `claude plugin marketplace add wotjr1649` (+ Codex analogue) → `claude plugin install ctxscribe@wotjr1649`.
- [ ] **Step 5 (gated): verify + smoke** — `node scripts/verify-deploy.mjs 1.0.0` → PASS; deployed tree byte-matches commit; live `ctx_*` smoke under `mcp__plugin_ctxscribe_mcp__*` (Claude) + bare `ctx_*` (Codex).
- [ ] **Step 6 (gated): remove old** — uninstall `context-mode@context-mode-js` + old marketplace; confirm the stale `context-mode-cache-heal.mjs` hook + settings entry are gone (Task 4 N1); reload.

---

## Self-Review

**Spec coverage:** §2 map → Tasks 2-8,10 (incl. skill ns → Task 10); §4a rules → Tasks 2-10; §4b invariants → Global Constraints + gate whitelist (Task 1) + Task 7 Step 3; §4c edge cases → Task 5 (+ Codex hooks Task 6, data-dir asymmetry Task 7); §4d data dir → Task 7; §4e tests → Task 9; §4f gate → Tasks 1+11; §5 phasing → task order; §6 risks → N1 (Task 4), tag (Global), dual-install (Task 12); §7 acceptance → Task 11; §9 decisions → Global + Tasks 2/5/6/7. **No gaps.**

**Plan-review fixes folded (v2):** gate false-clean removed (no env whitelist; grep is case-sensitive) + false-fail fixed (`context-mode-cache-heal` whitelisted) + `skills` in SCAN; `assert-asymmetric-drift.mjs`→`"mcp"` in Task 2 (build-green from Task 3); branch Task 0; Task 4 inline-literal wording; `verify-deploy` explicit (Task 3); `node -e` removed (Task 2 Step 7); sentinels `retrieval-marker↔posttooluse` + routing emitters + `base.ts:67-68/120-121` asymmetry.

**Ordering note:** per-task `vitest` is RED for Tasks 3-8 (tests updated in Task 9) — expected; `npm run build` does NOT run vitest, and `assert-identity-clean` is wired only in Task 11, so builds stay green mid-sequence (given Task 2's drift-gate fix).

**No placeholders; names consistent** (key `ctxscribe@wotjr1649`, server key `mcp`, prefix `plugin_ctxscribe_mcp`, hook `ctxscribe-cache-heal`, data-dir `ctxscribe/`, own-tool leaf `ctx_`).
