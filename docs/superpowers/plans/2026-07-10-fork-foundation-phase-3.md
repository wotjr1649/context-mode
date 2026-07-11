# 단계 3 — 삭제 실행 + `pluginKey` 파생 + 번들 신선도 가드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비지원 클라이언트 15종을 저장소에서 제거하고(204파일), 하드코딩된 `pluginKey` 리터럴을 `__dirname` 파생으로 바꿔 죽어 있던 자가치유 2개를 되살리고, 스테일 번들이 조용히 배포되는 경로를 pre-commit 가드로 막는다.

**Architecture:** 작업 브랜치에서 점진 커밋 → `main`에 squash 1커밋. 위험이 낮고 독립적인 자가치유 수정(Task 1–3)을 먼저 처리해 각각 리뷰 가능한 단위로 만든 뒤, 되돌리기 어려운 대량 삭제(Task 4–6)를 스펙 §8.2의 **네 겹 그물**(tsc → 삭제 → 단어경계 grep → `.mjs` 수동검토 → 런타임 하드페일)로 감싼다. 번들 재생성은 **마지막 커밋에서만** 한다 — 커밋된 `*.bundle.mjs`가 설치본에서 실제로 실행되는 코드이므로, 스테일 번들은 CI 빨간불이 아니라 런타임에 옛 코드가 조용히 도는 것이다.

**Tech Stack:** TypeScript 5 (`tsc --noEmit`), esbuild 0.27, vitest 3, Node ESM (`.mjs` 훅), git `core.hooksPath`

---

## Global Constraints

스펙 §11 + `CLAUDE.md`. **모든 태스크의 요구사항에 암묵적으로 포함된다.**

- 파일 출력은 **UTF-8 (BOM 없음), LF**. 커밋 전 CR 바이트 0 확인.
- **`npm version` 금지.** 태그 `v1.0.0`·`v1.0.1`이 이미 존재해 커밋 후 실패한다. `package.json`을 손으로 고치고 `npm run version-sync`.
- **`git fetch upstream --tags` / `git push origin --tags` 금지.** 상류 태그 198개가 origin에 재유입된다.
- **`upstream/main`을 `main`에 merge 금지.** 하드 포크다.
- **vitest는 메모리 캡 필수:** `--pool=forks --maxWorkers=1`, `NODE_OPTIONS=--max-old-space-size=2048`. 전체 스위트를 캡 없이 돌리면 OOM으로 죽는다.
- **`npm test`를 쓰지 마라 (레드 구간에서).** `pretest: npm run build`가 걸려 있어 삭제 도중엔 빌드가 먼저 터진다. 대신 `npx vitest run` 을 직접 부른다.
- **`assert-bundle`은 스테일 번들을 못 잡는다.** `__require("node:...")` 셰임만 스캔한다. 번들 신선도는 Task 11의 pre-commit 가드가 유일한 방어선이다.
- **`version`은 단계 3~5 내내 `1.0.0` 고정.** 스펙 §6.3 — Claude는 단계 2에서 설치한 트리(삭제 이전 코드)를 계속 실행한다. **이 계획의 게이트는 전부 로컬이다.** 삭제가 라이브가 되는 건 단계 6의 `1.0.1` 상향에서다.
- **`src/adapters/codex/index.ts`의 `"context-mode@context-mode"` 리터럴 9곳은 건드리지 않는다.** Codex 카탈로그명은 그대로 유지하기로 결정됐다(스펙 §8.2-9b).
- **Claude 훅에서 stderr 출력 금지.**
- **`~/.claude/hooks/context-mode-cache-heal.mjs` 손으로 수정 금지.** `start.mjs`가 매 부팅 덮어쓴다.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **코드 주석은 영어로 쓴다.** 이 저장소의 기존 주석은 전부 영어다(상류에서 왔고, 상류로 PR 을 보낼 수도 있다).
  **이 계획의 코드 블록에 있는 한국어 주석은 구현자에게 의도를 설명하는 산문이지 그대로 붙여넣을 코드가 아니다.**
  주변 파일의 언어·톤에 맞춰라. (Task 2 리뷰에서 Minor 로 잡혔다 — 한 커밋 안에서 언어가 갈렸다.)
- **`node -e "…"` 은 이 머신에서 deny 된다** (`settings.json` 의 `Bash(node -e:*)`). 이 계획의 검증
  스니펫은 전부 `node -e` 로 적혀 있다. **그대로 붙여넣지 마라.** 둘 중 하나로 실행한다:
  1. 스니펫을 `.superpowers/sdd/<이름>.mjs` 에 쓰고 `node .superpowers/sdd/<이름>.mjs` — 재실행·리뷰 가능하고 `.superpowers/` 는 추적되지 않는다. **권장.**
  2. `ctx_execute(language: "javascript", code: "…")` — 샌드박스에서 돌고 stdout 만 컨텍스트로 들어온다.
  deny 를 우회하려 `node --eval` 이나 `sh -c` 로 감싸지 마라. 가드는 이유가 있어 존재한다.

---

## 실측 정정 — 스펙의 좌표가 현실과 어긋난 8곳

**스펙 §8.2의 줄번호를 신뢰하지 마라.** 아래는 이 계획을 쓰며 저장소에서 직접 측정한 값이다(2026-07-10, HEAD `a048215`). 스펙과 다른 곳은 **이 표가 권위**다.

| # | 스펙이 말한 것 | 실측 |
|---|---|---|
| Δ1 | `hooks/cache-heal-utils.mjs:291`의 `versionSegmentRe` | 확인. 정의는 `291-292`, **사용은 `309`**. 정규식 = `/(context-mode[/\\]context-mode[/\\])([^/\\]+)([/\\]bin)/g` |
| Δ2 | `heal-installed-plugins.mjs:547-557` | 파일은 **`scripts/`** 에 있다. `sweepStaleMcpJson` 정의 `534`, 반전 매핑 **`547-557`** (일치), JSDoc 오류 `528`·`531` |
| Δ3 | `foreignWorkspaceEnv`/`foreignIdentificationEnv`가 `types.ts` | **`src/adapters/detect.ts`**, `src/adapters/pi/mcp-bridge.ts`(어차피 삭제), `src/util/project-dir.ts` |
| Δ4 | "락파일은 `bun.lock`뿐" | 맞다 — `package-lock.json`은 `.gitignore` 됨. (F55 결정으로 무의미해짐) |
| Δ5 | `session-attribution.bundle.mjs`가 "어느 목록에도 없다 → 미사용 확인 후 제거 가능" | **살아 있다.** `hooks/session-loaders.mjs:42`와 `scripts/plugin-cache-integrity.mjs:137`이 로드한다. 소스는 `src/session/project-attribution.ts`. **제거가 아니라 `bundle`·`assert-bundle`에 편입**해야 한다 |
| Δ6 | `src/util/sibling-mcp.ts:68`이 "캐시 경로 리터럴" | **68은 주석이다.** 실제 패턴 `72-73`·`82`는 `.*context-mode.*` 와일드카드라 개명 후에도 **정상 동작한다.** 코드 수정 불필요 — 주석만 갱신 |
| Δ7 | 하드코딩 `pluginKey` = `postinstall(6)·cli(5)·server(1)` | 일치. **추가로 테스트 7파일 38곳**이 이 리터럴에 묶여 있다 (`tests/util/heal-installed-plugins.test.ts` 혼자 27곳). 스펙이 누락한 작업이다 |
| Δ8 | 그물 2 = "16개 식별자 저장소 전체 grep" | **나이브 substring grep은 못 쓴다.** 측정: `omp` → 350파일 매치(단어경계 35), `pi` → 359(62), `zed` → 95(28). `prOMPt`·`cOMPact`·`aPI`·`PIpeline`·`sei ZED`… **단어경계 매칭 필수** |
| Δ9 | 하드코딩 캐시 경로 리터럴 = `cli.ts:1642` 뿐 | **`hooks/sessionstart.mjs:151-157` 도 `cache/context-mode/context-mode` 를 하드코딩한다.** 매 세션 도는 살아 있는 코드다. **Task 2 가 처리한다** (Task 3 아님) — 셸 스냅샷 신뢰 앵커의 재료이기 때문이다 |
| Δ10 | Task 2 = "정규식을 와일드카드로 넓힌다" | **보안 회귀다.** `tests/hooks/shell-snapshot-heal.test.ts:270` 이 `cache/evil-owner/context-mode/` 는 재작성 금지라고 단언한다(죽은 PATH 항목이 공격자 디렉토리로 재지정되는 경로). 앵커를 **파생**해야 한다. Task 2 실행 중 구현자가 발견 |
| Δ11 | 앵커의 재료 = `pluginCacheRoot` | **그 이름은 이미 `…/plugins/cache`(얕은 뜻)를 가리킨다** — `postinstall.mjs:121`, `cli.ts:1588,1618`, `heal-installed-plugins.mjs` 의 네 함수, 그리고 `sessionstart-shell-snapshot-heal.test.ts:59`. 오직 `hooks/sessionstart.mjs:151-157` 만 깊은 뜻으로 쓴다(값이 버려져 왔기 때문에 아무도 몰랐다). 재료는 **`pluginRoot`** 다 — 세그먼트가 앵커와 같은 순서로 나와 인덱스 교차(F42/F54 버그 클래스)가 사라진다 |

---

## File Structure

**신규 (2):**
- `.githooks/pre-commit` — 번들 신선도 가드. 추적되는 훅(husky 의존성 없음), `git config core.hooksPath .githooks`로 활성화
- `tests/hooks/cache-heal-version-segment.test.ts` — Δ1 회귀 테스트

**대량 삭제 (204):** `src/adapters/<15>/`, `hooks/<9>/`, `hooks/formatters/`, `configs/<16>/`, `tests/adapters/<31>`, `tests/<21>`, `.cursor-plugin/`, `.openclaw-plugin/`, `.pi/`, openclaw 루트·스크립트, `docs/adapters/<2>`, `docs/jetbrains-copilot.md`

**핵심 편집 (책임 단위):**
- `scripts/heal-installed-plugins.mjs` — 키→경로 매핑의 **단일 진실 원천**. `derivePluginKey()`가 여기 산다 (이미 "Single source of truth shared by start.mjs / postinstall.mjs / cli.ts"라고 자칭한다)
- `hooks/cache-heal-utils.mjs` — 셸 스냅샷 자가치유
- `src/adapters/detect.ts` · `client-map.ts` — 플랫폼 라우팅. 축소의 진앙
- `hooks/core/{tool-naming,formatters,platform-detect,routing}.mjs` · `hooks/session-helpers.mjs` — `tsc` 밖. 그물 3의 대상
- `scripts/version-sync.mjs` · `package.json` — 매니페스트 동기화

---

## Task 1: 작업 브랜치 + F54 — `sweepStaleMcpJson` 키→경로 반전 수정

죽어 있는 자가치유 넷 중 하나. **개명 전에는 마켓플레이스명과 플러그인명이 둘 다 `context-mode`라 우연히 맞았다.** 개명 후 `cache/context-mode/context-mode-js`를 찾으므로 항상 `skipped: "no-plugin-dir"`를 반환한다.

**Files:**
- Modify: `scripts/heal-installed-plugins.mjs:526-533` (JSDoc), `:547-557` (매핑)
- Test: `tests/util/postinstall-heal-mcp-json.test.ts`

**Interfaces:**
- Produces: `sweepStaleMcpJson({ pluginCacheRoot, pluginKey })` — 계약 불변. `pluginKey`는 `"<plugin>@<marketplace>"`, 경로는 `<cacheRoot>/<marketplace>/<plugin>/<x.y.z>/`

- [ ] **Step 1: 브랜치를 판다**

```bash
git -C C:/Users/js/Documents/ClaudeCode/context-mode switch -c spec/fork-phase-3 main
git status --porcelain   # 비어 있어야 한다
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`tests/util/postinstall-heal-mcp-json.test.ts` 끝에 추가:

```ts
it("sweeps .mcp.json when marketplace name differs from plugin name", () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-rename-"));
  // 실제 레이아웃: cache/<marketplace>/<plugin>/<version>/
  const versionDir = join(root, "context-mode-js", "context-mode", "1.0.0");
  mkdirSync(versionDir, { recursive: true });
  const stale = join(versionDir, ".mcp.json");
  writeFileSync(stale, "{}", "utf-8");

  // 레지스트리 키 형태: <plugin>@<marketplace>
  const result = sweepStaleMcpJson({
    pluginCacheRoot: root,
    pluginKey: "context-mode@context-mode-js",
  });

  expect(result.skipped).toBeUndefined();
  expect(result.removed).toEqual([stale]);
  expect(existsSync(stale)).toBe(false);
});
```

- [ ] **Step 3: 실패를 확인한다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/util/postinstall-heal-mcp-json.test.ts
```
Expected: FAIL — `result.skipped` 가 `"no-plugin-dir"`. (`removed` 는 `[]`)

> 이 실패 문자열이 **정확히 `"no-plugin-dir"`인지 확인하라.** `"outside-cache-root"`나 `"bad-plugin-key"`가 나오면 가정이 틀린 것이므로 멈추고 보고한다.

- [ ] **Step 4: 매핑을 뒤집는다**

`scripts/heal-installed-plugins.mjs:547-557`:

```js
  // pluginKey shape: "<plugin>@<marketplace>"  (Claude Code 레지스트리 키)
  // cache layout:    <cacheRoot>/<marketplace>/<plugin>/<x.y.z>/
  // 개명 전에는 두 이름이 같아 반전이 드러나지 않았다.
  const segments = pluginKey.split("@");
  if (segments.length !== 2) {
    return { removed, skipped: "bad-plugin-key" };
  }
  const [pluginSegment, marketplaceSegment] = segments;
  // 세그먼트 자체를 검증한다. root guard 만으로는 부족하다 —
  // `../victim@context-mode-js` 는 `<cacheRoot>/victim` 으로 정규화되어
  // `startsWith(cacheRoot + sep)` 를 **통과한다**. (Codex 리뷰 Important 2)
  const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
  if (!SAFE_SEGMENT.test(pluginSegment) || !SAFE_SEGMENT.test(marketplaceSegment)
      || pluginSegment === ".." || marketplaceSegment === "..") {
    return { removed, skipped: "bad-plugin-key" };
  }

  // Path-traversal guard (2차 방어): resolve 는 `/` 와 `\` 를 모두 정규화한다.
  const pluginDir = resolve(resolvedCacheRoot, marketplaceSegment, pluginSegment);
  const cacheRootWithSep = resolvedCacheRoot + sep;
  if (!pluginDir.startsWith(cacheRootWithSep)) {
    return { removed, skipped: "outside-cache-root" };
  }

  if (!existsSync(pluginDir)) {
    return { removed, skipped: "no-plugin-dir" };
  }
```

세그먼트 검증 테스트도 함께 쓴다:

```ts
it("rejects a traversal segment that normalizes back inside the cache root", () => {
  const result = sweepStaleMcpJson({ pluginCacheRoot: root, pluginKey: "../victim@context-mode-js" });
  expect(result.skipped).toBe("bad-plugin-key");
  expect(result.removed).toEqual([]);
});

it("rejects a key with more than two segments", () => {
  expect(sweepStaleMcpJson({ pluginCacheRoot: root, pluginKey: "a@b@c" }).skipped).toBe("bad-plugin-key");
});
```

이어지는 `ownerDir` 참조를 전부 `pluginDir`로 바꾼다 (`:563`, `:570`, `:576`, `:579`).

JSDoc(`:526-533`)도 고친다:

```js
/**
 * Remove every `.mcp.json` from per-version directories under
 * `<pluginCacheRoot>/<marketplace>/<plugin>/<X.Y.Z>/`.
 *
 * @param {{ pluginCacheRoot: string, pluginKey: string }} opts
 *   pluginKey is the "<plugin>@<marketplace>" form (e.g. "context-mode@context-mode-js").
 * @returns {SweepResult}
 */
```

- [ ] **Step 5: 통과를 확인한다 — 신·구 키 둘 다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/util/postinstall-heal-mcp-json.test.ts tests/util/heal-installed-plugins.test.ts tests/hooks/cache-heal-self-heal.test.ts
```
Expected: PASS 전부. **기존 `context-mode@context-mode` 케이스도 여전히 통과해야 한다** — 두 세그먼트가 같으므로 반전 여부와 무관하게 같은 경로가 나온다. 하나라도 깨지면 다른 곳이 이 반전에 의존하고 있다는 뜻이니 멈추고 보고한다.

- [ ] **Step 6: 커밋**

```bash
git add scripts/heal-installed-plugins.mjs tests/util/postinstall-heal-mcp-json.test.ts
git commit -m "fix(heal): sweepStaleMcpJson maps <plugin>@<marketplace> to <marketplace>/<plugin>

The key->path mapping was inverted. It only worked because upstream's
marketplace and plugin names are both 'context-mode'. F54.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: F52 — `versionSegmentRe`가 개명된 캐시 부모를 매칭하지 못한다

`hooks/cache-heal-utils.mjs`의 셸 스냅샷 자가치유. **주석이 아니라 `sessionstart.mjs`가 매 세션 호출하는 살아 있는 코드다.** 현재 정규식은 `context-mode/context-mode/`에 앵커되어 `context-mode-js/context-mode/`에서 no-match → 이 자가치유는 fork에서 영구 no-op이다.

### ⚠️ 초안의 와일드카드는 보안 속성을 버린다 — 실행 중 발견 (2026-07-10)

이 계획의 1판은 정규식을 `/(cache[/\\][^/\\]+[/\\]context-mode[/\\])…/` 로 바꾸라고 했다. **틀렸다.**

`tests/hooks/shell-snapshot-heal.test.ts:270` 이 단언한다 — `cache/evil-owner/context-mode/1.0.146/bin` 은 **절대 재작성되지 않아야 한다.** 기존 코드의 주석이 그 이유를 적어놨다:

> The doubled `context-mode/context-mode/` is the trust anchor — it prevents shape-spoofing from another owner.

위협: 악의적 플러그인이 `cache/evil-owner/context-mode/<옛버전>/bin` 을 심어두면, 힐이 그 죽은 PATH 항목을 **살아 있는 공격자 디렉토리로 "친절하게" 재지정**한다. 와일드카드 `[^/\\]+` 는 `evil-owner` 와 `context-mode-js` 를 구별하지 못한다 — 모양이 같다.

**해법 (사용자 결정): 신뢰 앵커를 하드코딩하지도 와일드카드로 열지도 말고, 우리가 실제로 설치된 트리에서 파생한다.**

### 파라미터는 `pluginRoot` 다 — `pluginCacheRoot` 가 아니다 (Δ11)

초안은 `pluginCacheRoot` 에서 마지막 두 세그먼트를 떼라고 했다. **그 이름은 이 저장소에서 이미 다른 뜻이다.**

| 위치 | `pluginCacheRoot` 의 의미 |
|---|---|
| `scripts/postinstall.mjs:121` · `src/cli.ts:1588,1618` · `scripts/heal-installed-plugins.mjs` 의 네 함수 | **`…/plugins/cache`** (얕은 것) |
| `tests/hooks/sessionstart-shell-snapshot-heal.test.ts:59` | `join(root, "cache")` — 같은 얕은 뜻 |
| **`hooks/sessionstart.mjs:151-157`** | `…/cache/context-mode/context-mode` — **혼자 다르다** |

함수가 그 값을 버려왔기 때문에 아무도 이 불일치를 몰랐다. 초안의 Step 3 은 하필 그 예외의 의미 위에 서 있었다.

**대신 `pluginRoot` 를 받는다** (`…/cache/<marketplace>/<plugin>/<version>`). 두 이유:

1. **`rewriteShellSnapshots` 는 파일시스템을 만지지 않는다.** 스냅샷 *텍스트*를 고친다. 그래서 경로를 걷는 힐들이 쓰는 `{pluginCacheRoot, pluginKey}` 모양이 애초에 안 맞는다 — 억지로 끼운 결과가 바로 `selfHealShellSnapshots` 의 버려지는 인자다.
2. **인덱스 교차가 사라진다.** 앵커는 `cache/<marketplace>/<plugin>/` 이고 `pluginRoot` 를 쪼개면 세그먼트가 **그 순서 그대로** 나온다 (`mkt = parts[-3]`, `plg = parts[-2]`). `pluginKey.split("@")` 는 `[plugin, marketplace]` 를 줘서 `cache/${[1]}/${[0]}/` 로 **뒤집어야** 한다 — 그게 F42(`start.mjs` 캡처 순서)와 F54(`sweepStaleMcpJson`)를 낳은 바로 그 버그 클래스다. 함정에 경고문을 붙이는 것보다 함정을 없애는 게 낫다.

**덤:** `hooks/sessionstart.mjs:151-157` 이 `cache/context-mode/context-mode` 를 **하드코딩**한다. 매 세션 도는 살아 있는 코드다. 이 계획의 Task 3 리터럴 목록이 놓친 파일이다 — 여기서 함께 죽는다.

**Files:**
- Modify: `hooks/cache-heal-utils.mjs` — `rewriteShellSnapshots` 가 `pluginRoot` 를 받아 앵커를 만든다. `selfHealShellSnapshots` 의 **버려지는 `pluginCacheRoot` 인자를 `pluginRoot` 로 교체**한다
- Modify: `hooks/sessionstart.mjs:140-162` — 하드코딩된 `pluginCacheRoot` 블록을 지우고 `pluginRoot` 를 **그대로** 넘긴다
- Modify: `src/cli.ts:1504-1514` — `:1254` 의 `pluginRoot` 를 넘기고 `:1509` 의 인라인 타입 주석을 갱신한다
- Modify: `tests/hooks/shell-snapshot-heal.test.ts` (호출 16곳) · `tests/cli/upgrade-rewrites-shell-snapshots.test.ts` (4곳) · **`tests/hooks/sessionstart-shell-snapshot-heal.test.ts` (4곳)** — 새 인자를 넘기도록
- Create: `tests/hooks/cache-heal-version-segment.test.ts`

> **초안의 "sessionstart 테스트는 손대지 마라"는 틀렸다.** 그 파일은 `pluginCacheRoot: join(root,"cache")` 를 넘긴다 — 얕은 뜻이다. 새 코드에선 깊이 가드에 걸려 no-op 이 되고 `expect(result.rewritten).toEqual([file])` 가 실패한다.

**Interfaces:**
- Produces: `rewriteShellSnapshots({ snapshotsDir, currentVersion, pluginRoot })` — `pluginRoot` 는 **필수**이며 `…/cache/<marketplace>/<plugin>/<version>` 형태여야 한다. 아니면 **no-op** (`{ rewritten: [] }`). 잘못된 트리를 고치느니 안 고치는 게 낫다 — `~/.claude` 커밋 `3fa7c60`(Task 4b)의 원칙과 같다.
- Produces: `selfHealShellSnapshots({ snapshotsDir, pluginRoot, currentVersion })` — 버려지던 `pluginCacheRoot` 를 **없앤다**.

> ⚠️ **깊이 함정.** no-op 은 보안상 안전하게 실패하지만, **바로 이 태스크가 고치려는 "힐이 조용히 죽는" 상태를 되살린다.** 그래서 테스트는 반드시 **버전 세그먼트까지 붙은 진짜 `pluginRoot`** 를 먹여야 한다. 스텁을 먹이면 깊이 실수가 초록으로 통과한다. 그리고 어느 호출부도 `resolve(pluginRoot, "..")` 를 넘기면 안 된다 — 초안의 잔재다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/hooks/cache-heal-version-segment.test.ts` 신규. **네 가지를 고정한다: fork 레이아웃은 고쳐지고, upstream 레이아웃도 여전히 고쳐지고, 남의 소유자 디렉토리는 절대 손대지 않고, 앵커가 없으면 아무것도 안 한다.**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteShellSnapshots } from "../../hooks/cache-heal-utils.mjs";

describe("rewriteShellSnapshots — trust anchor derived from pluginRoot (F52)", () => {
  let dir: string;
  let snapshots: string;

  // 진짜 pluginRoot 모양: …/cache/<marketplace>/<plugin>/<version>
  // 버전 세그먼트를 빼먹으면 깊이 가드가 no-op 을 내고 테스트가 거짓 초록이 된다.
  const pluginRootFor = (marketplace: string) =>
    `/home/u/.claude/plugins/cache/${marketplace}/context-mode/1.0.0`;

  const writeSnapshot = (name: string, body: string) => {
    const p = join(snapshots, name);
    writeFileSync(p, body, "utf-8");
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snap-"));
    snapshots = join(dir, "shell-snapshots");
    mkdirSync(snapshots, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rewrites a stale version under the fork's context-mode-js/context-mode/", () => {
    const snap = writeSnapshot(
      "snapshot-bash-1.sh",
      'export PATH="/home/u/.claude/plugins/cache/context-mode-js/context-mode/0.9.9/bin:$PATH"\n',
    );
    rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: pluginRootFor("context-mode-js"),
    });
    expect(readFileSync(snap, "utf-8")).toContain("cache/context-mode-js/context-mode/1.0.0/bin");
  });

  it("still rewrites the un-renamed upstream layout when that is the anchor", () => {
    const snap = writeSnapshot(
      "snapshot-bash-2.sh",
      'export PATH="/home/u/.claude/plugins/cache/context-mode/context-mode/0.9.9/bin:$PATH"\n',
    );
    rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: pluginRootFor("context-mode"),
    });
    expect(readFileSync(snap, "utf-8")).toContain("cache/context-mode/context-mode/1.0.0/bin");
  });

  // 판별 테스트. fork 의 이름은 비대칭이다(context-mode-js ≠ context-mode).
  // marketplace/plugin 을 뒤집어 슬라이스하면 이 테스트가 실패한다.
  it("never touches another owner's directory, even under the fork anchor", () => {
    const original =
      'export PATH="/home/u/.claude/plugins/cache/evil-owner/context-mode/0.9.9/bin:/usr/bin"\n';
    const snap = writeSnapshot("snapshot-bash-spoof.sh", original);
    rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: pluginRootFor("context-mode-js"),
    });
    expect(readFileSync(snap, "utf-8")).toBe(original);
  });

  // 4·5 는 **upstream 레이아웃 내용**을 쓴다. fork 레이아웃을 쓰면 옛 코드가 어차피
  // no-op 이라 단언이 공허하게 통과한다 — 판별력 0. upstream 내용이면 옛 코드는
  // 앵커를 보지 않고 재작성하므로 FAIL, 새 코드는 가드에 걸려 no-op 이라 PASS 다.
  it("no-ops when pluginRoot is absent — refuses to heal a tree it cannot name", () => {
    const original =
      'export PATH="/home/u/.claude/plugins/cache/context-mode/context-mode/0.9.9/bin"\n';
    const snap = writeSnapshot("snapshot-bash-noanchor.sh", original);
    const result = rewriteShellSnapshots({ snapshotsDir: snapshots, currentVersion: "1.0.0" });
    expect(result.rewritten).toEqual([]);
    expect(readFileSync(snap, "utf-8")).toBe(original);
  });

  // 깊이 함정: 부모를 넘기면(초안의 잔재) 조용히 no-op 한다. 그것을 고정한다.
  // `…/cache/context-mode/context-mode` 는 parts[-4] === "plugins" 이라 가드에 걸린다.
  it("no-ops when handed the cache parent instead of the versioned pluginRoot", () => {
    const original =
      'export PATH="/home/u/.claude/plugins/cache/context-mode/context-mode/0.9.9/bin"\n';
    const snap = writeSnapshot("snapshot-bash-depth.sh", original);
    const result = rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: "/home/u/.claude/plugins/cache/context-mode/context-mode",
    });
    expect(result.rewritten).toEqual([]);
    expect(readFileSync(snap, "utf-8")).toBe(original);
  });
});
```

> export 이름은 실측했다: `rewriteShellSnapshots(...)` (`hooks/cache-heal-utils.mjs:262`). 얇은 래퍼 `selfHealShellSnapshots` 가 `:352` 에 따로 있다 — 정규식은 `rewriteShellSnapshots` 안에 있다.

- [ ] **Step 2: 실패를 확인한다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/hooks/cache-heal-version-segment.test.ts
```
Expected: **1 FAIL, 2 PASS, 3 PASS, 4 FAIL, 5 FAIL.**

옛 정규식은 `/(context-mode[/\\]context-mode[/\\])([^/\\]+)([/\\]bin)/g` 다. 실측한 매칭 행동:

| 스냅샷 내용 | 옛 정규식 |
|---|---|
| `cache/context-mode-js/context-mode/0.9.9/bin` (fork) | **no match** → no-op |
| `cache/context-mode/context-mode/0.9.9/bin` (upstream) | MATCH → 재작성 |
| `cache/evil-owner/context-mode/0.9.9/bin` | no match → no-op |

- **1 FAIL**: fork 내용을 옛 코드가 못 고친다. 이 태스크의 헤드라인.
- **2 PASS / 3 PASS**: 회귀 핀. 옛 코드도 새 코드도 같은 답을 낸다.
- **4·5 FAIL**: upstream 내용이므로 옛 코드는 앵커를 보지 않고 **재작성한다** → `rewritten: []` 단언이 깨진다. 새 코드는 앵커가 없거나(4) 깊이가 틀려서(5) no-op 이라 통과한다.

> **4·5 의 내용을 fork 레이아웃으로 쓰면 안 된다.** 옛 코드가 어차피 no-op 이라 단언이 공허하게 통과하고(`1 FAIL / 4 PASS`), 그 두 테스트는 이 변경에 대해 아무것도 증명하지 못한다. Task 2 의 3차 시도가 정확히 이걸 관측하고 멈췄다.

- [ ] **Step 3: 앵커를 `pluginRoot` 에서 파생한다**

`hooks/cache-heal-utils.mjs` 의 `rewriteShellSnapshots`:

```js
export function rewriteShellSnapshots({ snapshotsDir, currentVersion, pluginRoot }) {
  const out = { rewritten: [] };
  if (
    !snapshotsDir || typeof snapshotsDir !== "string" ||
    !currentVersion || typeof currentVersion !== "string" ||
    !pluginRoot || typeof pluginRoot !== "string"
  ) {
    return out;
  }

  // 신뢰 앵커. pluginRoot 는 `…/cache/<marketplace>/<plugin>/<version>` 이다.
  // 세그먼트가 앵커와 **같은 순서로** 나온다 — 뒤집을 일이 없다(F42/F54 의 버그 클래스 회피).
  // upstream 은 doubled `context-mode/context-mode/` 리터럴로 같은 속성을 얻었지만,
  // 그건 마켓플레이스 개명에서 깨진다. 와일드카드로 열면 `cache/evil-owner/context-mode/`
  // 도 매칭되어 죽은 PATH 항목을 공격자 디렉토리로 재지정한다 — shell-snapshot-heal.test.ts:270.
  const parts = pluginRoot.split(/[/\\]/).filter(Boolean);
  const marketplace = parts[parts.length - 3];
  const plugin = parts[parts.length - 2];
  if (!marketplace || !plugin || parts[parts.length - 4] !== "cache") return out;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // $1 — `cache/<marketplace>/<plugin>/`  $2 — version  $3 — separator + `bin`
  const versionSegmentRe = new RegExp(
    `(cache[/\\\\]${esc(marketplace)}[/\\\\]${esc(plugin)}[/\\\\])([^/\\\\]+)([/\\\\]bin)`,
    "g",
  );
  …
```

`selfHealShellSnapshots` (`:352`) 는 버려지던 인자를 **없앤다**:

```js
export function selfHealShellSnapshots({ snapshotsDir, pluginRoot, currentVersion }) {
  return rewriteShellSnapshots({ snapshotsDir, currentVersion, pluginRoot });
}
```

`:345-350` 의 "not yet used … forward-compat" JSDoc 문단을 지우고 실제 용도를 적어라.

- [ ] **Step 4: 두 호출부가 `pluginRoot` 를 그대로 넘기게 한다**

**어느 호출부도 `resolve(pluginRoot, "..")` 를 넘기면 안 된다.** 함수는 버전 깊이를 기대한다. 부모를 넘기면 깊이 가드에 걸려 조용히 no-op 한다 — 이 태스크가 고치려는 바로 그 상태다.

`hooks/sessionstart.mjs:140-162` — `pluginCacheRoot` 를 만드는 하드코딩 블록(`:151-157`)을 통째로 지운다. `pluginRoot` 는 `:140-141` 의 안쪽 `try` 에 갇혀 있으니 바깥으로 끌어올린다:

```js
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(HOOK_DIR, "..");
      …
      selfHealShellSnapshots({ snapshotsDir, pluginRoot, currentVersion });
```

개발 체크아웃처럼 캐시 밖에서 돌면 `parts[-4] !== "cache"` 라 힐이 조용히 no-op 한다. **의도된 동작이다.**

`src/cli.ts:1504-1514` — `:1254` 의 `let pluginRoot = getPluginRoot()` 가 스코프에 있다(업그레이드 후 새 버전 디렉토리를 가리킨다). 그것을 넘기고, `:1509` 의 인라인 타입 주석 `{ snapshotsDir: string; currentVersion: string }` 에 `pluginRoot: string` 를 추가하라. **없으면 `tsc` 가 실패한다.**

- [ ] **Step 5: 기존 호출부 24곳을 새 인자로 갱신한다**

세 파일이 낡은 인자로 부른다 → 새 코드에선 전부 no-op 이라 실패한다. 각 파일 상단에 진짜 `pluginRoot` 상수를 하나 두고 넘겨라.

| 파일 | 호출 | 지금 넘기는 것 |
|---|---:|---|
| `tests/hooks/shell-snapshot-heal.test.ts` | 16 | 아무것도 안 넘김 |
| `tests/cli/upgrade-rewrites-shell-snapshots.test.ts` | 4 | 아무것도 안 넘김 |
| `tests/hooks/sessionstart-shell-snapshot-heal.test.ts` | 4 | `pluginCacheRoot: join(root,"cache")` — **얕은 뜻** |

**`shell-snapshot-heal.test.ts:270` 의 `evil-owner` 테스트를 지우지 마라 — 강화하라.** 이제 명시적 앵커를 받으므로 더 강한 단언이 된다.

- [ ] **Step 6: 통과를 확인한다**

```bash
npm run typecheck
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 \
  tests/hooks/cache-heal-version-segment.test.ts tests/hooks/shell-snapshot-heal.test.ts \
  tests/hooks/sessionstart-shell-snapshot-heal.test.ts tests/hooks/cache-heal-self-heal.test.ts \
  tests/cli/upgrade-rewrites-shell-snapshots.test.ts
```
Expected: PASS 전부. `tsc` 초록(`cli.ts` 타입 주석 때문에 필요하다).

- [ ] **Step 7: 커밋**

```bash
git add hooks/cache-heal-utils.mjs hooks/sessionstart.mjs src/cli.ts tests/
git commit -m "fix(cache-heal): derive the shell-snapshot trust anchor from pluginRoot

The version-segment regex was anchored on the literal doubled segment
context-mode/context-mode/, so it never matched this fork's renamed
context-mode-js/context-mode/ layout — the heal was a permanent no-op (F52).

Widening it to a wildcard would have dropped the anti-spoofing property
that shell-snapshot-heal.test.ts:270 pins: cache/evil-owner/context-mode/
must never be rewritten, or a dead PATH entry gets repointed at an
attacker-controlled directory. Instead the anchor is derived from
pluginRoot's own segments, so it names the tree we actually installed into.
No anchor -> no-op; healing the wrong tree is worse than not healing.

pluginRoot, not pluginCacheRoot: that name already means `.../plugins/cache`
in six places, and only hooks/sessionstart.mjs used it to mean the deeper
path — nobody noticed because selfHealShellSnapshots discarded the value.
pluginRoot also yields marketplace/plugin in path order, so there is no
index crossing to get backwards (the F42/F54 bug class).

sessionstart.mjs hardcoded cache/context-mode/context-mode. Now derived.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `pluginKey` 하드코딩 제거 — `postinstall`(6) · `cli.ts`(5) · `server.ts`(1) · `healScript` 템플릿

**이건 상류 결함이다** — 하드코딩된 키는 `context-mode` 이외의 마켓플레이스명을 전부 깨뜨린다. `start.mjs`는 단계 2(`241a864`)에서 이미 `__dirname` 파생으로 고쳤다. 그 패턴을 공유 헬퍼로 승격시켜 나머지 셋에 적용한다.

**Files:**
- Modify: `scripts/heal-installed-plugins.mjs` (헬퍼 추가)
- Modify: `scripts/postinstall.mjs:125,150,168,178,194,216`
- Modify: `src/cli.ts:1553,1589,1619,1642,1811,2012`
- Modify: `src/server.ts:867`
- Modify: `start.mjs:348` (배포되는 `cache-heal.mjs`의 원본 템플릿)
- Modify: `src/util/sibling-mcp.ts:68-71` (**주석만** — Δ6. 패턴 `72-73`·`82`는 와일드카드라 이미 옳다)
- ~~`hooks/sessionstart.mjs:151-157`~~ — **Task 2 가 이미 죽였다** (Δ9). 이 계획의 1판 리터럴 목록이 놓친 파일이다. 매 세션 도는 살아 있는 코드였다. 여기서 다시 손대지 마라
- Test: `tests/util/heal-installed-plugins.test.ts`(27곳) · `tests/util/postinstall-heal.test.ts` · `tests/core/cli.test.ts` · `tests/hooks/cache-heal-self-heal.test.ts` · `tests/util/cli-upgrade-verification.test.ts`

**Interfaces:**
- Produces: `derivePluginKey(pluginRoot: string): string | null` — `<pluginRoot>` 가 `…/plugins/cache/<marketplace>/<plugin>/<version>` 형태면 `"<plugin>@<marketplace>"`, 아니면 `null`. Task 1이 고친 `sweepStaleMcpJson` 의 `pluginKey` 인자와 같은 형태다.
- Produces: `derivePluginCacheParent(pluginRoot: string): string | null` — `…/plugins/cache/<marketplace>/<plugin>` 절대경로. `src/cli.ts:1642`의 하드코딩 대체.

> **`null` 을 반환하지 하드코딩 폴백을 두지 마라.** Task 4b(`~/.claude` 저장소, 커밋 `3fa7c60`)에서 이미 내린 결정이다 — 잘못된 트리를 치유하느니 아무것도 안 하는 게 낫다. `start.mjs:152`의 `?? "context-mode@context-mode"` 폴백은 **부팅 경로라 예외**이며 건드리지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/util/heal-installed-plugins.test.ts` 에 추가:

```ts
import { derivePluginKey, derivePluginCacheParent } from "../../scripts/heal-installed-plugins.mjs";

describe("derivePluginKey", () => {
  it("derives <plugin>@<marketplace> from a cache install path", () => {
    expect(derivePluginKey("/h/.claude/plugins/cache/context-mode-js/context-mode/1.0.0"))
      .toBe("context-mode@context-mode-js");
  });

  it("handles Windows separators", () => {
    expect(derivePluginKey("C:\\Users\\js\\.claude\\plugins\\cache\\context-mode-js\\context-mode\\1.0.0"))
      .toBe("context-mode@context-mode-js");
  });

  it("returns null outside the plugin cache — never a hardcoded fallback", () => {
    expect(derivePluginKey("/h/src/context-mode")).toBeNull();
  });
});

describe("derivePluginCacheParent", () => {
  it("returns <cache>/<marketplace>/<plugin>", () => {
    expect(derivePluginCacheParent("/h/.claude/plugins/cache/context-mode-js/context-mode/1.0.0"))
      .toBe("/h/.claude/plugins/cache/context-mode-js/context-mode");
  });

  it("returns null outside the plugin cache", () => {
    expect(derivePluginCacheParent("/h/src/context-mode")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/util/heal-installed-plugins.test.ts
```
Expected: FAIL — `derivePluginKey is not a function`.

- [ ] **Step 3: 헬퍼를 구현한다**

`scripts/heal-installed-plugins.mjs` 상단(다른 export 옆)에:

```js
// `<…>/plugins/cache/<marketplace>/<plugin>/<version>` 에서 레지스트리 키를 파생한다.
// 캡처 순서 주의: $1=marketplace, $2=plugin. 키는 `<plugin>@<marketplace>` 로 뒤집힌다.
// 뒤집기를 잊으면 upstream 레이아웃(두 이름이 같음)에서 테스트가 통과하면서
// 개명된 fork에서만 조용히 깨진다 — start.mjs 의 같은 파생이 그 함정을 지났다.
const CACHE_PATH_RE = /[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\][^/\\]+[/\\]?$/;

export function derivePluginKey(pluginRoot) {
  if (typeof pluginRoot !== "string") return null;
  const m = pluginRoot.match(CACHE_PATH_RE);
  return m ? `${m[2]}@${m[1]}` : null;
}

export function derivePluginCacheParent(pluginRoot) {
  if (typeof pluginRoot !== "string") return null;
  if (!CACHE_PATH_RE.test(pluginRoot)) return null;
  // `dirname`, NOT `resolve(pluginRoot, "..")` — resolve() 는 상대경로처럼 보이는
  // POSIX 입력을 Windows 에서 cwd 에 붙여 버린다. dirname 은 순수 문자열 연산이다.
  return dirname(pluginRoot);
}
```

`dirname` 을 `node:path` import 에 추가하라 (`resolve`, `sep` 은 이미 있다).

- [ ] **Step 4: 통과를 확인한다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/util/heal-installed-plugins.test.ts
```
Expected: PASS.

- [ ] **Step 5: 여섯 호출 지점을 파생으로 교체한다**

`scripts/postinstall.mjs` — `:125,:150,:178,:194` 의 `pluginKey: "context-mode@context-mode"` 를 파생값으로. `:168`·`:216`의 레지스트리 키 비교도 같은 변수를 쓴다. 파일 상단에서 한 번만 계산한다:

```js
import { derivePluginKey } from "./heal-installed-plugins.mjs";
const PLUGIN_KEY = derivePluginKey(pluginRoot);
```
`PLUGIN_KEY` 가 `null` 이면 자가치유 블록 전체를 건너뛴다(하드코딩 폴백 금지).

`src/cli.ts` — `:1553,:1589,:1619,:1811,:2012` 동일. `:1642` 는 캐시 부모 리터럴이므로:

```ts
const pluginCacheParent = derivePluginCacheParent(pluginRoot);
if (pluginCacheParent) {
  const result = healClaudeJsonMcpArgs({ dotClaudeJsonPath: dotClaudeJson, pluginCacheParent, newPluginRoot: pluginRoot });
  …
}
```

`src/server.ts:867` — 키 비교를 파생값으로.

`start.mjs:348` — `healScript` 템플릿 문자열 안의 `if(k!=="context-mode@context-mode")continue;`. 이 템플릿은 `~/.claude/hooks/context-mode-cache-heal.mjs` 로 배포되며 **`start.mjs` 가 매 부팅 덮어쓴다.** 배포본을 직접 고치지 말고 템플릿을 고쳐라. 템플릿 안에서는 `PLUGIN_KEY` 를 문자열 보간으로 굽는다:

```js
    if(k!==${JSON.stringify(PLUGIN_KEY)})continue;
```

`src/util/sibling-mcp.ts:68-71` — **주석만** 고친다. 패턴은 `.*context-mode.*` 와일드카드라 개명 후에도 맞는다:

```ts
// Match BOTH `~/.claude/plugins/cache/<marketplace>/context-mode/<v>/start.mjs`
// AND `~/.claude/plugins/marketplaces/<marketplace>/start.mjs` shapes.
// The `.*context-mode.*` wildcard below covers renamed marketplaces
// (this fork installs under `context-mode-js/`) — do not tighten it.
```

- [ ] **Step 6: 리터럴에 묶인 테스트 7파일을 갱신한다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 \
  tests/util/heal-installed-plugins.test.ts tests/util/postinstall-heal.test.ts \
  tests/util/postinstall-heal-mcp-json.test.ts tests/core/cli.test.ts \
  tests/hooks/cache-heal-self-heal.test.ts tests/util/cli-upgrade-verification.test.ts \
  tests/util/start-mjs-self-heal.test.ts
```
Expected: PASS 전부.

기존 테스트가 `"context-mode@context-mode"` 를 기대하는 곳은 **픽스처 경로를 `cache/context-mode/context-mode/<v>` 로 유지한 채** 두라 — 그 레이아웃에서 파생값은 여전히 `context-mode@context-mode` 다. 파생이 실제로 도는지 확인하려면 `cache/context-mode-js/context-mode/<v>` 픽스처를 **최소 한 개** 추가하라. 그렇지 않으면 이 태스크는 아무것도 증명하지 못한다.

- [ ] **Step 7: 파생을 *실제 설치 경로*에 대고 돌린다 (단계 6 전의 유일한 실행 증명)**

스펙 §6.3 때문에 이 파생 코드는 단계 6의 `1.0.1` 상향 전까지 **설치본에서 한 번도 실행되지 않는다.** 파생이 틀렸다면 옛 설치본이 이미 교체된 뒤에 드러난다 — 최악의 타이밍이다.

합성 픽스처는 그 위험을 덮지 못한다. 하지만 **진짜 설치 경로가 지금 디스크에 있다** (단계 2 게이트 판정 2가 확인했다). 그것에 대고 돌려라:

```bash
node -e "
const { derivePluginKey, derivePluginCacheParent } = await import('./scripts/heal-installed-plugins.mjs');
const fs=require('fs'),os=require('os'),path=require('path');
const reg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude','plugins','installed_plugins.json'),'utf8'));
const real=reg.plugins['context-mode@context-mode-js'][0].installPath;
const key=derivePluginKey(real), parent=derivePluginCacheParent(real);
console.log('installPath:', real);
console.log('derivePluginKey        ->', key);
console.log('derivePluginCacheParent->', parent);
if (key !== 'context-mode@context-mode-js') { console.error('WRONG KEY — capture order is inverted. STOP.'); process.exit(1); }
if (!fs.existsSync(parent)) { console.error('cache parent does not exist. STOP.'); process.exit(1); }
console.log('OK');
" --input-type=module
```
Expected: `derivePluginKey -> context-mode@context-mode-js`, `OK`.

> **캡처 순서를 뒤집는 걸 잊으면 upstream 레이아웃(두 이름이 동일)에서는 테스트가 전부 통과한다.** 이 한 줄만이 그 함정을 잡는다. `start.mjs:152` 의 기존 파생(`${keyMatch[2]}@${keyMatch[1]}`)과 순서가 같은지 눈으로 대조하라. Task 4c 의 리뷰어가 정확히 이 지점을 정적으로 검증했다.

- [ ] **Step 8: `tsc` 확인 후 커밋**

```bash
npm run typecheck
git add scripts/heal-installed-plugins.mjs scripts/postinstall.mjs src/cli.ts src/server.ts start.mjs src/util/sibling-mcp.ts tests/
git commit -m "fix: derive pluginKey from __dirname in postinstall, cli, server, healScript

Hardcoded 'context-mode@context-mode' silently disables every self-heal
under any other marketplace name. Upstream defect. F42/F43.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 그물 1 — `PlatformId` 축소 + `src/adapters/` 삭제 + `tsc` 폴아웃

**"`PlatformId`를 좁히면 `tsc`가 전부 열거한다"는 거짓이다(F26).** `tsc`는 첫 번째 그물일 뿐이다. 이 태스크는 `tsc`가 잡는 것만 처리하고, 나머지는 Task 5·7·10이 맡는다.

**Files:**
- Modify: `src/adapters/types.ts:474-493` (`PlatformId` 19 → 3)
- Delete: `src/adapters/{antigravity,antigravity-cli,copilot-cli,cursor,gemini-cli,jetbrains-copilot,kimi,kiro,omp,openclaw,opencode,pi,qwen-code,vscode-copilot,zed}/` (15 dirs, 46 files) + `src/adapters/copilot-base.ts`
- Modify: `src/adapters/detect.ts` (`getAdapter` switch `:641-729`, `getSessionDirSegments` `:339-356`, `PLATFORM_ENV_VARS`), `src/adapters/client-map.ts`, `src/cli.ts`, `src/server.ts`, `src/session/analytics.ts`, `src/session/extract.ts`

**Interfaces:**
- Produces: `type PlatformId = "claude-code" | "codex" | "unknown"`

- [ ] **Step 1: 삭제 집합을 코드로 만들고 개수를 단언한다**

140개를 손으로 세지 마라. 목록을 생성하고 **`140`이 아니면 멈춰라.**

```bash
node -e "
const cp=require('child_process'),fs=require('fs');
const tracked=cp.execSync('git ls-files',{encoding:'utf8'}).split('\n').filter(Boolean);
const del=new Set();
const push=(re)=>tracked.filter(f=>re.test(f)).forEach(f=>del.add(f));
push(/^src\/adapters\/(?!(claude-code|codex)\/)[^/]+\//);        // 46
push(/^src\/adapters\/copilot-base\.ts\$/);                       //  1
push(/^hooks\/(?!(core|codex|formatters)\/)[^/]+\//);            // 44  formatters 는 Task 5 소관
push(/^configs\/(?!(claude-code|codex)\/)/);                     // 40
push(/^\.(cursor-plugin|openclaw-plugin|pi)\//);                 //  9
if (del.size !== 140) { console.error('EXPECTED 140, GOT '+del.size+' — STOP'); process.exit(1); }
fs.writeFileSync('.superpowers/sdd/phase3-delete-set.txt', [...del].sort().join('\n')+'\n');
console.log('wrote', del.size, 'paths');
"
```

**204의 분해 (전부 실측, HEAD `a048215`):**

| 그룹 | 개수 | 태스크 |
|---|---:|---|
| `src/adapters/<15 dirs>` + `copilot-base.ts` | 47 | 4 |
| `hooks/<9 dirs>` | 44 | 4 |
| `configs/<16 dirs>` | 40 | 4 |
| `.cursor-plugin/` `.openclaw-plugin/` `.pi/` | 9 | 4 |
| `hooks/formatters/` + `tests/hooks/formatters.test.ts` | 5 | 5 |
| `tests/adapters/` (48 중 17 유지) | 31 | 6 |
| `tests/` 비지원 클라이언트 전용 | **N (추정 21 — 미관측)** | 6 |
| openclaw 루트·스크립트 (`openclaw.plugin.json`, `scripts/install-openclaw-plugin.sh`, `scripts/lib/register-openclaw-config.mjs`, `scripts/test-openclaw-e2e.sh`) | 4 | 9 |
| `docs/adapters/{kimi-code,openclaw}.md` · `docs/jetbrains-copilot.md` | 3 | 9 |
| **확정 합계** | **183 + N** | |

> **`204` 는 스펙의 산술이지 관측이 아니다.** 위 표에서 `N` 을 뺀 **183** 만 `git ls-files` 로 실측 확인했다(HEAD `a048215`). `N` 은 Task 6 Step 1 의 내용 판정이 정한다 — 후보 61개, `claude-code`/`codex` 미언급 41개, 그중 `tests/fixtures/playwright-snapshot.txt` 등 확인된 오탐 포함. **개수가 204가 아니라는 이유만으로 멈추지 마라.**
>
> 유지분 실측: `src/adapters/**`=60(유지 13), `hooks/**`=86(유지 38), `configs/**`=44(유지 4), `tests/adapters/`=48(유지 17). **이 넷은 개수가 다르면 멈춰라.**

- [ ] **Step 2: `PlatformId` 를 좁힌다 (삭제보다 먼저 — `tsc` 가 열거하게)**

`src/adapters/types.ts:474`:

```ts
/** Supported platform identifiers. Hard fork: Claude Code and Codex only. */
export type PlatformId = "claude-code" | "codex" | "unknown";
```

- [ ] **Step 3: `tsc` 를 돌려 폴아웃을 수집한다**

```bash
npm run typecheck 2>&1 | tee .superpowers/sdd/phase3-tsc-fallout.txt
```
Expected: **FAIL.** `TS2678`(switch case 비교 불가), `TS2322`(Record 값), 동적 import 지정자 등이 나온다. 이 목록이 Step 5의 작업지시서다.

- [ ] **Step 4: 140파일을 지운다**

`$(cat …)` 로 140개 경로를 명령줄에 펼치지 마라 — Windows 에서 길이 제한에 걸린다. git 이 파일을 직접 읽게 한다:

```bash
git rm -r --pathspec-from-file=.superpowers/sdd/phase3-delete-set.txt
git status --porcelain | grep -c '^D ' # 140 이어야 한다
```

- [ ] **Step 5: `tsc` 가 가리킨 곳을 고친다**

`src/adapters/detect.ts`:
- `getSessionDirSegments(platform: string)` `:339-356` — `claude-code`·`codex` 외 14개 `case` 삭제. **`platform: string` 이라 `tsc` 가 안 잡는다.** 수동으로 지운다
- `getAdapter` switch `:641-729` — `claude-code`·`codex` 외 전부 삭제. **`case "kilo":` 가 `opencode` 로 폴백한다(F51). `src/adapters/kilo/` 디렉토리는 없지만 `PlatformId` 와 `configs/kilo` 에는 있었다**
- `platformOverride as PlatformId` `:395` — 좁혀진 타입에 대한 검증 추가
- `PLATFORM_ENV_VARS` — 삭제된 플랫폼 키 제거

`src/adapters/client-map.ts` — `CLIENT_NAME_TO_PLATFORM` 은 `Record<string, PlatformId>` 이므로 삭제된 16종의 **값**이 전부 `tsc` 에러가 된다. 항목을 지워 초록을 만들되, **그 이름 26개는 Task 7 이 `REMOVED_CLIENT_NAMES` 로 되살린다** — 계획서에 전부 적혀 있으니 git history 를 뒤질 필요는 없다.

`src/adapters/detect.ts:391-394` 의 `validPlatforms: PlatformId[]` 도 `tsc` 가 잡는다. 3개로 줄여라 (Task 7 이 다시 확인한다).

`src/cli.ts`(`HOOK_MAP` `:77`, `hookDispatch(platform: string)` `:158`) · `src/server.ts` · `src/session/analytics.ts`(`:628`·`:1761`의 두 라벨표) · `src/session/extract.ts`.

> `cli.ts:77,158`의 `platform: string` 시그니처도 `tsc` 밖이다. Step 3의 출력에 없다고 해서 깨끗한 게 아니다.
>
> **`detect.ts:379` 의 `clientInfo.name.startsWith("qwen-cli-mcp-client")` 접두사 분기도 `tsc` 밖이다.** Task 7 이 지운다. 여기서 지워도 무방하나 테스트가 Task 7 에 있다.

- [ ] **Step 6: `tsc` 초록을 확인한다**

```bash
npm run typecheck
```
Expected: 종료 코드 0, 출력 없음.

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "refactor(adapters): narrow PlatformId to claude-code|codex|unknown, delete 15 adapters

Deletes 140 files: src/adapters/<15>+copilot-base, hooks/<9>, configs/<16>,
.cursor-plugin, .openclaw-plugin, .pi. tsc green. Tests follow.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 그물 3 — `.mjs` 수동 검토 (`tsc` 밖의 레지스트리)

`hooks/` 의 `.mjs` 파일들은 타입체커가 보지 못한다. 여기 남은 플랫폼 키는 삭제된 어댑터를 가리키는 죽은 분기다.

**Files:**
- Modify: `hooks/core/formatters.mjs` (레지스트리 키 9 → 2)
- Modify: `hooks/core/tool-naming.mjs`, `hooks/core/platform-detect.mjs`, `hooks/core/routing.mjs`
- Modify: `hooks/session-helpers.mjs` (`ANTIGRAVITY_CLI_OPTS`)
- Delete: `hooks/formatters/` 4개 전부 (F27 — 죽은 코드)

**Interfaces:**
- Consumes: Task 4의 `PlatformId` = 3개
- Produces: `hooks/core/formatters.mjs` 의 레지스트리에 `claude-code`·`codex` 만

- [ ] **Step 1: 각 파일의 플랫폼 키를 열거한다**

```bash
node -e "
const fs=require('fs');
for (const f of ['hooks/core/formatters.mjs','hooks/core/tool-naming.mjs','hooks/core/platform-detect.mjs','hooks/core/routing.mjs','hooks/session-helpers.mjs']) {
  const t=fs.readFileSync(f,'utf8');
  const ids=['gemini-cli','opencode','kilo','openclaw','vscode-copilot','jetbrains-copilot','copilot-cli','cursor','antigravity','antigravity-cli','kiro','pi','omp','kimi','zed','qwen-code'];
  const hit=ids.filter(id=>new RegExp('(?<![A-Za-z0-9-])'+id+'(?![A-Za-z0-9-])').test(t));
  console.log(f, '->', hit.join(' ')||'(clean)');
}"
```

- [ ] **Step 2: `hooks/formatters/` 4개를 지운다**

```bash
git rm -r hooks/formatters
git rm tests/hooks/formatters.test.ts
```

- [ ] **Step 3: `hooks/core/formatters.mjs` 의 레지스트리에서 7개 키를 뺀다**

남기는 것: `claude-code`, `codex`. 빼는 것: `gemini-cli`, `vscode-copilot`, `copilot-cli`, `jetbrains-copilot`, `kimi`, `antigravity-cli`, `cursor`.

- [ ] **Step 4: 나머지 `.mjs` 4개에서 Step 1이 지목한 키를 뺀다**

`hooks/session-helpers.mjs` 의 `ANTIGRAVITY_CLI_OPTS` 는 상수 전체를 삭제하고 참조도 함께 지운다.

- [ ] **Step 5: Step 1을 다시 돌려 `(clean)` 만 나오는지 확인한다**

Expected: 다섯 줄 전부 `(clean)`.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "refactor(hooks): drop unsupported platform keys from .mjs registries

hooks/core/*.mjs and session-helpers.mjs live outside tsc. Deletes
hooks/formatters/ (dead code, F27) and its test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 테스트 정리 — 삭제 **52** + 편집 ~31

> 테스트 파일 삭제 총합은 53이지만 그중 `tests/hooks/formatters.test.ts` 1개는 **Task 5** 가 지운다. 이 태스크는 52다 (`tests/adapters/` 31 + 비지원 클라이언트 전용 21).

**Files:**
- Delete: `tests/adapters/` 31개 (유지 17개는 아래 목록)
- Delete: `tests/` 나머지 중 비지원 클라이언트 전용 21개
- Modify: `tests/core/{cli,server,search,deny-policy,auto-memory-adapter,cache-plugin-root}.test.ts` · `tests/formatters.test.ts` · `tests/hooks/{core-routing,integration,tool-naming}.test.ts` · `tests/scripts/{version-sync,asymmetric-drift-assert}.test.ts` · `tests/{lifecycle,runtime,security,hook-runtime-resolution}.test.ts` · `tests/util/project-dir-matrix.test.ts`

**`tests/adapters/` 유지 17개** (다수가 *우리가 유지·편집할 코드의 테스트*다):
- 편집: `detect.test.ts` · `client-map.test.ts` · `detect-ambiguity-matrix.test.ts` · `detect-config-dir.test.ts` · `base-adapter-memory.test.ts` · `memory-conventions.test.ts` · `hook-path-parity.test.ts` · `hook-runtime-per-adapter.test.ts`
- 유지: `claude-code.test.ts` · `claude-code-memory.test.ts` · `codex.test.ts` · `codex-usage.test.ts` · `codex-external-mcp-routing.test.ts` · `detect-claude-code-in-vscode.test.ts`
- 인프라(어댑터 테스트 아님): `zod3tov4.test.ts` · `zod3tov4-e2e.test.ts` · `zod3tov4-production.test.ts`

### ⚠️ "21"은 재현 불가능한 추정치다 — 하드 게이트로 쓰지 마라

스펙 §8.1의 `tests/` 나머지 21개는 **계산된 수치이지 관측된 수치가 아니다.** 실측하면 비지원 식별자를 건드리는 `tests/` 파일(`tests/adapters/` 제외)이 **61개**이고, `claude-code`/`codex` 를 한 번도 언급하지 않는 것이 **41개**다. 그중 `tests/fixtures/playwright-snapshot.txt` 는 231히트지만 **스펙 스스로 오탐이라 부른 파일**이다.

**따라서 이 태스크의 개수는 실행 시점에 판정으로 확정된다.** 실측으로 확정된 그룹은 넷뿐이다: Task 4 = 140, Task 5 = 5, `tests/adapters/` = 31, Task 9 = 7. 합 **183**. 나머지는 이 스텝의 산출물이다.

- [ ] **Step 1: 후보를 뽑고, 비율로 정렬해, 각 파일을 열어 판정한다**

**파일명 매칭은 오탐투성이다(Δ8).** `tests/context-comparison.ts`("c**omp**arison"), `tests/session/session-pipeline.test.ts`("**pi**peline"), `tests/hooks/precompact-snapshot-event.test.ts`("prec**omp**act"), `tests/fixtures/api-response.json`("a**pi**"), `tests/session/extract-prompt-features.test.ts`("pr**omp**t") — 전부 오탐이다. 내용으로 판정한다.

`.superpowers/sdd/tests-triage.mjs` 에 쓰고 `node .superpowers/sdd/tests-triage.mjs` 로 돌려라 (`node -e` 는 deny):

```js
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ids = ['gemini-cli','opencode','kilo','openclaw','vscode-copilot','jetbrains-copilot',
             'copilot-cli','cursor','antigravity','antigravity-cli','kiro','pi','omp','kimi','zed','qwen-code'];
const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const snake = (id) => id.replace(/-/g, "_");

const files = execSync("git ls-files tests", { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !f.startsWith("tests/adapters/") && f !== "tests/hooks/formatters.test.ts");

const rows = [];
for (const f of files) {
  let t; try { t = readFileSync(f, "utf8"); } catch { continue; }
  let removed = 0; const which = new Set();
  for (const id of ids) for (const n of new Set([id, camel(id), snake(id)])) {
    const c = (t.match(new RegExp(`(?<![A-Za-z0-9-])${n}(?![A-Za-z0-9-])`, "gi")) || []).length;
    if (c) { removed += c; which.add(id); }
  }
  if (!removed) continue;
  const keep = (t.match(/(?<![A-Za-z0-9-])(claude-code|codex)(?![A-Za-z0-9-])/gi) || []).length;
  rows.push({ f, removed, keep, which: [...which].join(",") });
}
rows.sort((a, b) => b.removed / (b.keep + 1) - a.removed / (a.keep + 1));
for (const r of rows) console.log(`${r.keep === 0 ? "DELETE?" : "EDIT   "} ${r.f} | removed=${r.removed} keep=${r.keep} | ${r.which}`);
console.log(`\ncandidates=${rows.length}  exclusive(keep=0)=${rows.filter((r) => r.keep === 0).length}`);
```

**`DELETE?` 는 힌트일 뿐이다.** `keep=0` 이어도 삭제 대상이 아닌 것이 있다:

| 파일 | `keep=0` 인데 지우면 안 되는 이유 |
|---|---|
| `tests/fixtures/playwright-snapshot.txt` | 브라우저 스냅샷 픽스처. `cursor`(CSS 커서)·`openclaw` 는 페이지 내용이다. **스펙이 명시한 오탐** |
| `tests/setup-home.ts` · `tests/util/isolated-env.ts` | 테스트 인프라. 한 줄 참조만 지운다 |
| `tests/fixtures/cursor/*.json` (5) | 커서 어댑터 훅 픽스처 → **지운다** |

**각 파일을 열어 "이 클라이언트 전용인가, 여러 클라이언트를 순회하는 공용 테스트인가"를 판단하라.** 전자만 지운다. 판정 결과를 `.superpowers/sdd/phase3-tests-exclusive.txt` 에 쓰고 **그 목록을 리뷰에 포함하라** — 이 태스크의 개수는 그 파일이 정한다.

- [ ] **Step 2: `tests/adapters/` 의 31개를 유지목록의 여집합으로 생성한다**

유지 17개는 위에 전부 적혀 있으므로 삭제 집합은 계산된다. 손으로 고르지 마라.

```bash
node -e "
const cp=require('child_process'),fs=require('fs');
const KEEP=['detect.test.ts','client-map.test.ts','detect-ambiguity-matrix.test.ts','detect-config-dir.test.ts',
 'base-adapter-memory.test.ts','memory-conventions.test.ts','hook-path-parity.test.ts','hook-runtime-per-adapter.test.ts',
 'claude-code.test.ts','claude-code-memory.test.ts','codex.test.ts','codex-usage.test.ts',
 'codex-external-mcp-routing.test.ts','detect-claude-code-in-vscode.test.ts',
 'zod3tov4.test.ts','zod3tov4-e2e.test.ts','zod3tov4-production.test.ts'];
const all=cp.execSync('git ls-files tests/adapters',{encoding:'utf8'}).split('\n').filter(Boolean);
const keep=all.filter(f=>KEEP.includes(f.split('/').pop()));
const del=all.filter(f=>!KEEP.includes(f.split('/').pop()));
if (keep.length!==17) { console.error('KEEP resolved to '+keep.length+', expected 17 — STOP'); process.exit(1); }
if (del.length!==31)  { console.error('DELETE resolved to '+del.length+', expected 31 — STOP'); process.exit(1); }
fs.writeFileSync('.superpowers/sdd/phase3-tests-delete-set.txt', del.join('\n')+'\n');
console.log('wrote 31 paths');
"
git rm --pathspec-from-file=.superpowers/sdd/phase3-tests-delete-set.txt
```

이어서 `tests/` 나머지 21개 (`tests/hooks/formatters.test.ts` 는 Task 5 가 이미 지웠다):

```bash
git rm tests/hooks/{antigravity-cli-hooks,copilot-cli-hooks,cursor-hooks,kimi-config-dir,kimi-hooks,kiro-hooks}.test.ts
git rm tests/{opencode-plugin,pi-extension}.test.ts
git rm tests/plugins/openclaw.test.ts
git rm tests/session/parse-{openclaw,opencode,pi}-usage.test.ts
```

**이 목록은 12개다. 나머지 9개는 Step 1의 내용 판정이 지목한다.** 이 태스크의 `tests/` 삭제 총합은 52(31+21)여야 한다:

```bash
git status --porcelain tests | grep -c '^D ' # 52
```

- [ ] **Step 3: 편집 대상 테스트에서 비지원 클라이언트 케이스를 뺀다**

`tests/adapters/detect.test.ts` 의 매트릭스, `tests/adapters/hook-runtime-per-adapter.test.ts` 의 어댑터 루프 등. **테스트를 지워 초록을 만들지 마라** — 케이스만 빼고 `claude-code`·`codex`·`unknown` 은 남긴다.

- [ ] **Step 4: 전체 스위트를 메모리 캡 아래 돌린다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
```
Expected: PASS. **`npm test` 를 쓰지 마라** — `pretest: npm run build` 가 아직 스테일 번들을 재생성한다.

> 캡 없이 돌리면 OOM으로 죽는다. 200개 넘게 실패하면 `--filter` 대신 디렉토리별로 나눠 돌린다.

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "test: delete tests for removed clients, narrow shared matrices

Deletes 53 test files, edits ~31 that iterate every client. Judged by
content, not filename — 'pipeline'/'prompt'/'compact' are false positives
for the pi/omp identifiers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 그물 4 — 런타임 하드페일 (**경계를 정확히 짚어라**)

**축소된 타입은 오라우팅을 막지 못한다.** `clientInfo.name` 은 MCP initialize 핸드셰이크로 들어오는 런타임 문자열이다.

### 실측한 실제 경계 — **조용한 폴백이 셋이고, 그 위에 삼킴이 둘 더 있다**

Codex 적대적 리뷰(2026-07-10, Critical 1)가 지적했고 1차 출처로 확인했다. **스펙의 "`getAdapter` 에 throw 를 넣어라"는 그대로 하면 완전한 no-op 이다.**

```
clientInfo.name ─[1]→ PlatformId ─[2]→ HookAdapter
                                          │
   server.ts:4919-4927  try { …[1]…[2]… } catch { }   ← [3] 삼킴. _detectedAdapter = null
   server.ts:4301-4310  try { …[1]… }     catch { detectPlatform() }  ← [3'] 두 번째 삼킴
                                          ↓
   getDefaultSessionDir() (server.ts:555) → detectPlatform() (clientInfo 없이!) → claude-code
```

| # | 위치 | 현재 동작 |
|---|---|---|
| **[1]** | `detect.ts:369-386` | `CLIENT_NAME_TO_PLATFORM[name]` 이 `undefined` → throw 안 함. env override → config-dir 스니핑으로 흘러감 |
| **[1b]** | `detect.ts:626-630` | **최후 기본값:** `return { platform: "claude-code", confidence: "low", reason: "No platform detected, defaulting to Claude Code" }` |
| **[2]** | `detect.ts:730-735` | `getAdapter` 의 `default:` 가 **이미** `new ClaudeCodeAdapter()` 를 반환한다 (주석: "Unsupported platform — fall back to Claude Code adapter") |
| **[3]** | `server.ts:4927` | `catch { /* best effort — _detectedAdapter stays null, falls back to .claude */ }` — **[1]·[2] 의 어떤 throw 도 여기서 죽는다** |
| **[3']** | `server.ts:4309-4310` | `catch { try { platformId = detectPlatform().platform } catch {} }` — 삼킨 뒤 clientInfo 없이 재시도 |

**따라서 [1] 이나 [2] 에 throw 를 넣기만 하면, MCP 부팅 경로에서는 아무 일도 일어나지 않는다.** `_detectedAdapter` 가 `null` 이 되고 `getDefaultSessionDir()` 이 `clientInfo` 없이 detect 를 재실행해 `[1b]` 의 `claude-code` 로 착지한다. **[3] 을 함께 고쳐야만 그물 4가 성립한다.**

두 가지 사실 더:

- **`getAdapter` 는 `async` 다** (`detect.ts:637`). `expect(() => …).toThrow()` 는 동작하지 않는다. `await expect(…).rejects.toThrow(…)` 를 써라.
- **`case "unknown":` 이 없다.** `unknown` 은 `default:` 로 떨어져 ClaudeCodeAdapter 를 받고, `tests/adapters/detect.test.ts:665-667` 이 그 동작을 **고정하고 있다.** `default:` 를 throw 로 바꾸면 그 테스트가 깨진다 — `unknown` 은 정상 상태다(CLI 경로·설치 직후). 명시적 `case "unknown":` 을 반드시 추가하라.

### ✅ 결정됨 — 갈래 (B) (사용자, 2026-07-10)

`CLIENT_NAME_TO_PLATFORM` 에는 `"claude-code"` **정확 일치**만 있다. `"Claude Code"` 같은 대소문자 변형은 **지금도** 매핑에 없어 조용히 강등된다. 무조건 throw 를 걸고 [3] 의 삼킴까지 걷어내면, 그 변형을 보내는 Claude Code 는 degrade 가 아니라 **죽는다** (MCP init 실패 = 플러그인 사망).

**따라서 스펙 §8.2-7 의 문언 (A)("미지원 `clientInfo.name` 이 들어오면 명시적으로 실패시킨다")를 채택하지 않는다.** 스펙은 경계를 잘못 짚었고, 그 문언을 글자대로 따르면 자기 발등을 찍는다.

- ~~**(A)** 매핑되지 않는 모든 `clientInfo.name` 에 throw~~ — 기각.
- **(B) 제거된 클라이언트 이름 24개 + `qwen-cli-mcp-client` 접두사에만 명시적 throw.** 그 외 미지의 이름은 현행대로 `[1b]` 강등. — **채택.**

하드페일의 목적은 "모르는 것을 죽이는 것"이 아니라 "**알면서 지원하지 않는 것**을 죽이는 것"이다.

| `clientInfo.name` | 동작 |
|---|---|
| `"cursor-vscode"`, `"Kilo Code"`, `"omp-coding-agent"` … (24개) | `UnsupportedClientError` throw → **MCP init 실패** |
| `"qwen-cli-mcp-client-<serverName>"` (동적 접두사) | throw |
| `"claude-code"`, `"Codex"`, `"codex-mcp-client"` | 정상 해석 |
| `"Claude Code"`, `"Some Future Client"` (미지) | `[1b]` 강등 — **플러그인이 산다** |

아래 스텝은 (B) 로 적혀 있다. 그대로 구현하라.

**Files:**
- Modify: `src/adapters/client-map.ts:12-45` (`CLIENT_NAME_TO_PLATFORM` 26 → 3, `REMOVED_CLIENT_NAMES` + `UnsupportedClientError` 신설)
- Modify: `src/adapters/detect.ts:369-386` (미지원 이름 하드페일), `:379-385` (`qwen-cli-mcp-client` **접두사** 분기 — `startsWith` 라 `tsc` 가 절대 못 잡는다), `:391-394` (`validPlatforms` 17 → 3), `:730-735` (`getAdapter` 의 `default:` + `case "unknown":`)
- Modify: **`src/server.ts:4919-4927`** 과 **`:4301-4310`** — `UnsupportedClientError` 만 rethrow, 나머지는 현행대로 삼킨다
- Test: `tests/adapters/detect.test.ts:665-667` (기존 `unknown` 고정 테스트 — **살려라**) · `tests/adapters/client-map.test.ts` · `tests/core/server.test.ts`

**Interfaces:**
- Consumes: Task 4의 `PlatformId` = `"claude-code" | "codex" | "unknown"`
- Produces: `class UnsupportedClientError extends Error` (`client-map.ts` export). `detectPlatform({name})` 은 제거된 클라이언트 이름에 대해 이 에러를 **throw**. `getAdapter(platform)` 은 미지원 `PlatformId` 에 대해 **reject** (async). `getAdapter("unknown")` 은 **여전히 ClaudeCodeAdapter 를 반환한다.**

> **`try/catch` 를 통째로 걷어내지 마라.** `server.ts:4927` 의 삼킴은 동적 import 실패·어댑터 생성 실패 등 **정당한 best-effort** 도 함께 잡고 있다. 전부 rethrow 하면 무관한 오류로 MCP 가 죽는다. **`UnsupportedClientError` 만 골라 rethrow 한다.** 그래서 전용 에러 타입이 필요하다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — 캐스트가 아니라 진짜 진입점으로 몰아라**

```ts
// [1] 진짜 경계: raw clientInfo.name. `as PlatformId` 캐스트로 우회하지 마라 —
//     그러면 detection 을 건너뛰어 아무것도 증명하지 못한다.
it("hard-fails on a removed client's clientInfo.name instead of degrading", () => {
  expect(() => detectPlatform({ name: "cursor-vscode" })).toThrow(UnsupportedClientError);
});

it("hard-fails on qwen's dynamic client name (prefix match, tsc cannot see it)", () => {
  expect(() => detectPlatform({ name: "qwen-cli-mcp-client-foo" })).toThrow(UnsupportedClientError);
});

it("still resolves the two supported clients by clientInfo.name", () => {
  expect(detectPlatform({ name: "claude-code" }).platform).toBe("claude-code");
  expect(detectPlatform({ name: "Codex" }).platform).toBe("codex");
});

// 갈래 (B): 미지의 이름은 죽이지 않는다. "Claude Code" 변형이 플러그인을 죽이면 안 된다.
it("does NOT throw on an unknown-but-not-removed client name", () => {
  expect(() => detectPlatform({ name: "Some Future Client" })).not.toThrow();
});

// [2] 방어층. getAdapter 는 async — rejects 를 써야 한다.
it("getAdapter rejects an unsupported PlatformId", async () => {
  await expect(getAdapter("cursor" as unknown as PlatformId)).rejects.toThrow(/unsupported platform/i);
});

// 기존 테스트(detect.test.ts:665-667)를 지우지 마라. unknown 은 정상 상태다.
it("returns ClaudeCodeAdapter for unknown platform", async () => {
  await expect(getAdapter("unknown")).resolves.toBeInstanceOf(ClaudeCodeAdapter);
});
```

`tests/core/server.test.ts` — **삼킴이 실제로 걷혔는지**가 이 태스크의 핵심 판정이다:

```ts
it("MCP init propagates UnsupportedClientError instead of degrading to .claude", async () => {
  // server.ts:4919-4927 의 catch 가 이 에러를 삼키면 이 테스트는 실패한다.
  await expect(resolveDetectedAdapter({ name: "cursor-vscode" })).rejects.toThrow(/unsupported client/i);
});

it("MCP init still swallows unrelated errors (adapter construction failure)", async () => {
  const boom = async () => { throw new Error("dynamic import blew up"); };
  await expect(resolveDetectedAdapter({ name: "claude-code" }, { loadDetect: boom })).resolves.toBeNull();
});
```

> **`resolveDetectedAdapter` 는 새 코드다.** 현재 `server.ts:4919-4927` 은 인라인 `try` 블록이라 테스트할 수 없다. 이 태스크의 첫 실제 작업은 그것을 함수로 추출하는 것이다. 시그니처를 못 박는다:
>
> ```ts
> type DetectModule = typeof import("./adapters/detect.js");
>
> /**
>  * `_detectedAdapter` 를 결정한다. 미지원 클라이언트면 throw, 그 외 실패는 null.
>  * @param clientInfo  MCP initialize 핸드셰이크의 clientInfo (없으면 undefined)
>  * @param deps.loadDetect  detect 모듈 로더 — 테스트에서 실패를 주입한다.
>  */
> export async function resolveDetectedAdapter(
>   clientInfo: { name: string; version?: string } | undefined,
>   deps: { loadDetect?: () => Promise<DetectModule> } = {},
> ): Promise<HookAdapter | null> {
>   const load = deps.loadDetect ?? (() => import("./adapters/detect.js"));
>   try {
>     const { detectPlatform, getAdapter } = await load();
>     const signal = detectPlatform(clientInfo);
>     return await getAdapter(signal.platform);
>   } catch (err) {
>     if ((err as { name?: string })?.name === "UnsupportedClientError") throw err;
>     return null;   // best effort — 호출부가 .claude 로 폴백한다
>   }
> }
> ```
>
> 호출부(`:4919-4927`)는 이 함수를 부르고 `_detectedAdapter` 에 대입한다. `console.error` 로그 줄은 호출부에 남긴다.

- [ ] **Step 2: 실패를 확인한다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/adapters/detect.test.ts tests/core/server.test.ts
```
Expected: 하드페일 테스트 FAIL (강등한다), `server.test.ts` 의 첫 테스트 FAIL (**catch 가 삼킨다**).

**`getAdapter` 테스트가 "throw 하지 않음"이 아니라 "타임아웃"이나 "unhandled rejection"으로 실패하면, `rejects` 를 빠뜨린 것이다.**

- [ ] **Step 3: [1] 을 막는다 — `detectPlatform` 의 raw 이름 경계**

`src/adapters/client-map.ts`:

```ts
export const CLIENT_NAME_TO_PLATFORM: Record<string, PlatformId> = {
  "claude-code": "claude-code",
  "Codex": "codex",
  "codex-mcp-client": "codex",
};

/** MCP init 을 실패시켜야 하는 유일한 에러. server.ts 가 이 타입만 rethrow 한다. */
export class UnsupportedClientError extends Error {
  constructor(public readonly clientName: string) {
    super(`unsupported client: "${clientName}". This fork supports Claude Code and Codex only.`);
    this.name = "UnsupportedClientError";
  }
}

/**
 * 이 fork 가 삭제한 클라이언트들의 clientInfo.name.
 * 조용히 claude-code 로 강등시키지 않고 명시적으로 실패시키기 위해 남긴다.
 * 여기 없는 미지의 이름은 기존 config-dir 스니핑으로 흘러간다 — 갈래 (B).
 */
export const REMOVED_CLIENT_NAMES = new Set([
  "gemini-cli-mcp-client", "antigravity-client", "antigravity-cli", "agy",
  "cursor-vscode", "Visual-Studio-Code", "copilot-cli", "GitHub Copilot CLI",
  "github-copilot-cli", "JetBrains Client", "IntelliJ IDEA", "PyCharm",
  "Kilo Code", "Kiro CLI", "Pi CLI", "Pi Coding Agent", "omp-coding-agent",
  "Zed", "zed", "qwen-code", "qwen-cli-mcp-client", "kimi-code", "kimi", "Kimi Code",
]);
```

`src/adapters/detect.ts:369-386` — 매핑 조회 **직후**. 기존 `qwen-cli-mcp-client` 접두사 분기(`:379-385`)는 **삭제하지 말고 하드페일 조건으로 옮긴다** (동적 이름 `qwen-cli-mcp-client-<serverName>` 은 Set 에 안 걸린다):

```ts
  if (clientInfo?.name) {
    const platform = CLIENT_NAME_TO_PLATFORM[clientInfo.name];
    if (platform) {
      return { platform, confidence: "high", reason: `MCP clientInfo.name="${clientInfo.name}"` };
    }
    if (REMOVED_CLIENT_NAMES.has(clientInfo.name) || clientInfo.name.startsWith("qwen-cli-mcp-client")) {
      throw new UnsupportedClientError(clientInfo.name);
    }
    // 그 외 미지의 이름 → 아래 config-dir 스니핑으로 계속 (갈래 B).
    // detect.ts:626-630 의 최후 기본값(claude-code, confidence "low")이 받는다.
  }
```

`:391-394` 의 `validPlatforms` 배열은 **Task 4 의 `tsc` 가 이미 강제로 좁혔을 것이다** (`PlatformId[]` 타입이다). 값만 확인하라 — 현재는 17개를 열거하며 **`openclaw` 가 빠져 있는 기존 불일치**도 함께 사라진다:

```ts
    const validPlatforms: PlatformId[] = ["claude-code", "codex"];
```

- [ ] **Step 4: [2] 를 막는다 — `getAdapter` 의 `default:` (단, `unknown` 은 살린다)**

`src/adapters/detect.ts:730-735`. 현재 `default:` 가 `new ClaudeCodeAdapter()` 를 반환하고 **`case "unknown":` 은 없다.** `tests/adapters/detect.test.ts:665-667` 이 `getAdapter("unknown") → ClaudeCodeAdapter` 를 고정한다. 그 테스트를 깨지 마라 — `unknown` 은 CLI 경로·설치 직후의 **정상 상태**다.

```ts
    case "unknown": {
      // 정상 상태: clientInfo 없이 부팅한 CLI 경로. 조용한 폴백이 아니라 명시적 계약이다.
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }

    default:
      // PlatformId 가 3개로 좁혀졌으므로 TS 상 도달 불가. 런타임 문자열 방어층이다.
      throw new Error(
        `unsupported platform: ${platform}. This fork supports claude-code and codex only.`,
      );
```

- [ ] **Step 5: [3] 을 막는다 — `server.ts` 의 삼킴 두 곳 (이 태스크의 진짜 목적)**

**[1]·[2] 만 고치면 그물 4는 완전한 no-op 이다.** `server.ts:4919-4927` 의 `catch {}` 가 throw 를 삼키고 `_detectedAdapter` 를 `null` 로 두면, `getDefaultSessionDir()`(`:555`) 이 `clientInfo` 없이 `detectPlatform()` 을 재실행해 `[1b]` 의 `claude-code` 로 착지한다.

먼저 `:4919-4927` 의 `try` 블록을 테스트 가능한 함수로 **추출**한 뒤:

```ts
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const clientInfo = server.server.getClientVersion();
    const signal = detectPlatform(clientInfo ?? undefined);
    _detectedAdapter = await getAdapter(signal.platform);
    if (clientInfo) {
      console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
    }
  } catch (err) {
    // 미지원 클라이언트는 조용히 .claude 로 강등시키지 않는다 — MCP init 을 실패시킨다.
    // `instanceof` 가 아니라 `name` 으로 판별한다 — 아래 상자를 읽어라.
    if ((err as { name?: string })?.name === "UnsupportedClientError") throw err;
    /* 그 외는 best effort — _detectedAdapter stays null, falls back to .claude */
  }
```

`:4301-4310` 도 같은 형태로. **`catch` 를 통째로 걷어내지 마라** — 동적 import 실패 같은 무관한 오류까지 MCP 를 죽인다:

```ts
    } catch (err) {
      if ((err as { name?: string })?.name === "UnsupportedClientError") throw err;
      try { platformId = detectPlatform().platform; } catch { /* best effort */ }
    }
```

> ### ⚠️ `instanceof` 를 쓰지 마라 — 번들 경계를 넘지 못한다
>
> `server.ts` 는 `detect.js` 를 **동적 import** 하고, 배포되는 실물은 `server.bundle.mjs` 다. esbuild 가 `UnsupportedClientError` 클래스를 `server.ts` 가 닫아 쥔 것과 **다른 모듈 인스턴스**로 해석하면, `instanceof` 는 조용히 `false` 를 내고 에러는 일반 삼킴으로 떨어진다 → **하드페일이 다시 no-op 이 된다. 그리고 모든 유닛 테스트는 통과한다** (vitest 는 소스를 단일 인스턴스로 로드하므로).
>
> 이것은 **이 계획 자신의 명제**다 — "커밋된 번들이 실제로 실행되는 코드이고, 테스트는 그걸 잡지 못한다"(§8.3, F16, F25). 그 명제를 수정 자체에 적용하라.
>
> `err.name === "UnsupportedClientError"` 는 realm/모듈 인스턴스에 무관하다. `class` 생성자에서 `this.name` 을 이미 설정했다. 비용 0, 엄격히 더 견고하다.

- [ ] **Step 5b: 소스가 아니라 *빌드된 번들*로 하드페일을 검증한다**

유닛 테스트는 `src/` 를 로드한다. 배포되는 것은 `server.bundle.mjs` 다. **둘이 다르게 동작하는 것이 이 fork 가 겪은 F16·F25 의 본질이다.**

```bash
npm run bundle
```

`.superpowers/sdd/bundle-hardfail-check.mjs` 에 쓰고 `node .superpowers/sdd/bundle-hardfail-check.mjs`:

```js
// 빌드된 번들이 정말 하드페일하는지 — 소스가 아니라 배포물을 검사한다.
const mod = await import("../../server.bundle.mjs");   // 경로는 실제 export 형태에 맞춰라
// 번들이 detectPlatform 을 export 하지 않으면, 대신 MCP initialize 를 흉내 내는
// 최소 하네스를 쓰거나 이 검사를 `node server.bundle.mjs` 하위 프로세스로 돌려라.
try {
  mod.detectPlatform({ name: "cursor-vscode" });
  console.error("FAIL: bundle degraded instead of hard-failing");
  process.exit(1);
} catch (err) {
  if (err?.name !== "UnsupportedClientError") {
    console.error("FAIL: wrong error from bundle:", err?.name, err?.message);
    process.exit(1);
  }
  console.log("OK: bundle hard-fails with UnsupportedClientError");
}
```

Expected: `OK`. **번들이 `detectPlatform` 을 export 하지 않으면 이 검사를 건너뛰지 말고**, `server.bundle.mjs` 를 자식 프로세스로 띄워 `initialize` 핸드셰이크에 `clientInfo.name = "cursor-vscode"` 를 실어 보내고 프로세스가 죽는지 관측하라. 실행을 관측하지 않은 가드는 가드가 아니다 — 단계 2 판정 5에서 배운 것과 같다.

- [ ] **Step 6: 통과를 확인한다 + CLI 경로가 살아 있는지 본다**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/adapters/ tests/core/server.test.ts tests/core/cli.test.ts
```
Expected: PASS 전부. **특히 `detect.test.ts:665-667` 의 `unknown` 테스트가 살아 있어야 한다.**

`detectPlatform` 은 `src/cli.ts:501,661,1246` 에서도 불린다. **`clientInfo` 없이 부르는 경로는 절대 throw 하면 안 된다** — 가드가 `if (clientInfo?.name)` 안에 있으므로 안전하지만, `tests/core/cli.test.ts` 로 확인하라.

- [ ] **Step 7: 커밋**

```bash
git add src/adapters/detect.ts src/adapters/client-map.ts src/server.ts tests/
git commit -m "feat(adapters): hard-fail on removed clients' clientInfo.name

A narrowed type does not stop misrouting — clientInfo.name arrives at
runtime. Three silent fallbacks existed (detect.ts:626, detect.ts:730,
server.ts:4927's catch). Throwing in the first two alone is a no-op: the
server swallows it, _detectedAdapter goes null, and getDefaultSessionDir
re-detects without clientInfo and lands on claude-code. server.ts now
rethrows UnsupportedClientError only. getAdapter("unknown") still returns
ClaudeCodeAdapter — unknown is a normal state, not a fallback.

Net 4 of the spec's four nets. Boundary corrected per Codex review.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 죽은 코드 제거 (F24)

**Files:**
- Modify: `src/adapters/detect.ts` (`foreignWorkspaceEnv` ×3, `foreignIdentificationEnv` ×2)
- Modify: `src/util/project-dir.ts` (`foreignWorkspaceEnv` ×1)
- Modify: `tests/adapters/detect.test.ts` · `tests/util/project-dir-matrix.test.ts`
- (`src/adapters/pi/mcp-bridge.ts` 는 Task 4에서 이미 삭제됐다)

- [ ] **Step 1: 소비자가 정말 남아 있지 않은지 확인한다**

```bash
node -e "
const fs=require('fs'),cp=require('child_process');
const tracked=cp.execSync('git ls-files',{encoding:'utf8'}).split('\n').filter(Boolean);
for (const s of ['foreignWorkspaceEnv','foreignIdentificationEnv'])
  console.log(s, '->', tracked.filter(f=>!/\.bundle\.mjs\$|^docs\//.test(f) && fs.readFileSync(f,'utf8').includes(s)).join(' ')||'(none)');
"
```
Expected: `src/adapters/detect.ts`, `src/util/project-dir.ts`, 그리고 두 테스트 파일만.

- [ ] **Step 2: 심볼과 그 소비 테스트를 함께 지운다**

- [ ] **Step 3: 초록 확인**

```bash
npm run typecheck && NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/adapters/detect.test.ts tests/util/project-dir-matrix.test.ts
```

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "refactor: remove foreignWorkspaceEnv / foreignIdentificationEnv (F24)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 스크립트·매니페스트 (D5) + `web/` 상류 fetch 제거 (F40) + 잔여 삭제

**Files:**
- Modify: `scripts/version-sync.mjs:15-45` (`TARGETS` 10 → 3)
- Modify: `package.json` (`version` 스크립트의 `git add` 목록, `files` 필드, `install:openclaw` 제거)
- Modify: `scripts/postinstall.mjs:234-237` (OpenClaw 감지 블록)
- Modify: `scripts/ctx-debug.sh`
- Modify: `web/{index,insight,context-saving}.html` · `web/og/render-og.mjs` (상류 `stats.json` fetch 제거)
- Delete (4): `openclaw.plugin.json`, `scripts/install-openclaw-plugin.sh`, `scripts/lib/register-openclaw-config.mjs`, `scripts/test-openclaw-e2e.sh`
- Delete (3): `docs/adapters/kimi-code.md`, `docs/adapters/openclaw.md`, `docs/jetbrains-copilot.md`
- Test: `tests/scripts/version-sync.test.ts`

- [ ] **Step 1: `TARGETS` 를 3개로 줄인다**

`scripts/version-sync.mjs:15`. **남기는 3개:**

```js
export const TARGETS = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  // .codex-plugin/marketplace.json is intentionally absent — Codex CLI
  // reads marketplaces from .agents/plugins/marketplace.json, which has no
  // top-level `version` field. Per-plugin version lives in the file below.
  ".codex-plugin/plugin.json",
];
```

**빼는 7개:** `.cursor-plugin/plugin.json`, `.openclaw-plugin/openclaw.plugin.json`, `.openclaw-plugin/package.json`, `openclaw.plugin.json`, `.pi/extensions/context-mode/package.json`, `configs/antigravity-cli/plugin.json`, `configs/copilot-cli/.github/plugin/plugin.json`.

> `version-sync.mjs` 는 존재하지 않는 TARGET에 대해 fail-loud 한다(F21). 목록을 줄이지 않으면 다음 버전 상향에서 터진다. 이 태스크는 단계 6의 전제조건이다.

- [ ] **Step 2: `package.json` 을 맞춘다**

`version` 스크립트의 `git add` 목록을 위 3개 + `package.json` 으로 줄인다:

```json
"version": "node scripts/version-sync.mjs && git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json",
```

`files` 에서 `.openclaw-plugin`·`openclaw.plugin.json` 제거(F32). `install:openclaw` 스크립트 제거.

> **`npm version` 은 금지다**(전역 제약). `version` 스크립트는 `npm run version-sync` 경유로만 산다.

- [ ] **Step 3: `postinstall.mjs:234-237` 의 OpenClaw 블록을 지운다**

```js
// ── 1. OpenClaw detection ────────────────────────────────────────────
if (process.env.OPENCLAW_STATE_DIR) {
  console.log("\n  OpenClaw detected. Run: npm run install:openclaw\n");
}
```
전체 삭제. 파일 상단 주석 `:5` 의 항목 번호도 맞춰 갱신한다.

- [ ] **Step 4: `web/` 의 상류 fetch 를 지운다**

`web/{index,insight,context-saving}.html`, `web/og/render-og.mjs` 가 `raw.githubusercontent.com`/jsDelivr에서 상류 `stats.json` 을 가져온다. **배포되지 않는 파일이지만 §4 헌장(상류 인프라 비호출)에 어긋난다.** fetch 블록을 제거하고 정적 값이나 빈 상태로 대체한다.

- [ ] **Step 5: 잔여 파일을 지운다**

```bash
git rm openclaw.plugin.json scripts/install-openclaw-plugin.sh \
       scripts/lib/register-openclaw-config.mjs scripts/test-openclaw-e2e.sh
git rm docs/adapters/kimi-code.md docs/adapters/openclaw.md docs/jetbrains-copilot.md
```

`scripts/lib/register-openclaw-config.mjs` 의 import 소비자가 남아 있는지 먼저 확인하라 (`grep -rn register-openclaw-config scripts/ src/`). 남아 있으면 그 호출부도 함께 지운다.

- [ ] **Step 6: 초록 확인 후 커밋**

```bash
npm run typecheck
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/scripts/
git add -A
git commit -m "chore: trim version-sync TARGETS to 3, drop openclaw plumbing, cut web/ upstream fetch

version-sync fails loud on missing TARGETs (F21) — this unblocks phase 6.
web/ fetched upstream stats.json from jsDelivr, violating the no-upstream-
infrastructure charter (F40).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 그물 2 — 16개 식별자 잔재 grep (**단어경계 필수**)

**나이브 substring grep은 쓸 수 없다.** 실측: `omp` → 350파일(단어경계 35), `pi` → 359(62), `zed` → 95(28). `assert-bundle` 도 이 잔재를 못 잡는다(F16) — 번들에 `qwen`·`kimi` 문자열이 남아도 통과한다.

**Files:**
- Create: 없음 (검증 태스크)
- Modify: Step 2가 지목하는 모든 파일

- [ ] **Step 1: 16개 식별자를 단어경계로 훑는다**

**단어경계만으로는 부족하다.** 실측한 누수 형태:

| 형태 | `(?<![A-Za-z0-9-])kimi(?![A-Za-z0-9-])` | 조치 |
|---|---|---|
| `kimi_code` | 매치됨 ✓ (`_` 는 경계 문자에 없다) | — |
| `KIMI`, `Cursor`, `Zed` | **놓침** — 대소문자 구분 | `i` 플래그 |
| `qwenCode`, `openClaw` | **놓침** — camelCase | camel 패스 |
| **`GEMINI_CLI`, `ANTIGRAVITY_CLI_OPTS`** | **놓침** — needle 에 하이픈이 있다 | **snake 패스** |
| `antigravity-cli` 안의 `antigravity` | 매치 안 됨 ✓ (하이픈이 경계 문자) | 둘 다 목록에 있으니 무관 |

**snake 변형은 가설이 아니다.** 실측한 잔재 7건 — `hooks/core/platform-detect.mjs`, `hooks/session-helpers.mjs`(`GEMINI_CLI`, `ANTIGRAVITY_CLI_OPTS`), `scripts/ctx-debug.sh`. **앞의 둘은 우리가 유지하는 파일이다.** snake 패스가 없으면 잔재가 그대로 산다. (Codex 리뷰 Important 3)

`node -e` 는 deny 다 — 아래를 `.superpowers/sdd/residue-scan.mjs` 에 쓰고 `node .superpowers/sdd/residue-scan.mjs` 로 돌려라.

```js
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ids = ['gemini-cli','opencode','kilo','openclaw','vscode-copilot','jetbrains-copilot',
             'copilot-cli','cursor','antigravity','antigravity-cli','kiro','pi','omp','kimi','zed','qwen-code'];
const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());  // qwen-code -> qwenCode
const snake = (id) => id.replace(/-/g, "_");                               // gemini-cli -> gemini_cli
// docs/platform-support.md 는 Task 11 Step 6 이 다시 쓴다. 여기서 제외하지 않으면 절대 0 에 못 간다.
const skip = /^(docs\/superpowers\/|\.superpowers\/|refs\/|docs\/platform-support\.md$)|\.bundle\.mjs$/;
const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => !skip.test(f));

let total = 0;
for (const f of tracked) {
  let t;
  try { t = readFileSync(f, "utf8"); } catch { continue; }
  const lines = t.split("\n");
  for (const id of ids) {
    for (const needle of new Set([id, camel(id), snake(id)])) {
      const re = new RegExp(`(?<![A-Za-z0-9-])${needle}(?![A-Za-z0-9-])`, "i");  // i: KIMI, Cursor, GEMINI_CLI
      const hit = lines.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
      if (hit.length) { total += hit.length; console.log(`${f}:${hit.map((h) => h[0]).join(",")}  [${needle}]`); }
    }
  }
}
console.log("TOTAL RESIDUE:", total);
process.exit(total === 0 ? 0 : 1);
```

> `i` 플래그는 오탐을 늘린다 — `PI`, `OMP`, `Zed` 가 상수명·산문에서 걸린다. Step 2에서 판정하라. **오탐이 늘어나는 쪽이 잔재를 놓치는 쪽보다 낫다.**

- [ ] **Step 2: 각 히트를 판정한다 — 오탐 3종을 기억하라**

- **`kimi-k2` 는 모델 이름이다.** `executor.ts`/`lifecycle.ts`/`db.ts` 의 매칭은 주석이다. **편집 대상이 아니다.**
- **`src/adapters/codex/index.ts`** 는 Codex 카탈로그명을 유지하므로 손대지 않는다.
- **`docs/superpowers/`·`.superpowers/`** 는 이 작업의 기록이다. 위 스크립트가 이미 제외한다.
- **`docs/platform-support.md` 는 아직 17플랫폼을 나열한다.** Task 11 Step 6 이 다시 쓴다. 위 스크립트가 제외하므로 여기서 손대지 마라 — **제외하지 않으면 이 태스크는 절대 `TOTAL RESIDUE: 0` 에 도달하지 못한다.**

`kilo` 를 특히 확인하라(F51) — `src/adapters/kilo/` 디렉토리는 애초에 없었지만 `PlatformId`, `configs/kilo/`, `getAdapter` 의 `case "kilo":` 폴백에 존재했다. **빠뜨리기 가장 쉬운 하나다.**

- [ ] **Step 3: 잔재 0을 확인한다**

Step 1을 다시 돌린다. Expected: `TOTAL RESIDUE: 0`.

0이 아닌데 전부 정당한 오탐이라면, **그 목록을 커밋 메시지에 남기고 스크립트에 명시적 allowlist 로 박아라.** "확인했다"고 말만 하지 마라.

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "chore: zero residue for the 16 removed platform identifiers

Word-boundary grep, not substring: 'omp' naively matches 350 files
(prompt/compact/comparison), 'pi' matches 359 (api/pipeline). assert-bundle
does not catch this (F16). kilo had no adapter dir but lived in PlatformId
and getAdapter's fallback (F51).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: F25 번들 편입 + 번들 재생성 + pre-commit 신선도 가드 + 문서

**F25는 "미사용"이 아니라 "빌드 파이프라인 누락"이다.** 실측: `hooks/session-attribution.bundle.mjs` 는 `hooks/session-loaders.mjs:42` 와 `scripts/plugin-cache-integrity.mjs:137` 이 **실제로 로드한다.** 소스는 `src/session/project-attribution.ts`. 그런데 `npm run bundle` 은 이 번들을 만들지 않고 `assert-bundle` 은 검사하지 않는다 → **소스를 고쳐도 커밋된 번들은 영원히 옛 코드다.**

**Files:**
- Create: `.githooks/pre-commit`
- Modify: `package.json` (`bundle`, `assert-bundle` 스크립트)
- Modify: `docs/platform-support.md` (17플랫폼 나열 → 2)
- Modify: `README.md` · `CONTRIBUTING.md` (`core.hooksPath` 활성화 안내)

**Interfaces:**
- Consumes: Task 4–10의 소스 트리
- Produces: 7개 번들 전부가 `npm run bundle` 로 재생성되고 `assert-bundle` 로 검사된다

- [ ] **Step 1: `session-attribution` 을 `bundle` 에 편입한다**

`package.json` 의 `bundle` 끝에 추가:

```
 && esbuild src/session/project-attribution.ts --bundle --platform=node --target=node18 --format=esm --outfile=hooks/session-attribution.bundle.mjs --minify
```

`assert-bundle` 인자에도 `hooks/session-attribution.bundle.mjs` 를 추가한다.

- [ ] **Step 2: 재생성이 실제로 그 파일을 건드리는지 확인한다**

```bash
npm run bundle
git status --porcelain hooks/session-attribution.bundle.mjs
```
Expected: `M hooks/session-attribution.bundle.mjs` — **비어 있으면 esbuild 가 그 파일을 안 쓴 것이다.** 소스 경로를 다시 확인하라.

- [ ] **Step 3: pre-commit 가드를 만든다 (추적되는 훅, husky 없음)**

`.githooks/pre-commit` 신규 (LF, 실행 권한 불필요 — git이 `core.hooksPath` 훅을 `sh` 로 부른다):

```sh
#!/bin/sh
# 번들 신선도 가드 (F55 결정, 2026-07-10).
#
# 이 fork 는 GitHub Actions 를 켜지 않는다. `assert-bundle` 은 스테일 번들을
# 잡지 못하고(`__require("node:...")` 셰임만 스캔한다), 마켓플레이스는
# autoUpdate: true 다 → 스테일 번들은 CI 빨간불이 아니라 **런타임에 옛 코드가
# 조용히 도는 것**이다. 이 훅이 유일한 방어선이다.
#
# 막는 것:
#   - 번들 빌드 실패
#   - unstaged 스테일 번들 (가장 흔한 경우)
#   - staged 스테일 번들 (재생성본과 index 가 다르므로 diff 가 잡는다)
#   - 부분 스테이징 (index 의 소스 A + worktree 의 소스 B) — 아래 2단계 검사
#
# 못 막는 것 (수용한다, 단일 머신 fork):
#   - `git commit --no-verify`
#   - `git config core.hooksPath .githooks` 를 안 켠 clone
#   - 이 훅이 설치되기 전(Task 1~10)의 커밋
#
# ponytail: 협업자가 생기면 CI 로 옮겨라 — 그때는 esbuild 를 정확 버전으로 핀하고
# package-lock.json 을 커밋해야 러너 간 오탐이 없다.
set -e

# 1) 부분 스테이징 차단. `npm run bundle` 은 worktree 에서 굽고 `git diff` 는
#    worktree-vs-index 를 본다. 번들 소스가 index 와 worktree 에서 다르면
#    "index 의 소스 A + 재생성된 번들 B" 가 커밋되어 가드를 통과한다.
#    (Codex 리뷰 Important 4)
if ! git diff --quiet -- src/ hooks/ start.mjs scripts/; then
  echo "pre-commit: bundle sources have unstaged changes." >&2
  echo "  The bundle is built from the worktree but you are committing the index." >&2
  echo "  Stage them ('git add -u') or stash them, then commit again." >&2
  git diff --name-only -- src/ hooks/ start.mjs scripts/ >&2
  exit 1
fi

# 2) 번들 신선도.
npm run bundle >/dev/null 2>&1 || {
  echo "pre-commit: 'npm run bundle' failed — fix the build before committing." >&2
  exit 1
}

if ! git diff --exit-code --quiet -- server.bundle.mjs cli.bundle.mjs 'hooks/*.bundle.mjs'; then
  echo "pre-commit: stale bundle(s) detected." >&2
  echo "  Run 'npm run build', stage the regenerated *.bundle.mjs, and commit again." >&2
  git diff --name-only -- server.bundle.mjs cli.bundle.mjs 'hooks/*.bundle.mjs' >&2
  exit 1
fi
```

> 검사 1은 "번들 소스를 부분 스테이징한 채로는 커밋할 수 없다"는 뜻이다. 다소 엄격하지만 **번들이 index 가 아니라 worktree 에서 구워진다는 사실**의 직접적 귀결이다. 우회하려면 `git stash push --keep-index` 후 커밋하라.

- [ ] **Step 4: 훅을 활성화하고 실제로 발동하는지 관측한다**

```bash
git config core.hooksPath .githooks
# 일부러 소스를 건드려 번들을 스테일로 만든다
printf '\n// stale-check\n' >> src/security.ts
git add src/security.ts && git commit -m "should be blocked"
```
Expected: 커밋 **거부**, stderr 에 `pre-commit: stale bundle(s) detected.` 와 `hooks/security.bundle.mjs`.

```bash
git restore --staged src/security.ts && git checkout -- src/security.ts && npm run bundle
```

> **가드가 발동하는 것을 눈으로 보지 않았다면 가드가 있는 게 아니다.** 판정 5(단계 2)에서 배운 것과 같다: 파일에 코드가 있다는 건 실행 증명이 아니다.

- [ ] **Step 5: 전체 빌드 + 전체 테스트**

```bash
npm run build
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
```
Expected: `build` 는 `tsc` → `bundle` → `assert-bundle` → `assert-asymmetric-drift` 전부 통과. vitest 전부 통과.

- [ ] **Step 6: 문서를 맞춘다**

`docs/platform-support.md` — 17플랫폼 나열을 `claude-code`·`codex` 둘로. `README.md`·`CONTRIBUTING.md` 에 한 줄:

```
git config core.hooksPath .githooks   # 번들 신선도 가드 활성화 (clone 후 1회)
```

**`README.md:5-11` 의 ELv2 "modified fork" 고지와 상류 링크는 건드리지 마라 — 라이선스 의무다.**

- [ ] **Step 7: 커밋 (가드가 자기 자신을 검사한다)**

```bash
git add -A
git commit -m "build: bundle session-attribution, add pre-commit bundle-freshness guard

session-attribution.bundle.mjs is loaded by hooks/session-loaders.mjs:42
and scripts/plugin-cache-integrity.mjs:137 but was never regenerated by
'npm run bundle' — editing its source silently shipped the old bundle (F25).

Actions stay dark on this fork (F55), so the freshness check lives in
.githooks/pre-commit. Enable with: git config core.hooksPath .githooks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `main` 으로 squash

스펙 §8.3: **작업 브랜치에서 점진 커밋 → `main` 에 squash 1커밋.** `merge=ours` 로 번들을 덮는 것은 금지.

- [ ] **Step 1: 최종 상태를 검증한다**

```bash
git switch spec/fork-phase-3
npm run build
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
# 절대 파일 수가 아니라 **삭제 건수**를 센다. 이 계획은 파일을 3개 추가한다
# (.githooks/pre-commit, tests/hooks/cache-heal-version-segment.test.ts, 이 계획 문서).
git diff --name-status main...HEAD | grep -c '^D'
wc -l < .superpowers/sdd/phase3-tests-exclusive.txt   # Task 6 Step 1 의 판정 결과
```
Expected: `npm run build` 와 vitest 는 종료 코드 0.

**삭제 건수 = `183 + N`** 이어야 한다. 여기서 `183` 은 실측으로 확정된 네 그룹(Task 4 = 140, Task 5 = 5, `tests/adapters/` = 31, Task 9 = 7)이고 `N` 은 `phase3-tests-exclusive.txt` 의 줄 수다.

> **`204` 를 하드 게이트로 쓰지 마라.** 스펙 §8.1의 204는 계산된 수치다. 그 안의 `tests/` 나머지 "21"은 **관측된 적이 없다** — 실측하면 후보가 61개, `claude-code`/`codex` 를 안 쓰는 것만 41개이며 그중 `tests/fixtures/playwright-snapshot.txt` 는 스펙 스스로 오탐이라 부른 파일이다. `N` 이 21에서 멀면(예: 15 미만 또는 30 초과) 판정을 다시 보라. 하지만 **21이 아니라는 이유만으로 멈추지는 마라** — 정직한 판정이 스펙의 산술보다 우선한다.

- [ ] **Step 1b: 최종 삭제 목록을 사람이 읽는다**

```bash
git diff --name-status main...HEAD | grep '^D' | cut -f2 | sort > .superpowers/sdd/phase3-final-deletions.txt
```

`npm run bundle` 이 만드는 7개 번들과 `.claude-plugin/` · `.codex-plugin/` · `configs/{claude-code,codex}` · `hooks/core/` · `hooks/codex/` 가 **목록에 없는지** 확인하라.

- [ ] **Step 2: 태그가 그대로인지 확인한다**

```bash
git tag | wc -l    # 198 이어야 한다 — 단계 5 전까지 손대지 않는다
```

- [ ] **Step 3: squash**

```bash
git switch main
git merge --squash spec/fork-phase-3
git commit -m "refactor: delete 204 files for unsupported clients, derive pluginKey, guard bundles

Hard fork supports Claude Code and Codex only. Narrows PlatformId to three,
deletes 15 adapters + 9 hook dirs + 16 config dirs + 53 tests, hard-fails on
unsupported clientInfo.name, and revives two dead self-heals (F52, F54).

Version stays 1.0.0 — per spec 6.3 the running tree is still the phase-2
install. These deletions reach Claude at the phase-6 bump to 1.0.1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: push 는 사용자 승인 후에만**

`git push origin main` 은 **바깥을 향하는 작업이다.** 단계 0–2에서도 사용자가 직접 눌렀다(Task 4 Step 7). 여기서 멈추고 물어라.

---

## 이 계획이 하지 않는 것

- **`npm publish` 를 되살리지 않는다.** `package.json:89` 의 `"prepublishOnly": "npm run build"` 는 `"private": true` 때문에 도달 불가다. 의도된 귀결이지 회귀가 아니다. 죽은 코드 정리 후보이나 이 단계 범위 밖이다.
- **GitHub Actions 를 켜지 않는다** (F55 결정). `ci.yml` 은 그대로 두되 실행되지 않는다. 신선도 검사는 Task 11의 pre-commit 훅이 전담한다.
- **`esbuild` 를 핀하지 않고 `package-lock.json` 을 커밋하지 않는다.** 스펙 §8.3 전제 2는 크로스-러너 결정성 문제였고, Actions 를 켜지 않기로 한 순간 소멸했다.
- **태그 198개를 지우지 않는다** (단계 5).
- **버전을 올리지 않는다** (단계 6). 삭제는 단계 6까지 Claude 에 도달하지 않는다.
- **`upstream` 을 merge 하지 않는다.**

## 남는 위험 — 이 계획이 닫지 못한 것 (Codex 리뷰 Important 5)

**단계 6 실패에 대한 롤백 절차가 아직 없다.** 스펙 §6.3에 의해 이 계획의 코드는 단계 6의 `1.0.1` 상향 전까지 설치본에서 실행되지 않는다. Task 3 Step 7이 실제 설치 경로로 `derivePluginKey()` 를 돌려 보지만, 그건 **로컬 helper import** 일 뿐이다 — 배포된 `postinstall`·`cli`·`server`·`healScript` 의 통합 실행은 여전히 단계 6이 처음이다.

스펙 §"롤백"은 단계 3 실패를 "브랜치 폐기"로만 다루고, **`1.0.1` 을 배포한 뒤 깨진 경우**의 절차가 없다. 단계 2의 롤백 창(약 7일, 고아 캐시 dir 자동 정리)이 그때는 이미 닫혔을 수도 있다.

**단계 6 계획에 반드시 포함할 것:** `1.0.1` 배포 직후 검증 게이트(단계 2의 `verify-cutover.mjs` 에 준하는 것) + 실패 시 `1.0.0` 으로 되돌리는 절차. 이 계획에서는 다루지 않는다.
