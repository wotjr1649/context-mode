# 단계 4 — 로컬 훅 흡수 + 보안 하드닝 + phase-4 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 사용자 레벨에만 살던 두 자가치유 훅(deps-heal, orphan-reaper)을 저장소 코드로 흡수해 배포 대상으로 만들고, 그 과정에서 스펙 §9.1의 잔여 결함 3종을 고치고, 단계 3이 남긴 실제 결함(package.json main/exports)과 저위험 phase-4 정리를 처리한다.

**Architecture:** 저장소 코드만 건드린다 — 사용자 `~/.claude/hooks/`와 `settings.json`은 무접촉(배포는 단계 6 커토버가 한다). deps-heal은 이미 사용자 레벨에서 §9.1대로 하드닝돼 있으므로, 저장소로 이관하며 잔여 결함 3종(셸 인젝션·rmSync 경로탈출·stderr)만 고친다. orphan-reaper는 저장소로 이관하며 CommandLine 부분일치를 캐시-루트 prefix 매칭으로 좁히고 DRY_RUN을 기본값으로 등록한다. 나머지는 독립적인 정리 태스크.

**Tech Stack:** Node ESM (`.mjs` 훅), TypeScript 5 (`tsc`), esbuild 0.27, vitest 3, `hooks/hooks.json` + `.codex-plugin/hooks.json` (SessionStart 등록).

## Global Constraints

`CLAUDE.md` + 단계 3에서 확립된 규율. **모든 태스크에 암묵 포함.**

- **저장소 코드만.** `~/.claude/hooks/*`, `~/.claude/settings.json`, `~/.codex/*` 는 **읽기만** 하고 쓰지 않는다. 배포는 단계 6이 한다.
- 파일 출력 **UTF-8 (BOM 없음), LF**. 커밋 전 CR 0 확인.
- **코드 주석은 영어.** 이 계획의 한국어는 의도 설명이지 붙여넣을 코드가 아니다.
- **`node -e` / `node -p` DENY** (`Bash(node -e:*)`). 스크래치는 `.superpowers/sdd/<name>.mjs` 에 쓰고 `node <path>`. **`rm` DENY** → `git rm`.
- **`npm test` 금지** (`pretest`가 풀빌드). vitest 는 반드시 `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 <paths>`.
- **Claude 훅은 stderr 출력 금지** — 로그는 파일로. (이 계획의 결함 #4가 바로 이것.)
- `npm version` 금지. `git fetch/push --tags` 금지. `upstream` merge 금지. push 금지(사용자 승인).
- **pre-commit 가드가 매 커밋에 돈다.** `src/`·`hooks/`·`start.mjs`·`scripts/` 변경 시 번들 재생성+diff 검사. `hooks/*.mjs` 훅 파일은 번들 소스가 **아니다**(7개 번들 진입점은 server/cli/session-{extract,snapshot,db}/security/project-attribution) — 새 훅 추가는 번들 바이트를 안 바꾼다. 확인하고 리포트에 적는다.
- **잔재 스캔이 build 체인에 있다.** 새 코드에 삭제된 16플랫폼 식별자를 넣지 마라. `orphan-reaper` 의 캐시-루트 패턴은 `context-mode` (플러그인명)만 쓴다 — 삭제 식별자 아님.
- 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- 전체 캡 스위트 기준: 실패 ⊆ pre-existing 6건 (executor×3 Python부재, integration×2 node-e deny, run-hook×1).

---

## 실측 정정 — 스펙 §9 와 현실의 어긋남 (이 표가 §9 좌표보다 권위)

| # | 스펙 §9 가 말한 것 | 실측 (2026-07-11, HEAD `1edb742`) |
|---|---|---|
| A | deps-heal 이 상류 훅이라 §9.1 하드닝 4종 필요 | **이미 §9.1대로 재작성됨** (사용자 레벨 `~/.claude/hooks/context-mode-deps-heal.mjs`): 순수-JS external만 대상(`RUNTIME_EXTERNAL_FALLBACK` + `--external:` 동적 파싱), `--ignore-scripts` 있음, `activeInstallPath` 가 레지스트리에서 유도. **남은 결함은 3종:** #1 `execSync(문자열)`+`${spec}` 무필터(`:93-94`), #3 `rmSync(join(root,...name.split("/")))` `..` 봉쇄 없음(`:89`), #4 stderr 쓰기(`:85,97,99`) |
| B | deps-heal 은 저장소에 있음 | **저장소에 없음.** `hooks/deps-heal.mjs` 부재. 저장소는 `hooks/ensure-deps.mjs`(better-sqlite3 네이티브 전용, `NATIVE_DEPS=["better-sqlite3"]` `:48`)만 있다. 흡수 = deps-heal 을 저장소로 **신규 이관** |
| C | orphan-reaper 를 저장소 hooks/ 에 등록 | 저장소에 **없음**(사용자 레벨만). 판정이 `:56` `/context-mode/i.test(p.CommandLine)` 부분일치 — 저장소 디렉토리명이 `context-mode` 라 개발 프로세스가 사정권. 캐시-루트 prefix 매칭으로 교체 필요 |
| D | (§12 범위밖) package.json main/exports | **실제 결함:** `main` = `exports["."]` = `./build/adapters/opencode/plugin.js` — Task 4 가 지운 opencode. `private:true` 라 npm 배포는 없지만 `require("context-mode")` 가 존재하지 않는 파일로 해석 |
| E | suppression 클러스터 phase-4 | **이미 Task 10 이 삭제.** 무관 |
| F | ensure-deps 가 node 내장만 쓰는지 검증 필요 | **확인됨** — `hooks/ensure-deps.mjs:22-26` 은 node 내장(`node:fs/path/url/module`)만 import. 깨진 node_modules 에서도 로드된다 |

**deps-heal 이관 vs 확장 결정:** deps-heal(순수-JS)과 ensure-deps(네이티브)는 **책임이 다르다**(스펙 §9.1은 ensure-deps 에 얹으라 했으나, 실측 결과 deps-heal 은 이미 독립적이고 완성도 높은 별도 파일이다). 억지로 병합하면 두 관심사(부분설치 감지 vs ABI 검증)가 한 파일에 섞인다. **채택: deps-heal 을 별도 저장소 훅 `hooks/deps-heal.mjs` 로 이관하고 결함 3종만 고친다.** ensure-deps 는 건드리지 않는다(better-sqlite3 담당 유지).

---

## File Structure

**신규:**
- `hooks/deps-heal.mjs` — 사용자 레벨 deps-heal 의 이관본 + 결함 3종 수정. 순수 Node 내장. SessionStart.
- `hooks/orphan-reaper.mjs` — 사용자 레벨 reaper 의 이관본 + prefix 매칭 + DRY_RUN 기본. Windows 전용, best-effort.
- `tests/hooks/deps-heal.test.ts` — 인젝션 차단 + rmSync 경로탈출 거부 + 부분설치 감지.
- `tests/hooks/orphan-reaper.test.ts` — prefix 매칭 판정(개발 프로세스 오탐 0), 자기·조상 보호, Linux exit 0, DRY_RUN.

**수정:**
- `hooks/hooks.json` — SessionStart 에 deps-heal + orphan-reaper 등록.
- `.codex-plugin/hooks.json` — 동일(단, reaper 는 Windows 전용이라 양쪽 다 등록하되 내부 플랫폼 가드가 처리).
- `package.json` — `main`/`exports["."]` 재지정, `files[]` 에 새 훅 포함 확인, phase-4 정리(prepublishOnly 등).
- `tsconfig.test.json`(신규) + `package.json` `typecheck:tests` 스크립트 — phase-4: tests 타입체크.
- `scripts/assert-no-removed-platforms.mjs` — GATED 에 `start.mjs` 추가(누락 보완).
- `.gitignore` — `*.tmp` 추가(f*.tmp 근원 완화).
- `src/session/analytics.ts` — 죽은 로컬 4종 제거(phase-4).

---

## Task 1: package.json main/exports 재지정 (실제 결함 — 독립, 먼저)

**Files:**
- Modify: `package.json` (`main`, `exports`)
- Test: `tests/scripts/version-sync.test.ts` 또는 신규 `tests/core/package-exports.test.ts`

**Interfaces:**
- Produces: `main` / `exports["."]` 이 존재하는 파일을 가리킨다.

- [ ] **Step 1: 실패하는 테스트**

`tests/core/package-exports.test.ts` 신규:

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("package.json entry points resolve to real files", () => {
  it("main points at a file that exists", () => {
    // main is a source path (build/… may not exist pre-build); assert the
    // SOURCE it derives from exists, and that it is NOT a removed adapter.
    expect(pkg.main).not.toMatch(/adapters\/(opencode|pi|omp|openclaw|cursor|kimi|kiro|zed|gemini-cli|qwen-code|antigravity|jetbrains-copilot|copilot-cli|vscode-copilot|kilo)\//);
  });
  it("exports['.'] does not point at a removed adapter's build path", () => {
    const dot = typeof pkg.exports === "object" ? pkg.exports["."] : pkg.exports;
    expect(dot).not.toMatch(/adapters\/(opencode|pi|omp|openclaw|cursor|kimi|kiro|zed|gemini-cli|qwen-code|antigravity|jetbrains-copilot|copilot-cli|vscode-copilot|kilo)\//);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/core/package-exports.test.ts
```
Expected: FAIL — 현재 `./build/adapters/opencode/plugin.js` 가 `opencode` 를 매치.

- [ ] **Step 3: 재지정**

`main`/`exports["."]` 을 무엇으로 바꿀지 결정한다. context-mode 의 실제 진입점은 MCP 서버다. **먼저 다른 진입점 후보를 실측하라:** `git show HEAD:package.json` 의 `bin` 필드, `start.mjs`, `server.bundle.mjs`. 이 패키지는 `private:true` + 플러그인(마켓플레이스 설치)이라 `main`/`exports` 는 사실상 죽은 필드지만, 존재하는 파일을 가리켜야 한다. 가장 정직한 값:

```json
"main": "./server.bundle.mjs",
"exports": {
  ".": "./server.bundle.mjs",
  "./cli": "./cli.bundle.mjs"
}
```

> `server.bundle.mjs` 가 `files[]` 에 있고 실재하는지 확인(단계 3에서 커밋됨). `./cli` 는 기존 값 유지.

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/core/package-exports.test.ts
npm run typecheck
git add package.json tests/core/package-exports.test.ts
git commit -m "fix: repoint package.json main/exports off the deleted opencode adapter

main and exports['.'] pointed at ./build/adapters/opencode/plugin.js,
deleted in phase 3. private:true so npm never shipped it, but require()
resolution was broken. Repointed at server.bundle.mjs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: deps-heal 저장소 이관 + 결함 3종 수정

**Files:**
- Create: `hooks/deps-heal.mjs` (사용자 레벨 이관 + 결함 수정)
- Create: `tests/hooks/deps-heal.test.ts`

**Interfaces:**
- Produces: `hooks/deps-heal.mjs` — SessionStart 에서 실행 가능한 순수-Node 훅. export 는 테스트를 위해 순수 함수 `validateSpec(name, range)` (검증 통과 시 `true`), `resolveModuleDir(root, name)` (경로탈출 시 `null`).

> **소스 원본 확보됨:** `.superpowers/sdd/phase4-deps-heal-source.mjs` (104줄 — 컨트롤러가 사용자 레벨에서 복사). 이 파일을 읽어 구조(runtimeExternals, activeInstallPath, fast-path)를 기준으로 삼되, 아래 결함 3종을 반드시 고쳐 `hooks/deps-heal.mjs` 로 옮긴다. 원본 그대로 복사 금지. 원본은 순수 Node 내장만 쓰므로(`node:fs/path/os/child_process`) 흡수 후에도 그대로다.

- [ ] **Step 1: 실패하는 테스트 — 결함 3종을 겨눈다**

```ts
import { describe, it, expect } from "vitest";
import { validateSpec, resolveModuleDir } from "../../hooks/deps-heal.mjs";
import { resolve } from "node:path";

describe("deps-heal spec validation (defect #1 — shell injection)", () => {
  it("accepts a clean package name + semver range", () => {
    expect(validateSpec("turndown", "^7.2.0")).toBe(true);
    expect(validateSpec("@mixmark-io/domino", "2.2.0")).toBe(true);
  });
  it("rejects a range carrying shell metacharacters", () => {
    expect(validateSpec("turndown", "^7 & echo pwned")).toBe(false);
    expect(validateSpec("turndown", "$(rm -rf /)")).toBe(false);
    expect(validateSpec("turndown", "7`whoami`")).toBe(false);
  });
  it("rejects a name with shell metacharacters or traversal", () => {
    expect(validateSpec("turndown; rm x", "1.0.0")).toBe(false);
    expect(validateSpec("../../evil", "1.0.0")).toBe(false);
  });
});

describe("deps-heal module dir resolution (defect #3 — path traversal)", () => {
  const root = resolve("/tmp/fake-plugin-root");
  it("resolves a normal scoped name under node_modules", () => {
    expect(resolveModuleDir(root, "@mixmark-io/domino"))
      .toBe(resolve(root, "node_modules", "@mixmark-io", "domino"));
  });
  it("returns null when the name escapes node_modules", () => {
    expect(resolveModuleDir(root, "../../../etc")).toBeNull();
    expect(resolveModuleDir(root, "..")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `Cannot find module '../../hooks/deps-heal.mjs'`.

- [ ] **Step 3: 이관 + 수정 구현**

`hooks/deps-heal.mjs` 를 만든다. 사용자 레벨 원본의 구조(runtimeExternals, activeInstallPath, fast-path)를 유지하되:

**결함 #1 (셸 인젝션):** `validateSpec` 를 추가하고 재설치 전에 호출. `execSync(문자열)` 대신 `execFileSync(npm, [배열], {shell:false})`:

```js
const SAFE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SAFE_RANGE = /^[a-z0-9][a-z0-9.^~><=\s|*+-]*$/i;

export function validateSpec(name, range) {
  if (typeof name !== "string" || typeof range !== "string") return false;
  if (name.includes("..") || !SAFE_NAME.test(name)) return false;
  if (!SAFE_RANGE.test(range)) return false;
  return true;
}
```

재설치 호출부:
```js
if (!validateSpec(name, range)) continue;  // skip anything that fails the whitelist
try {
  execFileSync(npm, ["install", `${name}@${range}`, "--prefix", root,
    "--ignore-scripts", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--loglevel=error"],
    { stdio: "ignore", timeout: 180000, shell: false });
```

> **CVE-2024-27980 주의:** Windows 에서 `.cmd`(npm.cmd) 를 `execFileSync(shell:false)` 로 불러도 인자 이스케이프가 불완전하다. 그래서 `validateSpec` 의 화이트리스트가 load-bearing 이다 — `execFileSync` 만으로 방어하지 마라. 주석으로 명시하라.

**결함 #3 (rmSync 경로탈출):** `resolveModuleDir` 로 감싸고 `null` 이면 스킵:

```js
export function resolveModuleDir(root, name) {
  if (name.includes("..")) return null;
  const dir = resolve(root, "node_modules", ...name.split("/"));
  const base = resolve(root, "node_modules") + sep;
  if (!dir.startsWith(base)) return null;
  return dir;
}
```
(`sep` 를 `node:path` import 에 추가.) 삭제부: `const dir = resolveModuleDir(root, name); if (!dir) continue; rmSync(dir, ...)`.

**결함 #4 (stderr):** `process.stderr.write` 3곳을 로그 파일로. orphan-reaper 가 쓰는 것과 같은 방식 — `appendFileSync(LOG_PATH, ...)` 로. `LOG_PATH` 는 훅 디렉토리의 `context-mode-deps-heal.log`. **Claude 훅은 stderr 를 실패로 해석하므로 이건 필수다.**

- [ ] **Step 4: 통과 확인**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/hooks/deps-heal.test.ts
node --check hooks/deps-heal.mjs
```
Expected: PASS. `node --check` clean.

- [ ] **Step 5: 커밋**

```bash
git add hooks/deps-heal.mjs tests/hooks/deps-heal.test.ts
git commit -m "feat(hooks): absorb deps-heal into the repo, close the 3 remaining hardening gaps

Ports the user-level context-mode-deps-heal.mjs into the plugin (so it ships
and survives auto-update). Adds validateSpec whitelist (defect #1 — the
execSync shell string with unfiltered \${spec}; execFileSync alone is
insufficient on Windows .cmd per CVE-2024-27980, so the whitelist is
load-bearing), resolveModuleDir traversal guard (defect #3), and log-file
output instead of stderr (defect #4 — Claude reads hook stderr as failure).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: orphan-reaper 저장소 이관 + prefix 매칭 + DRY_RUN 기본

**Files:**
- Create: `hooks/orphan-reaper.mjs`
- Create: `tests/hooks/orphan-reaper.test.ts`

**Interfaces:**
- Produces: `hooks/orphan-reaper.mjs` — export `isReapable(commandLine, cacheRoot)` (부분일치가 아니라 캐시-루트 prefix 매칭), `reap({ dryRun, procs, selfPid, ancestorPids })` (순수 함수, 프로세스 목록을 주입받아 테스트 가능).

> **소스 원본 확보됨:** `.superpowers/sdd/phase4-orphan-reaper-source.mjs` (96줄 — 컨트롤러가 복사). 골격(DRY_RUN, 자기·조상 보호, Win32_Process 조회, 로그)은 유지, 판정 로직과 DRY_RUN 기본값만 바꿔 `hooks/orphan-reaper.mjs` 로 옮긴다.

- [ ] **Step 1: 실패하는 테스트 — 개발 프로세스 오탐 0 이 핵심**

```ts
import { describe, it, expect } from "vitest";
import { isReapable } from "../../hooks/orphan-reaper.mjs";

const CACHE = "C:\\Users\\me\\.claude\\plugins\\cache\\context-mode-js\\context-mode";

describe("orphan-reaper isReapable — cache-root prefix, not substring", () => {
  it("reaps a plugin-cache orphan under the cache root", () => {
    expect(isReapable(`node "${CACHE}\\1.0.0\\start.mjs"`, CACHE)).toBe(true);
  });
  it("does NOT reap a dev process merely running from a context-mode working dir", () => {
    // The repo's own directory is named context-mode — the old substring
    // match /context-mode/i would kill this. The prefix match must not.
    expect(isReapable('node C:\\Users\\me\\Documents\\ClaudeCode\\context-mode\\node_modules\\.bin\\vitest', CACHE)).toBe(false);
    expect(isReapable('npm run dev', CACHE)).toBe(false);
  });
  it("does NOT reap another marketplace's tree (anti-spoof)", () => {
    expect(isReapable('node C:\\Users\\me\\.claude\\plugins\\cache\\evil\\context-mode\\1.0.0\\start.mjs', CACHE)).toBe(false);
  });
  it("returns false for a non-string command line", () => {
    expect(isReapable(undefined, CACHE)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — `Cannot find module`.

- [ ] **Step 3: 이관 + prefix 매칭 구현**

`hooks/orphan-reaper.mjs`. 원본의 골격(DRY_RUN, 자기·조상 보호, Win32_Process 조회, 로그) 유지하되 판정을 교체:

```js
// The kill judgment: the CommandLine's script argument must sit UNDER the
// plugin cache root (…/plugins/cache/<marketplace>/context-mode), not merely
// mention "context-mode" anywhere. The fork's own working directory is named
// context-mode, so a substring match would reap dev processes (vitest, npm
// run dev). We match the cache root as a path prefix, normalized for both
// separators. Anchoring on the cache root (not a version dir) keeps orphans
// left by a previous version in range after a bump.
export function isReapable(commandLine, cacheRoot) {
  if (typeof commandLine !== "string" || typeof cacheRoot !== "string") return false;
  const norm = (s) => s.replace(/\//g, "\\").toLowerCase();
  return norm(commandLine).includes(norm(cacheRoot) + "\\");
}
```

> `cacheRoot` 는 호출부에서 유도한다: `installed_plugins.json` 의 활성 `installPath` → `resolve(installPath, "..")` (버전 dir 의 부모 = `…/cache/<marketplace>/context-mode`). deps-heal 의 `activeInstallPath` 패턴을 재사용하되, junction 대비 `realpathSync` 로 정규화해 비교. 레지스트리를 못 읽으면 즉시 `exit(0)` (아무것도 죽이지 않음).

**DRY_RUN 기본값:** 원본은 `--dry-run` 플래그가 있을 때만 dry. **이관본은 반대로 — 기본이 dry, `CONTEXT_MODE_REAPER_ARMED=1` 일 때만 실살살.** 스펙 §9.2 의 "먼저 dry-run 배포, 로그 0 확인 후 활성화"를 코드 기본값으로 못박는다:

```js
const ARMED = process.env.CONTEXT_MODE_REAPER_ARMED === "1";
const DRY_RUN = !ARMED;  // safe by default; arming is a deliberate opt-in
```

**플랫폼 가드:** `if (process.platform !== "win32") process.exit(0);` 를 맨 앞에.

- [ ] **Step 4: 통과 확인**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/hooks/orphan-reaper.test.ts
node --check hooks/orphan-reaper.mjs
```

- [ ] **Step 5: 커밋**

```bash
git add hooks/orphan-reaper.mjs tests/hooks/orphan-reaper.test.ts
git commit -m "feat(hooks): absorb orphan-reaper with cache-root prefix matching, DRY_RUN default

Ports the user-level reaper into the plugin. Replaces the /context-mode/i
substring kill judgment (which would reap dev processes — the fork's own
working dir is named context-mode) with a cache-root path-prefix match.
DRY_RUN is now the default; arming requires CONTEXT_MODE_REAPER_ARMED=1,
encoding spec 9.2's deploy-dry-first rule. Windows-only guard up front.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 두 훅을 SessionStart 에 등록

**Files:**
- Modify: `hooks/hooks.json` (Claude), `.codex-plugin/hooks.json` (Codex)

**Interfaces:**
- Consumes: `hooks/deps-heal.mjs`, `hooks/orphan-reaper.mjs` (Task 2·3).

- [ ] **Step 1: 현재 SessionStart 배열 확인**

```bash
node .superpowers/sdd/show-hooks.mjs   # cat hooks/hooks.json + .codex-plugin/hooks.json, print SessionStart arrays
```
(스크립트: 두 파일 읽어 `hooks.SessionStart` 를 pretty-print.)

- [ ] **Step 2: deps-heal + orphan-reaper 커맨드 추가**

`hooks/hooks.json` 의 `SessionStart[0].hooks` 배열에 기존 `sessionstart.mjs` 뒤로 추가:
```json
{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/deps-heal.mjs\"" },
{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/orphan-reaper.mjs\"" }
```
`.codex-plugin/hooks.json` 의 SessionStart 에도 동일하되 **변수는 `${PLUGIN_ROOT}`** (실측 확정: Claude `hooks/hooks.json` = `${CLAUDE_PLUGIN_ROOT}`, Codex `.codex-plugin/hooks.json` = `${PLUGIN_ROOT}` — 각 파일의 기존 관례를 그대로 따른다).

> **best-effort 계약:** 두 훅 다 실패해도 세션 진행을 막지 않아야 한다. 훅 자체가 `try/catch` + `exit(0)` 로 끝나므로 등록만으로 충분하나, 등록 순서는 기존 `sessionstart.mjs`(핵심) **뒤**에 둔다 — 치유는 부수다.

- [ ] **Step 3: JSON 유효성 + 커밋**

```bash
node .superpowers/sdd/show-hooks.mjs   # re-run: both parse, both carry the 2 new commands
```

```bash
git add hooks/hooks.json .codex-plugin/hooks.json
git commit -m "feat(hooks): register deps-heal and orphan-reaper on SessionStart

Both fire after the core sessionstart hook; both are best-effort (try/catch
+ exit 0) so a heal failure never blocks the session.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: files[] 확인 + phase-4 저위험 정리

**Files:**
- Modify: `package.json` (`files[]` 확인, `prepublishOnly`), `.gitignore` (`*.tmp`), `scripts/assert-no-removed-platforms.mjs` (GATED += start.mjs), `src/session/analytics.ts` (죽은 로컬 4종)

- [ ] **Step 1: files[] 가 새 훅을 포함하는지**

`package.json` 의 `files[]` 에 `hooks` 가 디렉토리로 있으면(단계 3에서 확인됨) 새 `.mjs` 는 자동 포함. 확인만:
```bash
node .superpowers/sdd/check-files.mjs   # assert "hooks" ∈ files[]; print result
```
포함돼 있으면 수정 불필요.

- [ ] **Step 2: 죽은 analytics 로컬 제거 (참조 1인 것만)**

`src/session/analytics.ts` — `claudeMaxMonths`(:1954, ref 1), `weekendCount`(:1955, ref 1), `renderHero`(:2645, ref 1), `renderConversation`(:2673, ref 1). **ref 1 = 정의뿐, 소비자 0.** 각 선언과 그 본문을 제거. **`lifetimeTokensWith`(ref 6)는 살아있으니 건드리지 마라.** 제거 전 각 심볼을 `node .superpowers/sdd/refcheck.mjs` 로 재확인(정의 1 + 사용 0).

- [ ] **Step 3: 저위험 정리 3종**

- `.gitignore` 에 `*.tmp` 추가 (f0/f1/f2.tmp 근원 — 어떤 테스트의 cwd-상대 쓰기; 근본 원인 추적은 범위 밖이나 크럼은 무시되게).
- `scripts/assert-no-removed-platforms.mjs` 의 GATED 배열에 `start.mjs` 앵커 추가 (whole-branch 리뷰가 지목한 누락 — 오늘 잔재 0이지만 하드닝).
- `package.json` `prepublishOnly` — `"private": true` 때문에 도달 불가. **삭제**(죽은 스크립트) 또는 유지 판단: 삭제가 정직하다.

- [ ] **Step 4: tsconfig.test.json + typecheck:tests (phase-4)**

`tests/` 가 어떤 저장소 명령으로도 타입체크되지 않는 구멍(단계 3 내내 에디터만 잡음). 신규 `tsconfig.test.json`:
```json
{ "extends": "./tsconfig.json", "include": ["tests", "src"], "compilerOptions": { "noEmit": true } }
```
`package.json` 에 `"typecheck:tests": "tsc -p tsconfig.test.json --noEmit"`.

> **주의:** 이걸 돌리면 단계 3 내내 에디터가 띄운 `cli.test.ts` 의 유니언 타입 에러(`skipped` 접근) 등이 **실제 에러로 드러날 수 있다.** 그건 이 태스크가 여는 판도라 상자다. **`typecheck:tests` 를 `build` 체인이나 `pretest` 에 넣지 마라** — 별도 스크립트로만 두고, 드러난 에러 목록을 리포트에 담되 **이 태스크에서 고치지 마라**(별도 후속). 목적은 "명령이 존재하게 하는 것"이지 "tests 를 다 초록으로 만드는 것"이 아니다. 만약 에러가 20건 넘으면 리포트에 개수만 적고 진행.

- [ ] **Step 5: 게이트 + 커밋**

```bash
npm run typecheck        # src 는 여전히 초록
npm run build            # 전 체인(잔재 스캔 포함) 초록
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
```
Expected: build 0, 스위트 실패 ⊆ 6건. `typecheck:tests` 는 초록일 필요 없음(존재만; 출력은 리포트로).

```bash
git add package.json .gitignore scripts/assert-no-removed-platforms.mjs src/session/analytics.ts tsconfig.test.json
git commit -m "chore(phase-4): typecheck:tests harness, dead analytics locals, .tmp ignore, scan+prepublish tidy

Adds tsconfig.test.json + typecheck:tests (tests/ was editor-only-checked
all phase 3) — NOT wired into build/pretest; surfaced errors are logged for
a separate follow-up, not fixed here. Removes 4 dead analytics locals
(refs=1, definition-only). Adds *.tmp to .gitignore, start.mjs to the
residue-scan GATED tier, drops the private-unreachable prepublishOnly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 전체 검증 + phase-4 잔여 목록 추적 문서화

**Files:**
- Create: `docs/superpowers/phase-4-plus-candidates.md` (원장의 untracked 목록을 추적 문서로 승격 — whole-branch 리뷰 권고)

- [ ] **Step 1: 전체 스위트 최종**

```bash
npm run build
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
```
Expected: 실패 ⊆ 6건. deps-heal/orphan-reaper 신규 테스트 포함 통과.

- [ ] **Step 2: phase-4+ 후보를 추적 문서로**

`docs/superpowers/phase-4-plus-candidates.md` 신규 — 원장(`.superpowers/sdd/progress.md`, untracked)에 흩어진 후속 후보를 committed 문서로 승격:
- 하드페일 init-await (server.ts: `getClientVersion()` 부팅 시 undefined → removed-client 는 요청 경계에서만 발화; boot-catch 소스 핀 동반).
- `typecheck:tests` 가 드러낸 tests/ 타입 에러(이 태스크 Step 4 의 개수 기록).
- 정적 import 가 sibling 부재 시 npm install 을 죽이는 상류 결함(postinstall — Task 3b 웨이브에서 관측).
- client-map allowlist file-wide 항목의 linePattern 타이트닝.
- TOOL_ALIASES vs extract.ts 비대칭 문서화.
각 항목에 근거(파일:줄 또는 원장 참조)와 위험도.

- [ ] **Step 3: 커밋**

```bash
git add docs/superpowers/phase-4-plus-candidates.md
git commit -m "docs: promote the phase-4+ candidate list to a tracked document

The follow-up backlog lived only in the untracked .superpowers/ ledger;
the whole-branch review flagged that as a durability risk. Committed here.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 이 계획이 하지 않는 것

- **사용자 `~/.claude/hooks/*` 나 `settings.json` 을 고치지 않는다.** 흡수된 저장소 훅이 실제로 배포·실행되는 것은 단계 6 커토버 이후다. 그때까지 사용자 레벨의 기존 훅이 계속 동작한다(무해한 이중화 — 저장소 훅은 아직 배포 안 됨).
- **`typecheck:tests` 가 드러낸 tests/ 타입 에러를 고치지 않는다.** 명령을 존재하게만 한다. 별도 후속.
- **하드페일 init-await 를 구현하지 않는다.** 동작 변경이라 별 계획감. phase-4+ 문서에 기록.
- **lock-heal / cache-heal / prune-versions 를 흡수하지 않는다.** 스펙 §9.0 은 deps-heal·orphan-reaper 둘만 단계 4 흡수 대상으로 지정. cache-heal 은 이미 `start.mjs` 템플릿(단계 3 Task 3)이 처리.
- **ensure-deps.mjs 를 건드리지 않는다.** better-sqlite3 담당 유지 — deps-heal(순수-JS)과 책임 분리.
