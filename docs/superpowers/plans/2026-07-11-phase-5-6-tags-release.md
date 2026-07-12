# 단계 5·6 — 태그 정리 + 1.0.1 릴리스 준비 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or execute inline. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 상류 태그 198개를 fork 자체 태그 라인으로 대체하고(`v1.0.0` 하나), `1.0.1` 실배포에 필요한 준비물(배포-후 검증 게이트 + `1.0.0` 복귀 절차 + 버전 상향 커밋)을 만든다. **실제 push·커토버·I1 검증은 사용자 승인 후에만** — 계획은 그 직전에서 멈춘다.

**Architecture:** 단계 5는 순수 git 태그 조작(파괴적이나 스냅샷으로 가역). 단계 6은 두 부분으로 쪼갠다 — (6a) 저장소에 만드는 준비물(스크립트·문서·버전 커밋, 되돌리기 쉬움)과 (6b) 사용자 머신에 닿는 실배포(push + `/plugin update` + I1 관측, 되돌리기 어려움). 6a까지만 하고 6b는 하드 스톱.

**Tech Stack:** git tag / `git push origin :refs/tags/<t>` (개별 삭제, `--tags` 금지), `scripts/version-sync.mjs`(매니페스트 version 동기화, git·태그 미조작), Node ESM(verify-deploy 게이트).

## Global Constraints

`CLAUDE.md` §7 + 스펙 §11 "하지 말 것". **모든 태스크에 암묵 포함.**

- **`git push origin --tags` 금지.** 상류 태그를 origin에 재유입시킨다(스펙 §11, §6.239). 원격 태그 삭제는 **개별** `git push origin :refs/tags/<name>`.
- **`git fetch upstream --tags` 금지.** `upstream` merge 금지.
- **`npm version` 금지.** 태그 `v1.0.0`·`v1.0.1`이 이미 (상류 계보로) 존재해 충돌한다. **`package.json`을 손으로 편집 → `npm run version-sync`** → `git tag`는 별도 수동.
- **태그 삭제 전 스냅샷 필수.** `.superpowers/sdd/tags.snapshot`이 이미 있다(198개, annotated 123 + lightweight 75 — 복원 시 이 구분 보존). 없으면 삭제 중단.
- **6b(실배포)는 사용자 승인 전까지 금지.** push, `/plugin marketplace update`, `/plugin update`, `~/.claude`·`settings.json` 변경 전부. 6a까지만.
- 파일 출력 UTF-8(BOM 없음) LF. 코드 주석 영어. `node -e`/`node -p`/`rm` DENY. `npm test` 금지(vitest 캡).
- 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- 전체 캡 스위트 기준: 실패 ⊆ pre-existing 6건.

---

## 실측 정정 — 스펙 §6 좌표와 현실 (이 표가 권위)

| # | 스펙 §6 가 말한 것 | 실측 (2026-07-11) |
|---|---|---|
| A | "v1.0.0을 단계 2 커밋에" | 단계 2 커밋 = **`07a14b9`** "feat: isolate the fork under its own marketplace, start version line at 1.0.0". `a048215`(핸드오프)가 아니라 이 커밋이 버전 라인을 1.0.0으로 시작했다 |
| B | `v1.0.0`·`v1.0.1` 이 이미 존재 (충돌) | **로컬·원격 모두 존재.** `v1.0.0`은 우리 history의 조상(상류가 공유 계보에 붙임), `v1.0.1`은 머지 커밋. 재생성 전 반드시 삭제(force 아님, delete-then-create) |
| C | 로컬 태그 198 = 원격 태그 198 | **일치 확인**(remote-only 0, local-only 0). "321"은 `^{}` peeled 라인 포함 착오 |
| D | version-sync 가 버전 처리 | `scripts/version-sync.mjs` 는 매니페스트 version 필드만 동기화. **git·태그 미조작.** 태그는 수동 `git tag`. `npm version` 미사용(스펙과 일치) |
| E | 단계 6 "1.0.1 상향 → push → 커토버" | **분리 필수.** 6a(버전 커밋·문서·게이트 = 저장소, 가역) / 6b(push·/plugin update·I1 = 사용자 머신, 비가역). 6b 는 사용자 승인 후 |

**단계 5의 v1.0.0 재부착 정당성:** 지금 HEAD(`2382389`)는 단계 3·4가 얹힌 코드지만, `v1.0.0`은 **"1.0.0으로 설치·검증됐던 트리"**를 가리켜야 하므로 `07a14b9`에 붙인다(스펙 §6.248). `v1.0.1`(단계 6)이 HEAD의 배포 코드를 가리킨다.

---

## File Structure

**신규:**
- `scripts/verify-deploy.mjs` — 배포 후 `installed_plugins.json`이 새 버전을 가리키는지 검증하는 게이트(단계 2의 `verify-cutover.mjs`에 준함). 단계 6b가 실행하지만 6a에서 만든다.
- `docs/superpowers/phase-6-release-runbook.md` — 사용자가 6b에서 따를 절차: push → 커토버 명령 → verify-deploy → I1 관측 → 실패 시 1.0.0 복귀.

**수정:**
- `package.json` — `version` `1.0.0` → `1.0.1` (6a의 마지막, 손 편집 + version-sync).
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` — version-sync가 동기화.

**태그(파일 아님):** 로컬 198 삭제 → `v1.0.0`@`07a14b9` 생성. 원격 198 개별 삭제. (`v1.0.1` 태그는 6b에서 push와 함께 — 6a에서 만들지 않는다.)

---

## Task 1: 태그 스냅샷 재확인 + 로컬 상류 태그 삭제

**Files:** (git refs만, 파일 없음)

- [ ] **Step 1: 스냅샷 무결성 확인**

```bash
wc -l .superpowers/sdd/tags.snapshot   # 198 이어야 한다
git for-each-ref refs/tags | wc -l     # 현재 로컬 태그 = 198
```
Expected: 둘 다 198. 스냅샷이 없거나 개수가 다르면 **STOP** — 스냅샷 없이 삭제 금지.

- [ ] **Step 2: 삭제 대상이 전부 상류 계보인지 확인 (v1.0.0/v1.0.1 포함 전부 삭제 예정)**

```bash
git tag | grep -c .    # 198
# 우리가 만들 v1.0.0 외에 보존할 fork 고유 태그가 있는가? — 없다(전부 상류)
git tag | grep -vE '^v[0-9]' | head    # 비-vN.N.N 태그(있으면 검토); 비어야 한다
```

- [ ] **Step 3: 로컬 태그 198개 전부 삭제**

```bash
git tag | xargs -r git tag -d
git for-each-ref refs/tags | wc -l    # 0 이어야 한다
```
Expected: 0.

- [ ] **Step 4: `v1.0.0`을 단계 2 커밋에 생성**

`07a14b9`가 "start version line at 1.0.0" 커밋임을 재확인 후:

```bash
git show 07a14b9 --no-patch --format='%h %s'   # "isolate the fork ... start version line at 1.0.0"
git tag -a v1.0.0 07a14b9 -m "context-mode-js fork — version line starts at 1.0.0 (phase-2 cutover tree)"
git tag                                          # v1.0.0 하나만
```
Expected: `v1.0.0` 단 하나.

> **커밋 없음** — 태그는 git ref이지 워킹트리 변경이 아니다. Task 1은 커밋을 만들지 않는다.

---

## Task 2: 원격 상류 태그 개별 삭제

**Files:** (원격 refs만)

> **`git push origin --tags` 절대 금지.** 그건 삭제가 아니라 재유입이다. 삭제는 refspec `:refs/tags/<name>` 을 개별로 민다.

- [ ] **Step 1: 원격 태그 목록 확보**

```bash
git ls-remote --tags origin | grep 'refs/tags/' | grep -v '\^{}' | sed 's#.*refs/tags/##' | sort > .superpowers/sdd/remote-tags-to-delete.txt
wc -l .superpowers/sdd/remote-tags-to-delete.txt   # 198
```

- [ ] **Step 2: 배치 삭제 (한 push 에 여러 refspec — 왕복 최소화)**

`xargs`로 refspec 배열을 만들어 한 번에:

```bash
# dry-run 먼저: 무엇을 지울지 출력
sed 's#^#:refs/tags/#' .superpowers/sdd/remote-tags-to-delete.txt | head -3
# 실제 삭제 (배치)
cat .superpowers/sdd/remote-tags-to-delete.txt | sed 's#^#:refs/tags/#' | xargs -r git push origin
```

> `git push origin :refs/tags/a :refs/tags/b …` 형태. Windows 명령줄 길이 제한에 걸리면 `xargs -n 50`으로 분할. **v1.0.0도 이 목록에 있다** — 상류의 v1.0.0을 지운 뒤 Step 3에서 우리 것을 민다.

- [ ] **Step 3: 우리 `v1.0.0` 하나만 원격에 push**

```bash
git push origin refs/tags/v1.0.0
git ls-remote --tags origin | grep 'refs/tags/' | grep -v '\^{}' | wc -l   # 1 이어야 한다 (v1.0.0)
```
Expected: 원격 태그 = `v1.0.0` 하나. **이것이 단계 5의 게이트**(스펙 §6.236: `git ls-remote --tags`가 v1.0.0 하나).

> **단일 태그 push는 `--tags`가 아니다** — `refs/tags/v1.0.0` 명시적 refspec은 그 하나만 민다. 안전.

---

## Task 3: verify-deploy 게이트 스크립트 (단계 6b가 쓸 준비물)

**Files:**
- Create: `scripts/verify-deploy.mjs`
- Test: `tests/scripts/verify-deploy.test.ts`

**Interfaces:**
- Produces: `verifyDeploy(registry, expectedVersion) → { ok: boolean, actual: string|null, reason: string }` — 순수 함수. `installed_plugins.json` 객체와 기대 버전을 받아 활성 installPath의 버전이 일치하는지 판정.

- [ ] **Step 1: 실패하는 테스트**

`tests/scripts/verify-deploy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { verifyDeploy } from "../../scripts/verify-deploy.mjs";

const reg = (installPath: string) => ({
  plugins: { "context-mode@context-mode-js": [{ version: "1.0.1", installPath }] },
});

describe("verifyDeploy — did /plugin update actually reinstall at the new version?", () => {
  it("ok when the active installPath's version segment matches expected", () => {
    const r = verifyDeploy(reg("/h/.claude/plugins/cache/context-mode-js/context-mode/1.0.1"), "1.0.1");
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });
  it("fails when the tree still points at the old version (I1 refuted)", () => {
    const r = verifyDeploy(reg("/h/.claude/plugins/cache/context-mode-js/context-mode/1.0.0"), "1.0.1");
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
  });
  it("fails when the plugin key is absent", () => {
    const r = verifyDeploy({ plugins: {} }, "1.0.1");
    expect(r.ok).toBe(false);
    expect(r.actual).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `Cannot find module`.

- [ ] **Step 3: 구현**

`scripts/verify-deploy.mjs`. Node 내장만. `installPath`의 버전 세그먼트를 파싱해 비교:

```js
// Verify a /plugin update actually reinstalled at the expected version —
// the empirical test of I1 (the version string is the reinstall key).
// Pure function for tests; the CLI wrapper reads installed_plugins.json.
export function verifyDeploy(registry, expectedVersion) {
  const entries = registry?.plugins?.["context-mode@context-mode-js"];
  const installPath = Array.isArray(entries) && entries[0]?.installPath;
  if (typeof installPath !== "string") {
    return { ok: false, actual: null, reason: "plugin key absent from installed_plugins.json" };
  }
  // …/cache/<marketplace>/<plugin>/<version>[/…]
  const m = installPath.match(/[/\\]cache[/\\][^/\\]+[/\\][^/\\]+[/\\]([^/\\]+)/);
  const actual = m ? m[1] : null;
  return {
    ok: actual === expectedVersion,
    actual,
    reason: actual === expectedVersion
      ? `installPath points at ${expectedVersion}`
      : `installPath points at ${actual ?? "(unparseable)"}, expected ${expectedVersion}`,
  };
}

// CLI: node scripts/verify-deploy.mjs <expectedVersion>
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const cfg = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR.replace(/^~[/\\]?/, homedir() + "/"))
    : resolve(homedir(), ".claude");
  const expected = process.argv[2];
  let registry;
  try {
    registry = JSON.parse(readFileSync(resolve(cfg, "plugins", "installed_plugins.json"), "utf8"));
  } catch (e) {
    console.error(`FATAL: cannot read installed_plugins.json: ${e.message}`);
    process.exit(2);
  }
  const r = verifyDeploy(registry, expected);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1 tests/scripts/verify-deploy.test.ts
node --check scripts/verify-deploy.mjs
git add scripts/verify-deploy.mjs tests/scripts/verify-deploy.test.ts
git commit -m "feat(scripts): verify-deploy gate for the phase-6 release

Reads installed_plugins.json after a /plugin update and asserts the active
installPath's version segment matches expected — the empirical test of I1
(the version string is the reinstall key). Pure verifyDeploy() for tests +
a CLI wrapper. Used by phase 6b (deploy), not the build.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 릴리스 런북 + 1.0.0 복귀 절차 (문서)

**Files:**
- Create: `docs/superpowers/phase-6-release-runbook.md`

- [ ] **Step 1: 런북 작성**

사용자가 6b에서 따를 정확한 절차. 실측 명령으로:

1. **전제:** `main` push 완료(origin = HEAD), 로컬 태그 = `v1.0.0` 하나, 작업트리 깨끗, 전체 스위트 ⊆ 6건.
2. **버전 상향(6a, 이미 커밋됨):** `package.json` `1.0.1` + version-sync로 매니페스트 동기화(Task 5).
3. **push:** `git push origin main` + `git push origin refs/tags/v1.0.1` (단일 refspec — `--tags` 아님).
4. **커토버(경량):** Claude — `/plugin marketplace update context-mode-js` 다음 `/plugin update context-mode@context-mode-js`. Codex — `codex plugin marketplace upgrade context-mode`.
5. **검증:** `node scripts/verify-deploy.mjs 1.0.1` → PASS 면 `installed_plugins.json`이 1.0.1을 가리킴 = **I1 확인**(버전 문자열이 재설치 키). FAIL 이면 I1 반증 — 재설치가 버전 게이트를 안 탄다.
6. **스모크:** Claude·Codex 각 세션에서 `ctx_execute`·`ctx_search`·`ctx_fetch_and_index` 각 1회 성공(단계 3·4 코드가 실제로 돎).
7. **1.0.0 복귀(실패 시):** `package.json` `1.0.0`으로 되돌림 + version-sync + `git push origin main` → `/plugin update` → `verify-deploy 1.0.0`. **v1.0.0 태그는 이미 원격에 있으므로 다시 push하지 않는다**(`--force` 불필요; 운영 절차는 런북을 따른다). **주의:** `installed_plugins.json`의 캐시는 약 7일 롤백 창(F48). 그 후엔 고아 캐시 자동 정리로 복귀가 재설치가 된다.

> 런북은 **사용자가 실행**한다. 이 문서는 명령을 정확히 담되, 실행하지 않는다.

- [ ] **Step 2: 커밋**

```bash
git add docs/superpowers/phase-6-release-runbook.md
git commit -m "docs: phase-6 release runbook + 1.0.0 rollback procedure

The exact user-run steps for the real deploy: push, lightweight cutover
(/plugin update), verify-deploy (the I1 test), smoke, and the rollback if
verify fails. The controller does not run these — the user does, after
approving the version bump.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 버전 1.0.1 상향 (6a의 마지막 저장소 변경)

**Files:**
- Modify: `package.json` (`version`), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` (version-sync)

- [ ] **Step 1: package.json version 손 편집**

`"version": "1.0.0"` → `"1.0.1"`. **`npm version` 쓰지 마라**(태그 충돌).

- [ ] **Step 2: version-sync로 매니페스트 동기화**

```bash
node scripts/version-sync.mjs
```
Expected: 3 매니페스트가 1.0.1로. (version-sync는 git·태그를 안 건드린다 — 매니페스트 version 필드만.)

- [ ] **Step 3: 동기화 확인**

```bash
node .superpowers/sdd/check-versions.mjs   # scratch: assert package.json + 3 manifests all == "1.0.1"
```

- [ ] **Step 4: 번들 재생성 (version 문자열이 번들에 박히는가?)**

version이 번들에 인라인되면 재빌드 필요. 확인 후:

```bash
npm run build   # tsc → bundle ×7 → assert-bundle → drift → residue scan
git status --porcelain -- '*.bundle.mjs' hooks/*.bundle.mjs
```
번들이 바뀌면 스테이징에 포함. pre-commit 가드가 이걸 요구한다.

- [ ] **Step 5: 게이트 + 커밋 (태그 없이 — v1.0.1 태그는 6b의 push와 함께)**

```bash
npm run typecheck
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run --pool=forks --maxWorkers=1
```
Expected: build 0, 스위트 ⊆ 6건.

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json
# + 번들이 바뀌었으면 함께
git commit -m "release: bump version to 1.0.1

Hand-edited package.json (npm version is forbidden — tags v1.0.0/v1.0.1
predate this) + version-sync to the 3 manifests. This is the version whose
string reinstall-keys the deploy in phase 6b; the tree it ships is the
phase-3+4 code (deletions, hard-fail, absorbed hooks). The v1.0.1 tag is
created with the push in 6b, NOT here.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **여기가 6a의 끝이자 하드 스톱.** `v1.0.1` 태그 생성, push, `/plugin update`, verify-deploy 실행 — 전부 6b이고 사용자 승인 후. 이 커밋까지가 저장소 준비물이다.

---

## Task 6: 최종 검증 + 6b 하드 스톱 보고

- [ ] **Step 1: 단계 5·6a 상태 스냅샷**

```bash
git tag                                  # v1.0.0 하나 (로컬)
git ls-remote --tags origin | grep -v '\^{}' | grep -c refs/tags   # 1 (원격 v1.0.0)
grep '"version"' package.json            # 1.0.1
git log --oneline -5
git status --porcelain                   # 깨끗 (tmp 제외)
```

- [ ] **Step 2: 6b 준비물 존재 확인**

`scripts/verify-deploy.mjs`, `docs/superpowers/phase-6-release-runbook.md` 존재 + 버전 커밋 완료.

- [ ] **Step 3: 사용자에게 6b 하드 스톱 보고**

단계 5 완료(태그 정리), 6a 완료(준비물). **6b(push + 커토버 + I1)는 사용자 결정.** 런북 경로 + verify-deploy 사용법 제시하고 멈춘다. **push·`/plugin update` 자동 실행 금지.**

---

## 이 계획이 하지 않는 것

- **6b 실배포를 실행하지 않는다.** `git push origin main`(1.0.1 커밋), `v1.0.1` 태그 생성·push, `/plugin marketplace update`, `/plugin update`, verify-deploy 실행 — 전부 사용자 승인 후. Task 5까지가 저장소 준비물이고 거기서 멈춘다.
- **I1을 지금 증명하지 않는다.** 6b의 `/plugin update` + verify-deploy가 유일한 증명. 그전까지 I1은 미검증 가설.
- **`~/.claude`·`settings.json`을 건드리지 않는다.** 커토버는 사용자 수행.
- **태그 스냅샷을 지우지 않는다.** 롤백 창(약 7일) 동안 `.superpowers/sdd/tags.snapshot` 보존.
- **`git push origin --tags` 를 절대 쓰지 않는다.** 원격 태그 조작은 개별 refspec만.
