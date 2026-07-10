# 인계 — 단계 2 커토버 게이트

이 문서는 **Claude Code 재시작 이후의 새 세션**을 위한 것이다. 커토버는 재시작을 요구하므로 그 대화는 끝난다. 새 세션은 이 문서만 읽고 이어갈 수 있어야 한다.

- 작성: 2026-07-10
- 플러그인 저장소 `origin/main` = `50d7fab`
- `~/.claude` 저장소 = `3fa7c60` (remote 없음 — 로컬 전용)
- 진행 원장(추적 안 됨, 디스크에만 존재): `.superpowers/sdd/progress.md`

---

## 1. 지금까지 무엇을 했나

`wotjr1649/context-mode`는 `mksglu/context-mode`(ELv2)의 **하드 포크**다. 단계 0~2를 서브에이전트 방식으로 실행했고, 여섯 태스크 전부 개별 리뷰를 통과했다.

| 커밋 | 내용 |
|---|---|
| `e9057c4` | `upstream` remote(`--no-tags`) 추가 + `CLAUDE.md`에 하드 포크 규칙 |
| `8d4bc06` | 상류 CDN을 6시간마다 퍼지하던 `update-stats.yml`, e2e 워크플로 2개, `stats.json`, `.github/FUNDING.yml` 등 **9파일 삭제**. `bundle.yml` → `workflow_dispatch` 전용 |
| `b2228d7` | 이슈 템플릿·CONTRIBUTING·README 뱃지·`package.json` 메타를 fork로. `"private": true` |
| `07a14b9` | **Claude 마켓플레이스 `context-mode` → `context-mode-js`**, 버전 라인 `1.0.0`, 매니페스트 10개 동기화 |
| `241a864` | `start.mjs`가 레지스트리 키를 `__dirname`에서 파생 (`<플러그인>@<마켓플레이스>`) |
| `3fa7c60` (`~/.claude`) | `deps-heal`·`lock-heal`이 캐시 부모를 레지스트리에서 유도(`context-mode@` 접두사) + `--ignore-scripts` |

**왜 개명했나.** Claude Code는 플러그인을 `~/.claude/plugins/cache/<마켓플레이스>/<플러그인>/<버전>/`에 둔다. `start.mjs`의 forward-heal은 매 MCP 부팅마다 **그 캐시 부모의 최고 semver 디렉토리로 레지스트리를 다시 쓴다.** 상류와 마켓플레이스명을 공유하면 fork의 `1.0.0`이 상류의 `1.0.169`에 영원히 진다. 개명은 fork에 빈 캐시 부모를 준다.

---

## 2. 커토버 (사용자 수행 — 아직 안 했다면)

**중간에 Claude Code를 재시작하지 말 것.** 네 줄을 한 세션 안에서 연달아 실행한다.

```
/plugin uninstall context-mode@context-mode
/plugin marketplace remove context-mode
/plugin marketplace add wotjr1649/context-mode
/plugin install context-mode@context-mode-js
```

그다음 **Claude Code를 일반 재시작**한다. 캐시를 지우지 않으므로 강제 종료도 `.in_use` 잠금 해제도 필요 없다.

Codex 쪽: `codex plugin marketplace upgrade context-mode` (Codex는 SHA 기준이라 이름 그대로 둔다).

`~/.claude/settings.json`의 `enabledPlugins`에서 옛 키 `"context-mode@context-mode"`는 지우거나 `false`로 둔다. `start.mjs`가 키를 파생하므로 더는 되살아나지 않는다 — 벨트일 뿐이다.

---

## 3. 게이트 — 이걸 통과해야만 단계 3을 계획한다

### 3.1 스크립트 판정 (1·2·3·4·6)

```bash
node docs/superpowers/verify-cutover.mjs
```

종료 코드 `0` = 통과. 비-0 = **단계 3으로 진행 금지.**

이 스크립트는 양방향으로 검증됐다. 커토버 전 실제 상태에서 0/9를 내며 옛 트리를 돌리는 프로세스를 정확히 지목했고, 파일만 위조한 가짜 트리에서 8/9를 내며 **런타임 판정(4)만 실패**했다. 즉 파일 조작으로는 통과할 수 없다.

> 판정 4의 정규식은 `[\\/]`로 양쪽 구분자를 받는다. Claude Code는 MCP 서버를 **포워드슬래시** 경로로 띄우므로, 백슬래시 전용 정규식은 모든 프로세스를 "캐시 밖"으로 오판해 **항상 거짓 통과**한다. 초기 계획이 실제로 그랬다.

### 3.2 판정 5 — 훅이 실제로 발동하는가 (스크립트로 불가)

에이전트가 `WebFetch`를 한 번 호출한다. context-mode의 PreToolUse 훅이 살아 있으면 `ctx_fetch_and_index`로 리다이렉트(deny)된다. 그냥 fetch되면 훅이 안 돈 것이므로 **실패**다.

(이 하네스에서 `WebFetch`는 deferred일 수 있다. `ToolSearch`로 먼저 로드한다.)

### 3.3 게이트가 증명하는 것과 증명하지 않는 것

**증명한다:** fork 코드가 격리된 트리에서 실제로 실행된다.

**증명하지 않는다:** "`plugin.json`의 `version` 문자열이 재설치 키다"라는 가설(I1). 새 마켓플레이스 아래의 설치는 버전 게이트를 타지 않는 **신규 설치**다. 그건 단계 6에서 `1.0.0 → 1.0.1` 상향으로 따로 검증한다. 게이트가 통과해도 그 이상을 주장하지 마라.

또한 판정 3(파일에 `process.exit(0)`가 있다)은 **실행 증명이 아니다.** 고아 프로세스 0건은 "새지 않았다"이지 "그 줄이 돌았다"가 아니다.

---

## 4. 실패 시 롤백 (싸다 — 옛 트리를 지우지 않았다)

**첫 줄이 `false`를 되돌리는 것이어야 한다.** 커토버에서 `enabledPlugins["context-mode@context-mode"]`를 `false`로 뒀다면 `healSettingsEnabledPlugins`가 그걸 존중해 아무도 다시 활성화하지 않는다.

```
1. ~/.claude/settings.json 의 enabledPlugins["context-mode@context-mode"] 를 true 로
2. git -C ~/.claude revert 3fa7c60      (deps-heal / lock-heal 되돌리기)
3. /plugin uninstall context-mode@context-mode-js
4. /plugin marketplace add mksglu/context-mode
5. /plugin install context-mode@context-mode
```

설치되는 것은 `1.0.169`가 아니라 **상류 최신**이다 — 로컬 캐시가 버전을 고정하지 못한다. **롤백 창은 약 7일**(고아 캐시 dir이 자동 정리된다).

Codex도 함께: `~/.codex/config.toml`의 `[marketplaces.context-mode]` source를 `mksglu/context-mode`로 되돌린 뒤 `codex plugin marketplace upgrade context-mode`.

---

## 5. 하드 스톱

**게이트가 통과해도 단계 3을 시작하지 마라.** 단계 3(204파일 삭제)은 별도 spec → plan 사이클이다. 사용자에게 물은 뒤에만 착수한다.

완료된 태스크를 다시 실행하지 마라. `.superpowers/sdd/progress.md`와 `git log`가 권위다.

---

## 6. 단계 3으로 넘어갈 때 반드시 챙길 것

스펙 `docs/superpowers/specs/2026-07-10-context-mode-fork-foundation-design.md`의 §8.2-9b에 있으나, 두 번 놓쳤던 항목이라 여기 다시 적는다.

- **`hooks/cache-heal-utils.mjs:291`의 `versionSegmentRe`**(F52). 주석이 아니라 `sessionstart.mjs:132`가 매 세션 호출하는 **살아 있는 정규식**이다. `cache/` 접두사 없이 `context-mode/context-mode/`에 앵커되어 개명 후 매칭에 실패한다.
- **`heal-installed-plugins.mjs:547-557`의 `sweepStaleMcpJson` 키→경로 매핑 반전**(F54). `<owner>@<plugin>` → `cache/<owner>/<plugin>`으로 매핑하지만 실제는 `<플러그인>@<마켓플레이스>` / `cache/<마켓플레이스>/<플러그인>`이다. 고치지 않으면 개명 후에도 죽어 있다. **단계 2 이후 살아나는 자가치유는 넷 중 셋이다.**
- `scripts/postinstall.mjs`(6) · `src/cli.ts`(5) · `src/server.ts`(1)의 `pluginKey` 리터럴, `start.mjs:348`의 `healScript` 템플릿, 캐시 경로 리터럴(`src/cli.ts:1642`, `src/util/sibling-mcp.ts:68`).
- 삭제 grep은 **16개** 플랫폼 식별자다 — `kilo`는 `src/adapters/kilo/` 디렉토리가 없지만 `PlatformId`와 `getAdapter` 폴백에 존재한다(F51).

**미결 결정(F55):** 이 fork는 GitHub Actions run이 **총 0건**이다. 포크는 Actions 탭에서 한 번 켜기 전까지 워크플로가 실행되지 않는다. 단계 3에 넣기로 한 번들 신선도 가드(`ci.yml`의 `npm run bundle && git diff --exit-code`)는 Actions를 켜지 않으면 **무효**다. 켤지, 아니면 로컬 pre-commit이나 배포 절차의 수동 스텝으로 옮길지 먼저 정한다.

---

## 7. 절대 하지 말 것 (전역 제약)

- `npm version` 사용 — 태그 `v1.0.0`·`v1.0.1`이 이미 존재해 충돌한다. `package.json`을 손으로 고치고 `npm run version-sync`.
- `git fetch upstream --tags` / `git push origin --tags` — 상류 태그 198개가 origin에 재유입된다.
- `upstream/main`을 `main`에 merge — 이 저장소는 하드 포크다.
- fork를 상류와 같은 캐시 부모(`cache/context-mode/context-mode/`)에 설치.
- `~/.claude/hooks/context-mode-cache-heal.mjs` 손으로 수정 — `start.mjs`가 매 부팅 덮어쓴다.
- Claude 훅에서 stderr 출력.
- vitest를 메모리 캡 없이 실행 — `--pool=forks --maxWorkers=1`, `NODE_OPTIONS=--max-old-space-size=2048`.
- `assert-bundle`이 스테일 번들을 잡는다고 가정 — 잡지 않는다. `__require("node:...")` 셰임만 스캔한다.
