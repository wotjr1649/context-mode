# context-mode 개인 fork — 기반(Foundation) 설계

- 작성: 2026-07-09 · 개정: 2026-07-10 (리뷰어 5인 반영) · **승인됨**
- fork: `wotjr1649/context-mode` (`main` @ `e94be92`) · 상류: `mksglu/context-mode` (`main` @ `43a2066`)
- 라이선스: ELv2

이 문서는 개인 fork의 **기반**만 다룬다. 개별 이슈 수정과 개별 신규 기능은 각각 별도 spec → plan 사이클로 처리한다.

## 리뷰 이력

Codex(교차 모델) · 보안 감사 · 코드 정확성 · 레드팀 · 시퀀싱 — 5인 병렬 리뷰를 거쳤다. 블로킹 결함 4건, 보안 Critical 1건·High 1건, 저자 사실오류 4건이 드러났고 전부 이 문서에 반영됐다. 리뷰어의 모든 주장은 저자가 저장소에서 직접 재확인했다.

---

## 1. 목표

1. **개인화** — 지원 대상을 Codex와 Claude Code 둘로 한정
2. **신규 개발** — Windows·Linux 환경에 맞는 기능 추가
3. **기존 이슈 해결** — 상류 열린 이슈 중 지원 범위 안의 것

---

## 2. 사실 기반

### 2.1 확정 (1차 출처 또는 직접 실행)

| # | 사실 | 근거 |
|---|---|---|
| F1 | Claude 설치 캐시의 6개 버전(1.0.162~169) 전부 `flushAndExit` 없음 | grep |
| F2 | 설치된 `1.0.169/hooks/run-hook.mjs` vs fork 동일 파일 diff = fork가 추가한 exit 6줄뿐 | `diff` |
| F3 | 마켓플레이스 카탈로그 클론은 이미 fork HEAD(`e94be92`) | `git remote -v` |
| F4 | `installed_plugins.json`: `installPath=.../1.0.169`, `version=1.0.169`, `gitCommitSha=4dedadc`(상류) | 판독 |
| F5 | Claude 재설치 키 = `plugin.json`의 `version` **문자열**. 같으면 스킵. 생략 시 커밋 SHA 대체. `plugin.json` > marketplace 항목 | docs.claude.com plugins-reference |
| F6 | 게이트는 **문자열 동등성**이지 semver 대소가 아니다. 강제 재설치 플래그 없음 | 동 출처 |
| F7 | `source`는 `ref`/`sha` 지원. 현재 fork는 **핀 없음**, `main` 추적, `autoUpdate: true` | 동 출처 + settings.json |
| F8 | Codex `marketplace upgrade`는 **git SHA 기준** | openai/codex `marketplace_upgrade.rs` |
| F9 | 로컬 26개 플러그인: sha-keyed 7개 전부 당일 갱신, version-keyed는 version 문자열이 마지막 바뀐 날짜에 정지 | 집계 |
| F10 | `PlatformId`(`types.ts:474`) = 19개 유니온 | 판독 |
| F11 | `detectPlatform()`는 런타임 `clientInfo.name` 디스패치. `getAdapter()`는 동적 import | 판독 |
| F12 | `ensure-deps.mjs`를 `src/{cli,db-base,runtime}.ts`, `hooks/{run-hook,stop}.mjs`, `start.mjs` + 각 클라이언트 훅이 import | grep |
| F13 | fork는 상류 대비 `ahead_by=0, behind_by=2` — 동기화할 상류 커밋 0개 | `gh api compare` |
| F14 | 상류 PR #937 = OPEN·MERGEABLE | `gh pr view` |
| F15 | 캐시 6개 dir 전부 실행 중 PID로 `.in_use` 잠김 | 판독 |
| F16 | **`assert-bundle.mjs`는 재빌드 비교를 하지 않는다.** 104줄 전부 `__require("node:...")` 셰임 스캔(#511). `ci.yml`에 `git diff --exit-code` 없음 → **스테일 번들은 CI를 통과한다** | 스크립트 본문 |
| F17 | **`cache-heal.mjs`**: `:43` `/^\d+\.\d+/` 필터 → `:16` semver 오름차순 → `:17` `symlinkSync(dirs[dirs.length-1], installPath, "junction")`. **`installPath` 소멸 시 최고 semver로 junction.** 상류가 자동 배포·자가 등록하며 uninstall 후에도 남고 `start.mjs`가 매 부팅 재배포 | 스크립트 본문 |
| ~~F18~~ | ~~semver-max junction은 `cache-heal.mjs` 단 한 곳에만 존재~~ **틀렸다. F34 참조** | — |
| F19 | 태그 `v1.0.0`·`v1.0.1`이 **이미 존재**(총 198개). `npm version 1.0.0`은 태그 충돌로 실패 | `git tag -l` |
| F20 | **fork의 GitHub 릴리스 = 0개.** 태그를 읽는 코드·워크플로 0건. `source`에 `ref` 핀 없음 → 태그는 순수 사람용. 상류에 198개가 남아 있어 **복원 가능** | `gh api releases` + grep |
| F21 | `version-sync.mjs:48-49`는 `package.json`의 version을 **읽어 복사만** 한다. `:57` `if (content.version !== undefined)` — 없는 필드는 건드리지 않음. TARGETS 부재 시 fail-loud | 스크립트 본문 |
| F22 | `bundle.yml`: `on.push.paths = ['src/**','package.json','tsconfig.json']`, `permissions: contents: write` → **`package.json` push만으로 봇이 `main`에 자동 커밋** | 워크플로 |
| F23 | `update-stats.yml`: 6시간 cron, `contents: write`, `:61-62` `git commit && git push`, **`:67` `curl https://purge.jsdelivr.net/gh/mksglu/context-mode@main/stats.json`** — 상류 CDN을 fork cron이 퍼지 | 워크플로 |
| F24 | `foreignWorkspaceEnv`/`foreignIdentificationEnv`의 유일 호출부는 `src/adapters/pi/mcp-bridge.ts:446,461`(삭제 대상). `util/project-dir.ts:9`는 주석 → 삭제 후 죽은 코드 | grep |
| F25 | `hooks/session-attribution.bundle.mjs`는 커밋돼 있고 `hooks/session-loaders.mjs:42`가 런타임 동적 import 하지만 `bundle` 스크립트에도 `assert-bundle` 목록에도 **없다**(관리 밖) | grep |
| F26 | **`tsc`는 삭제 편집지점을 전부 열거하지 못한다.** 반례: `detect.ts:337 getSessionDirSegments(platform: string)`, `detect.ts:395 platformOverride as PlatformId`, `cli.ts:77 HOOK_MAP: Record<string,…>`, `cli.ts:158 hookDispatch(platform: string)`, `analytics.ts:628 ReadonlyArray<readonly [string, …]>` | 판독 |
| F27 | **`hooks/formatters/` 4개를 프로덕션이 아무도 import하지 않는다.** 유일 참조는 `tests/hooks/formatters.test.ts`. 실제 경로는 `hooks/core/formatters.mjs`의 `formatters[platform]`(`:344`). `formatDecision`이 중복 구현 | grep |
| F28 | `tests/adapters/` 밖에 클라이언트 전용 테스트 **21개**(직접 카운트). 내역: `tests/hooks/`의 클라이언트 훅 테스트 **9**(그중 `kimi-config-dir.test.ts`는 `-hooks` 접미사가 아니다) · `tests/fixtures/cursor/*` **5** · `tests/fixtures/kimi-wire.jsonl` · `tests/opencode-plugin.test.ts` · `tests/pi-extension.test.ts` · `tests/plugins/openclaw.test.ts` · `tests/session/parse-{gemini,openclaw,opencode}-usage.test.ts` **3** | `git ls-files` |
| F29 | `.mjs` 안전망 존재. 수치는 **테스트 케이스가 아니라 그 모듈을 참조하는 테스트 파일 수**다: `core/routing.mjs` 11파일, `core/tool-naming.mjs` 5파일, `core/platform-detect.mjs` 1파일. `core/formatters.mjs`는 `tests/formatters.test.ts`+`tests/core/cli.test.ts` | grep |
| F30 | 유지되는 두 어댑터는 `configs/codex/*`만 문자열 참조(`codex/hooks.ts:70`, `codex/index.ts:674,699,724`). `cli.ts`는 `configs/`를 문자열 참조하지 않는다 | grep |
| F31 | `tests/tier2-smoke-assert.test.ts`가 `assert-stats.mjs`를 spawn하고 `stats.json`(`:23`)을 읽는다. `package.json`의 `files` 필드에는 `stats.json`·`CLAUDE.md`가 없다 | 판독 |
| F32 | `package.json`의 `files` 필드가 `.openclaw-plugin`·`openclaw.plugin.json`을 나열한다 → 단계 3 삭제 시 함께 수정해야 한다 | 판독 |
| F33 | `bundle.yml`의 "Commit bundle" 스텝은 `git add -f` 후 `git push`한다. `ci.yml`은 `on: push [main, next]`이며 push하지 않는다 | 워크플로 |
| **F34** | **semver-max 선택은 세 곳에 있다.** ① `cache-heal.mjs:17` — `installPath` 소멸 시 junction ② `start.mjs:366` — ①의 배포 템플릿 원본 ③ **`start.mjs:164` — 매 MCP 부팅마다 `cacheParent`의 최고 semver dir로 `entry.installPath`·`entry.version`을 다시 쓰고 `installed_plugins.json`에 저장한다("Forward heal")**. ③은 `installPath`가 멀쩡해도 발동한다 | `start.mjs:148-200` |
| **F35** | 플러그인 캐시 경로는 `~/.claude/plugins/cache/<마켓플레이스명>/<플러그인명>/<버전>/`. `start.mjs:141`의 `cacheMatch` 정규식이 `.../cache/<X>/<Y>/`를 `cacheParent`로 잡으므로, **마켓플레이스 이름이 다르면 F34의 스캔 범위가 완전히 분리된다** | 정규식 + 실제 레이아웃 |
| **F36** | Claude의 마켓플레이스 이름은 `.claude-plugin/marketplace.json:2`의 `name`에서 온다. Codex 카탈로그는 `.agents/plugins/marketplace.json`로 **별개 파일**이므로 Claude 쪽만 바꿀 수 있다 | 판독 |
| **F37** | MCP 도구 이름 접두사는 `mcp__plugin_<플러그인명>_<서버명>__`이며 **마켓플레이스명을 포함하지 않는다**(`mcp__plugin_context7_context7__`, `mcp__plugin_dotnet-msbuild_binlog__`). 마켓플레이스 개명은 `settings.json`의 권한 허용 목록을 깨뜨리지 않는다 | 관측 |
| ~~F38~~ | ~~하드코딩은 전부 진단·업그레이드 경로다~~ **틀렸다. F42 참조** | — |
| **F42** | `context-mode@context-mode` **리터럴 전수**: `src/adapters/codex/index.ts`(9, Codex — 이름 유지하므로 무관) · `scripts/postinstall.mjs`(6) · `src/cli.ts`(5) · `start.mjs`(4) · `src/server.ts`(1). `scripts/heal-installed-plugins.mjs`는 `pluginKey`를 **인자로 받으므로 하드코딩이 아니다** | grep |
| **F52** | **F42의 캐시 경로 목록이 틀렸다.** `hooks/cache-heal-utils.mjs`를 "주석"으로 분류했으나, **`:291`의 `versionSegmentRe = /(context-mode[/\\]context-mode[/\\])([^/\\]+)([/\\]bin)/g`는 살아 있는 코드다.** `:309`에서 쓰이고 `hooks/sessionstart.mjs:132,158`이 `selfHealShellSnapshots`로 매 세션 시작마다 호출한다. 개명 후 경로는 `context-mode-js/context-mode/<v>/bin`이라 매칭에 실패해 **셸 스냅샷 자가치유가 조용히 no-op**이 된다(손상은 없다). 원래 grep이 `cache/` 접두사를 붙여 놓쳤다. **단계 3의 소비자 목록에 반드시 포함한다.** 나머지 캐시 경로 리터럴: `src/cli.ts:1642`, `src/util/sibling-mcp.ts:68`, `hooks/sessionstart.mjs:137`(주석) | 최종 브랜치 리뷰 + 실물 확인 |
| **F53** | `start.mjs`의 네 지점(`:190` forward-heal 게이트, `:206` reverse-heal 게이트, `:243` `pluginKey` 리터럴, `:253` 소비자)이 옛 키로 게이트되며, **`symlinkSync`는 `:206`의 게이트 안쪽에 있다** — 게이트 밖 폴백이 없다. `start.mjs`는 esbuild 번들 대상이 아니므로(`package.json`의 `files`에 raw로 실림) 수정에 번들 재생성이 필요 없고 `tests/scripts/start-mjs-*.test.ts` 3개가 커버한다 | 최종 브랜치 리뷰 + 실물 확인 |
| **F43** | `healSettingsEnabledPlugins`(`heal-installed-plugins.mjs:163-168`)는 `current === false`일 때만 `explicit-opt-out`으로 건너뛴다. `undefined`/`null`/`""`는 전부 `true`로 되살린다. `start.mjs:253`이 리터럴 옛 키를 넘기므로, **개명 후에도 `settings.json`의 `enabledPlugins["context-mode@context-mode"]`가 매 부팅 `true`로 재기입된다** | 스크립트 본문 |
| **F44** | **`postinstall.mjs`의 치유 블록(110~205)은 `if (isGlobalInstall())`로 감싸여 있고, `isGlobalInstall()`은 `npm_config_global !== "true"`면 `false`를 반환한다(`:89-90`).** `/plugin install`은 캐시 디렉토리로의 비-global `npm install`이므로 **그 6개 리터럴은 전부 스킵된다.** 옛 키를 되살리는 유일한 실행 경로는 `start.mjs:253`이다 | 스크립트 본문 |
| **F45** | `start.mjs`의 forward-heal(`:190`)과 reverse-heal(`:206`)은 `if (key !== "context-mode@context-mode") continue`로 게이트된다. `healInstalledPlugins`는 `entries.length === 0`이면 `skipped: "no-entry"`를 반환하며 **항목을 생성하지 않는다**(`:62-65`) | 스크립트 본문 |
| **F46** | **캐시의 `<마켓플레이스>/<플러그인>/<버전>` 2단 중첩은 1차 문서에 없다.** docs.claude.com은 캐시 루트와 "버전별 디렉토리, 고아는 7일 후 자동 삭제"까지만 규정한다. 중첩은 로컬 7/7 마켓플레이스와 `start.mjs:141`의 정규식으로만 확인된다 — **미문서 CC 내부 구현이며 D11의 유일한 1차-미검증 고리다** | docs + 로컬 |
| **F47** | 1차 출처 확인: ① `/plugin marketplace add`는 **`marketplace.json`의 `name`으로 등록**한다("the name from marketplace.json, not the source you passed to add") ② `extraKnownMarketplaces`의 키 = 마켓플레이스명 ③ `enabledPlugins` 포맷은 `plugin@marketplace: bool` ④ Claude의 자동 키 재작성은 마켓플레이스의 `renames` 맵(**플러그인** 개명)뿐이라 **마켓플레이스 개명엔 발동하지 않는다** ⑤ 명시적 `false`는 보존된다(로컬: `pyright-lsp` 등 3건 잔존) ⑥ 플러그인명은 kebab-case 유일 식별자 → `context-mode-js` 유효 | docs.claude.com |
| **F48** | **`/plugin marketplace remove`는 마지막 scope에서 제거될 때 그 마켓플레이스로 설치한 플러그인을 함께 uninstall한다**(1차). 따라서 계획의 `uninstall` → `remove` 순서는 중복이나 무해하다. **고아 캐시 디렉토리는 7일 후 자동 삭제된다**(1차) → 수동 삭제 불필요가 강화되지만 **롤백 창이 약 7일**이다 | docs.claude.com |
| **F49** | **실행 중인 MCP 서버 프로세스의 CommandLine은 포워드슬래시다.** 실측(PID 40832): `"C:/Program Files/nodejs/node.exe" C:/Users/js/.claude/plugins/cache/context-mode/context-mode/1.0.169/start.mjs`. 백슬래시 전용 정규식은 `NO-MATCH`를 내 **모든 프로세스를 "캐시 밖"으로 오판하고 거짓 PASS를 만든다** | `Get-CimInstance` 실행 |
| **F50** | `~/.claude/hooks/`의 힐 훅은 4개가 아니라 **5개**다: `cache-heal`(키 하드코딩) · `deps-heal`(키+캐시경로) · `lock-heal`(캐시경로) · `orphan-reaper` · **`prune-versions`**(키+캐시경로+`rmSync`, `settings.json`에 미등록). `prune-versions`는 옛 키 항목이 0이면 fail-safe로 `exit(0)`하므로 **개명 후 옛 트리를 삭제하지 않는다** — 롤백 전제와 충돌하지 않는다 | 파일 판독 |
| **F51** | `PlatformId` 19개 중 유지 3개(`claude-code`·`codex`·`unknown`) → **제거 식별자는 16개**다. `kilo`는 `src/adapters/kilo/` 디렉토리가 없지만 `PlatformId`·`configs/kilo`에 존재하고 `getAdapter`에 `case "kilo": case "opencode":` 폴백이 있다 | 판독 |
| **F39** | `version-sync.mjs`의 `TARGETS`는 11개가 아니라 **10개**다 | 판독 |
| **F40** | D9가 놓친 상류 접점: `.github/FUNDING.yml`(`github: [mksglu]`), `package.json:27 repository.url`·`:29 homepage`·`:50 bugs`, `web/{index,insight,context-saving}.html`·`web/og/render-og.mjs`(상류 `stats.json` fetch) | grep |
| **F41** | `~/.claude/plugins/installed_plugins.json.bak.*`을 읽는 코드는 **0건**(죽은 백업). `uninstall` 후 남는 훅 4개는 캐시 부재 시 전부 `exit(0)`. `heal-installed-plugins.mjs:105-110`은 `enabledPlugins[key]`를 매 부팅 재기입한다 | grep |

### 2.2 추론 (반증 대상)

| # | 추론 | 상태 |
|---|---|---|
| I1 | Claude가 fork를 안 돌리는 원인 = **설치본 version과 문자열이 같아** 재설치 스킵 | 레드팀 반증 실패. 대안 가설(SHA가 키 / 카탈로그 미pull / `.in_use` 차단) 전부 반증됨. **여전히 추론이며, 단계 2가 그 검증이다** |
| ~~I2~~ | ~~다운그레이드를 Claude가 거부한다~~ | **반증됨.** F6에 의해 근거 없음. 수동 캐시 삭제의 진짜 이유는 F15(잠금) + F17(junction 부활) |
| I3 | Linux에는 nodejs/node#22999 계열 고아 누수가 없다(init 재부모화) | `orphan-reaper`의 플랫폼 가드 근거 |

### 2.3 포팅 마찰 측정 (직접 실측)

상류 최근 300커밋, `git log --name-only` 집계. Codex의 독립 측정과 오차 1%p 이내로 일치.

| 표본 | 삭제경로 접촉 | hot 파일 접촉 | 둘 다 | 무충돌 |
|---|---:|---:|---:|---:|
| 최근 200커밋 | 11.5% | 23.5% | 8.0% | 73.0% |
| 봇 제외, 사람 커밋 221건 | 16.3% | 32.6% | 12.7% | **63.8%** |

단, **파일 접촉 ≠ hunk 충돌**이다. 표본 검사: `src/server.ts`는 최근 사람커밋 12건 중 직격 0건. `src/session/extract.ts`는 근접하나 비중첩. `src/session/analytics.ts`는 12건 중 2건이 편집 지점(630~645, 1983)을 직격.

직격 지점은 **플랫폼 열거 테이블**이다. 우연이 아니라 구조적이다 — 상류가 어댑터를 추가할 때 반드시 건드리는 자리이고, 그건 우리가 삭제로 비워낼 자리다. 다만 그런 커밋은 애초에 포팅할 이유가 없다. `package.json` 충돌은 독립 버전 라인에서 **삭제와 무관하게** 발생하므로 삭제 비용으로 계상하지 않는다.

---

## 3. 결정

| # | 결정 |
|---|---|
| D1 | 첫 문서는 **기반**만 |
| D2 | **전면 삭제** (213파일 = 단계 1에서 9 + 단계 3에서 204) |
| D3 | **하드 포크.** 상류를 `main`에 merge하지 않는다. **선택적 포팅**만 |
| D4 | 태그 198개 전부 제거 후 **`v1.0.0`부터 독립 태그 라인** |
| D5 | **`plugin.json` version = `1.0.0`.** 필요한 스크립트는 전부 수정 |
| **D11** | **Claude 마켓플레이스 이름을 `context-mode-js`로 분리한다.** 캐시 부모가 `cache/context-mode-js/context-mode/`로 새로 생기므로 F34(forward-heal)의 스캔 범위가 상류 트리와 완전히 갈라지고, `v1.0.0`이 그 안의 유일·최고 semver가 된다. **캐시 수동 삭제도 Claude 완전 종료도 불필요해진다.** Codex 카탈로그(`.agents/plugins/marketplace.json`)의 이름은 유지한다(F36) |
| D6 | 기반에 **CI 정리** 포함 |
| D7 | 기반에 **로컬 훅 2개 흡수** 포함 (보안 하드닝 포함) |
| D8 | 첫 이슈 착수는 기반에 **미포함** |
| D9 | **상류 무해화.** fork의 어떤 자동화도 상류 인프라·이슈트래커를 건드리지 않는다 |
| D10 | **전달 경로는 `autoUpdate` 유지 + 코드 하드닝.** `source.ref` 핀과 자동갱신 해제는 채택하지 않는다 |

**소멸한 과제:** D3에 의해 "PR #937 병합 시 중복 커밋 정리"는 불필요. `730ca47`은 그냥 fork의 코드다.

---

## 4. 헌장

`wotjr1649/context-mode`는 `mksglu/context-mode`의 **하드 포크**다.

**편입 기준:** *Windows 또는 Linux에서 Codex 또는 Claude Code로 context-mode를 쓸 때 내가 실제로 겪은 결함이나 결핍만 fork 코드가 된다.*

1. 상류 수정은 자동 반영되지 않는다. diff를 읽고, 적용 가치를 판단하고, fork 브랜치에서 개발해 넣는다.
2. `upstream/main`은 읽기 전용 참조다. **`main`에 merge하지 않는다.**
3. 상류로 보낼 PR은 `git checkout -b <fix> upstream/main`으로 상류 계보에서 딴다. 상시 미러 브랜치는 불필요하다.
4. **(D9) fork는 상류에 흔적을 남기지 않는다.** 자동화가 상류 CDN·API·이슈트래커를 호출하지 않는다. 의도적 기여(PR)만 예외.

**정직성 조항:** 삭제 비용은 사라진 게 아니라 이동했다(§2.3). "매 릴리스마다"에서 "포팅하는 변경 한정"으로 줄었을 뿐 0이 아니다. 충돌은 열거 테이블에 구조적으로 집중된다.

---

## 5. 설치 경로 분리와 커토버

`plugin.json`의 `version`이 재설치 키다(F5). 그러나 `v1.0.0`의 진짜 위험은 버전 게이트가 아니라 **F34의 forward-heal**이었다 — `start.mjs:164`가 매 MCP 부팅마다 `cacheParent`의 최고 semver 디렉토리로 `installed_plugins.json`을 다시 쓴다. `1.0.0 < 1.0.169`이므로 옛 dir이 하나라도 남으면 상류 코드로 조용히 되돌아간다. `installPath`가 멀쩡해도 발동한다.

**D11이 이 문제를 뿌리에서 없앤다.** 캐시 경로는 `cache/<마켓플레이스명>/<플러그인명>/<버전>/`이고 `cacheParent`는 `<플러그인명>` 디렉토리다(F35). Claude 마켓플레이스 이름을 `context-mode-js`로 바꾸면 캐시 부모가 `cache/context-mode-js/context-mode/`라는 **빈 디렉토리**로 새로 생기고, `1.0.0`이 그 안의 유일한 버전이 된다.

방어는 **삼중**이다(F45): ① 새 부모에 dir이 하나뿐이라 `dirs.length > 1`이 거짓 ② 캐시 부모가 분리됨 ③ forward-heal·reverse-heal이 `key !== "context-mode@context-mode"`로 게이트되므로 새 키는 애초에 제외된다.

> **⚠ D11의 유일한 미검증 고리(F46).** 캐시의 2단 중첩(`<마켓플레이스>/<플러그인>/<버전>`)은 **1차 문서에 규정돼 있지 않다.** 로컬 7/7 마켓플레이스와 `start.mjs:141`의 정규식으로만 확인된 미문서 내부 구현이다. Claude Code가 캐시 레이아웃을 바꾸면 격리가 무너진다. 확률은 낮으나 이 설계는 그 가정 위에 서 있다. 나머지 고리(마켓플레이스명의 출처, `enabledPlugins` 포맷, `false` 보존)는 전부 1차 출처로 확인됐다(F47).

| 이전 설계의 문제 | D11 적용 후 |
|---|---|
| 캐시 디렉토리 6개 수동 삭제 | **불필요** — 옛 트리를 건드리지 않는다 |
| Claude 완전 종료(`.in_use` 잠금 해제) | **불필요** — 지울 게 없다 |
| uninstall~재설치 사이의 무방비 창 | **소멸** — 창 자체가 없다 |
| 롤백이 옛 트리를 재생성해 함정을 되살림 | **소멸** — 옛 플러그인이 그대로 있어 되돌리기가 재설치 한 번 |
| `v1.0.0` 사용 | **안전** |

**대가(F42~F45).** 저장소가 `pluginKey: "context-mode@context-mode"` 리터럴을 하드코딩한다. 개명 후 각 호출부가 실제로 하는 일을 전수 추적했다:

| 호출부 | 개명 후 결과 | 위험 |
|---|---|---|
| `postinstall.mjs` 6곳 | **`if (isGlobalInstall())` 게이트 → `/plugin install`에선 통째로 스킵**(F44) | **없음** |
| `start.mjs` forward/reverse heal | `key !== 옛 키` → `continue`(F45) | 없음 |
| `start.mjs:249 healInstalledPlugins(옛 키)` | `entries.length === 0` → `skipped: "no-entry"`. **항목을 생성하지 않는다** | 없음 (단, 새 키의 HEAL 3/4가 안 돈다 = **자가치유 상실**) |
| `start.mjs:253 healSettingsEnabledPlugins(옛 키)` | `current !== true` → `settings.json`에 옛 키를 `true`로 재기입 | **유일한 유해 쓰기** |
| `start.mjs:263 healPluginJsonMcpServers` | `ip.plugins[옛 키]`만 순회한다 → uninstall 후 `[]` → **호출조차 되지 않는다** | 없음 (새 트리 미보호) |
| `start.mjs:287 sweepStaleMcpJson(옛 키)` | 옛 트리의 `<ver>/.mcp.json`만 `unlink`하는데 6개 dir 전부 그 파일이 없다 → **완전 no-op** | 없음 |

**즉 유해한 쓰기를 하는 곳은 여섯 개가 아니라 하나다.** "리터럴이 N개이므로 위험이 N배"라는 추론은 틀렸다 — 각 호출부의 가드를 읽어야 한다.

**단계 2의 대응 (코드 수정 불필요):** `healSettingsEnabledPlugins`는 `current === false`를 `explicit-opt-out`으로 존중한다(F43). 커토버에서 `~/.claude/settings.json`의 `enabledPlugins`에 **`"context-mode@context-mode": false`를 명시**하면 그 하나가 봉쇄된다. 삭제하거나 비워두면 다시 `true`가 된다. Claude는 이 `false`를 덮어쓰지 않는다(F47⑤).

**단계 2로 앞당긴 대응 (최종 브랜치 리뷰의 지적).** `start.mjs`의 네 지점을 `__dirname` 파생으로 고친다(F53). 게이트 밖 symlink 폴백이 없으므로, 그대로 두면 fork는 Claude Code 자동 업데이트가 만든 레지스트리 어긋남(#46915)을 **스스로 복구할 수단이 전혀 없다.** `start.mjs`는 번들 대상이 아니라 수정 비용이 4줄이고, 이번 단계에서 `deps-heal`·`lock-heal`에 이미 적용·검증한 패턴 그대로다.

부수 효과: `healSettingsEnabledPlugins`가 우리 키를 대상으로 삼게 되어 **커토버의 `enabledPlugins[옛 키] = false` 완화책이 필수에서 벨트로 내려간다.**

**단계 3에 남는 대응:** `postinstall.mjs`(6) · `src/cli.ts`(5) · `src/server.ts`(1)의 `pluginKey` 리터럴, `start.mjs`의 `healScript` 템플릿(`:338`), 캐시 경로 리터럴(`src/cli.ts:1642`, `src/util/sibling-mcp.ts:68`), 그리고 **`hooks/cache-heal-utils.mjs:291`의 정규식(F52)**. 상류 결함이기도 하다 — 하드코딩된 키는 `context-mode` 이외의 마켓플레이스명을 전부 깨뜨린다.

Codex 어댑터의 같은 리터럴은 Codex 카탈로그 이름을 유지하므로 영향받지 않는다(F36).

### 5.1 버전 변경 절차 (`npm version` 금지)

`npm version 1.0.0`은 `v1.0.0` 태그를 자동 생성하는데 그게 이미 존재한다(F19) → 커밋만 남기고 실패. 대신:

```
package.json 의 "version" 을 손으로 1.0.0 으로 수정
npm run version-sync          # F21: package.json 을 읽어 매니페스트에 복사만 함
git commit                     # 태그 없음
```

태그는 §6 단계 5에서 따로 단다. 이로써 태그 삭제 순서와 버전 변경이 완전히 분리된다.

### 5.2 커토버 의식

캐시를 지우지 않으므로 `.in_use` 잠금(F15)이 무관해지고 **강제 종료 대신 평범한 세션 재시작**이면 된다. 다만 에이전트가 자기 세션 안에서 수행할 수는 없다 — 재시작이 곧 그 대화의 끝이다. 사용자가 수행한다.

1. fork에 마켓플레이스 개명 + 버전 변경을 push
2. `/plugin uninstall context-mode@context-mode` — 옛 설치만 제거. 캐시 디렉토리는 남는다
3. `/plugin marketplace remove context-mode`
4. `/plugin marketplace add wotjr1649/context-mode` — 카탈로그가 스스로를 `context-mode-js`라 선언한다(F36)
5. `/plugin install context-mode@context-mode-js`
6. Claude Code 재시작 (일반 재시작)
7. Codex: `codex plugin marketplace upgrade context-mode` — SHA 기준(F8), 이름 그대로

8. **`~/.claude/settings.json`의 `enabledPlugins`에 `"context-mode@context-mode": false`를 명시한다.** 지우거나 비워두면 안 된다 — `postinstall.mjs`와 `start.mjs`가 리터럴 옛 키를 넘기고, `healSettingsEnabledPlugins`는 `false`만 존중한다(F43). 새 키 `"context-mode@context-mode-js": true`도 함께 확인한다.

`extraKnownMarketplaces`의 키는 `context-mode-js`가 된다.

### 5.3 성공 판정

> **이 판정은 I1을 증명하지 않는다.** 새 마켓플레이스 아래의 설치는 버전 게이트를 타지 않는 **신규 설치**다. 단계 2가 증명하는 것은 "fork 코드가 격리된 트리에서 실제로 실행된다"이며 그 이상이 아니다. I1(버전 문자열이 재설치 키다)은 단계 6에서 `1.0.0 → 1.0.1` 상향이 실제로 재설치를 일으키는지로 따로 검증한다.

1. `installed_plugins.json`에 `context-mode@context-mode-js` 항목이 있고 `version == "1.0.0"`
2. 그 항목의 `installPath`를 **realpath로 해석**한 경로가 `…/cache/context-mode-js/context-mode/1.0.0`
3. 그 디렉토리의 `hooks/run-hook.mjs`에 명시적 `process.exit(0)`, `hooks/codex/pretooluse.mjs`에 `flushAndExit`
4. **런타임:** 실행 중인 MCP 서버 프로세스의 CommandLine이 `context-mode-js\context-mode\1.0.0`을 포함하고, 옛 트리(`cache\context-mode\context-mode\`)를 가리키는 프로세스가 **0개**
5. **훅 발동:** PreToolUse 라우팅이 실제로 동작한다 — 리다이렉트되는 도구를 한 번 호출해 관측
6. `installed_plugins.json`의 옛 항목 `context-mode@context-mode`가 사라졌고 `settings.json`의 `enabledPlugins`에도 남아 있지 않다

`3`은 **파일 존재이지 실행 증명이 아니다.** 그 한계를 §10에 명시한다.

---

## 6. 단계 구성

| 단계 | 내용 | 게이트 |
|---|---|---|
| 0 | `git remote add upstream …` **+ `git fetch upstream --no-tags`**. merge 금지 규칙을 `CLAUDE.md`에 기록 | `upstream/main` 존재 |
| 1 | **CI 무해화 + 봇 정지 + 상류 접점 제거** (§7). 파일 9개 삭제 | 워크플로·`.github/`·`package.json`에서 상류 호출 grep 0건, 자동 커밋 봇 0건 |
| **2** | **마켓플레이스 개명(`context-mode-js`) + 버전 `1.0.0` → 커토버 — 정지 게이트** | §5.3의 판정 6개. **사용자 보고 후에만 다음으로 진행** |
| 3 | **삭제** — 204파일 삭제 + 코드/스크립트 편집 + `pluginKey` 파생 수정(F42) + `web/` 상류 fetch 제거(F40) + 번들 재생성 (§8) | `tsc --noEmit` · `vitest run` · 잔재 grep 0건 · 런타임 하드페일 동작 |
| 4 | **로컬 훅 2개 흡수 + 보안 하드닝** (§9) | §10 |
| 5 | **태그 198개 삭제 → `git tag v1.0.0 <단계2 커밋>`** (F20에 의해 가역) | `git ls-remote --tags`가 `v1.0.0` 하나 |
| 6 | `1.0.1`로 상향 + 태그 `v1.0.1` + push → **경량** 커토버 | `/plugin marketplace update` + `/plugin update`만으로 재설치가 일어나는지 확인 = **I1의 실제 검증**. Codex·Claude 실세션 각 1회 |

**단계 5의 태그 복원 경로:** `--no-tags`로 upstream 태그를 로컬에 섞지 않으므로, 복원은 삭제 직전 `git for-each-ref refs/tags > tags.snapshot`을 떠두고 개별 복원한다. `git push origin --tags`는 금지 — 상류 태그를 다시 밀어 넣는다.

### 6.1 순서의 근거

- **단계 1이 맨 앞인 이유:** `bundle.yml`이 `package.json` push에 반응한다(F22). 단계 2가 바로 그 파일을 고친다. 봇을 먼저 재우지 않으면 단계 2의 push가 `main`에 봇 커밋을 낳고, D3의 "동결된 main"과 단계 3의 원자성이 함께 무너진다. `.github/**` 수정은 `bundle.yml`의 트리거 경로가 아니므로 단계 1의 push 자체는 안전하다. `update-stats.yml`의 6시간 cron도 작업 중 발화해 push를 거부시킨다(F23).
- **단계 2가 삭제보다 앞인 이유:** 계획 전체가 "fork 코드가 실제로 실행된다"는 미검증 가정 위에 있다. fork는 **이미** 상류와 `flushAndExit`로 다르므로(F2), 삭제 전에 마켓플레이스 개명 + 버전 변경만으로 의식을 돌리면 그 가정이 최소 diff로 검증된다. 또한 이 시점엔 `version-sync.mjs`가 원본이라 TARGETS 10개(F39)가 전부 존재한다(F21의 fail-loud를 피한다).
- **단계 2는 "공짜"가 아니다.** 저장소 diff는 작지만 `~/.claude`의 설치 상태(레지스트리·`settings.json`·마켓플레이스 등록)를 바꾼다. 다만 D11 덕분에 **되돌리기가 싸다** — 옛 캐시 트리와 옛 마켓플레이스 클론이 그대로 있으므로 `/plugin marketplace add mksglu/context-mode` + `/plugin install context-mode@context-mode` 한 번으로 복귀한다.
- **단계 5(태그)가 뒤인 이유:** 삭제·검증이 끝난 뒤여야 한다. 최대 리스크 구간 앞에서 파괴적 작업을 하지 않는다.
- **`v1.0.0` 태그가 단계 2의 커밋을 가리키는 이유:** 단계 2가 설치·검증한 트리가 바로 그 커밋이다. 단계 5 시점의 HEAD(삭제 후)에 달면 "설치됐던 1.0.0"과 다른 커밋을 가리키게 된다.

### 6.2 단계 2는 phase 경계가 아니라 **정지 게이트**다

커토버는 **한 번도 수행된 적이 없고** 세션 밖 사람의 손을 요구한다. 그 아래 모든 것(204파일 삭제, 훅 흡수)이 "커토버가 이론대로 동작한다"에 얹혀 있다. 특히 **패치된 `run-hook`을 거치는 Claude 어댑터 훅 5개는 아직 한 번도 실행된 적이 없다.**

따라서 구현 계획은 **단계 2에서 반드시 멈춘다.** 사용자가 §5.2 의식을 수행하고 §5.3의 판정 6개를 보고할 때까지 단계 3 이후를 계획하지도 실행하지도 않는다.

**단계 1+2만으로 실질 가치의 대부분이 배달된다** — fork 코드가 마침내 실행되고 Windows 고아 누수 수정이 라이브가 된다. 삭제는 그에 비하면 실질 위험을 안은 정돈 작업이다.

### 6.3 삭제는 단계 6까지 Claude에 도달하지 않는다

`version`이 단계 3~5 내내 `1.0.0`으로 고정이므로, F5에 의해 Claude는 **단계 2에서 설치한 그 트리(삭제 이전 코드)를 계속 실행한다.** 단계 3의 게이트는 전부 로컬이다(`tsc`/`vitest`/grep). 삭제와 훅 흡수는 단계 6의 `1.0.1` 상향에서 **함께** 배포된다. 의도된 설계다 — 실행자가 "단계 3 뒤엔 삭제가 라이브"라고 착각하지 않도록 명시한다.

---

## 7. CI 무해화 (단계 1) — 9파일 삭제

**삭제 (9):**

- `.github/workflows/update-stats.yml` — 6시간 cron으로 상류 CDN을 퍼지하고(F23) `main`에 자동 커밋한다. D9 위반이자 push 경합의 원인
- `.github/workflows/openclaw-e2e.yml`, `.github/workflows/tier2-e2e-smoke.yml` — 삭제될 코드를 테스트
- `scripts/tier2-smoke/{assert-stats.mjs,fixtures/search-corpus.txt,run-pi-smoke.sh}`
- `stats.json` — 상류 통계 스냅샷. 봇이 사라지면 동결된다
- `tests/tier2-smoke-assert.test.ts` — `assert-stats.mjs`를 spawn하고 `stats.json`을 읽는다(F31). 위 둘을 지우면 반드시 함께 간다
- `.github/FUNDING.yml` — `github: [mksglu]`. fork의 스폰서 버튼이 상류로 간다(F40)

**수동 전환:** `bundle.yml` → `on: workflow_dispatch` 전용. `contents: write` 자동 커밋을 끈다. 번들은 단계 3에서 직접 재생성해 커밋한다.

**유지:** `ci.yml` (외부 호출 0건).

**상류 링크 제거 (D9):**

- `.github/ISSUE_TEMPLATE/bug_report.yml:19,35`, `.github/ISSUE_TEMPLATE/config.yml:4` — 상류 이슈·CONTRIBUTING으로 유도
- `CONTRIBUTING.md:98` — 상류 clone 명령
- `README.md:17` 뱃지 4개 — 상류 `stats.json`(jsDelivr)·stars·forks·last-commit 조회
- **`README.md:5-11`의 ELv2 "modified fork" 고지와 상류 링크는 유지한다 — 라이선스 의무다.**

**추가 상류 접점 제거 (F40 — 1판의 D9 게이트가 놓쳤다):**

- `package.json:27 repository.url` · `:29 homepage` · `:50 bugs` — 전부 상류를 가리킨다. `bugs`는 이슈트래커 유도라 §4의 헌장과 정면 충돌한다. fork로 교체한다
- `web/{index,insight,context-saving}.html`, `web/og/render-og.mjs` — 상류 `stats.json`을 `raw.githubusercontent.com`/jsDelivr에서 fetch한다. **자동화는 아니지만 D9의 취지에 어긋난다.** 배포되지 않는 파일이므로 단계 3에서 처리한다

`author` 필드와 `LICENSE`, README의 저작권·수정 고지는 **유지한다** — ELv2 의무다.

**사고 방지:** `package.json`에 `"private": true` 추가 → `npm publish` 원천 차단. (ELv2의 명시적 제한은 관리형 서비스 제공·라이선스 키 우회·고지 제거 셋이며 "이름 재배포 금지"는 그 문언에 없다. 이 조치는 라이선스 요구가 아니라 **사고 방지**로서 타당하다.)

---

## 8. 삭제 실행 (단계 3) — 204파일

### 8.1 삭제 집합

| 그룹 | 개수 |
|---|---:|
| `src/adapters/<15 dirs>/` | 46 |
| `src/adapters/copilot-base.ts` | 1 |
| `hooks/<9 dirs>/` | 44 |
| `hooks/formatters/` 4개 전부 (F27 — 죽은 코드) | 4 |
| `configs/` (claude-code·codex 제외) | 40 |
| `tests/adapters/` (17개 유지분 제외) | 31 |
| `tests/` 나머지 중 파일명이 비지원 클라이언트인 것 (F28) | 21 |
| `tests/hooks/formatters.test.ts` (F27의 4개만 테스트) | 1 |
| `.cursor-plugin/` `.openclaw-plugin/` `.pi/` | 9 |
| openclaw 전용 루트·스크립트 | 4 |
| `docs/adapters/{kimi-code,openclaw}.md`, `docs/jetbrains-copilot.md` | 3 |
| **합계** | **204** |

**유지:** `.claude-plugin/`(2) · `.codex-plugin/`(3) · `configs/{claude-code,codex}`(4) · `hooks/` 루트 Claude 훅 · `hooks/core/` · `hooks/codex/`

**`tests/adapters/` 유지 17개** — 다수가 *우리가 유지·대폭 편집할 코드의 테스트*다:

- 편집: `detect.test.ts` · `client-map.test.ts` · `detect-ambiguity-matrix.test.ts` · `detect-config-dir.test.ts` · `base-adapter-memory.test.ts` · `memory-conventions.test.ts` · `hook-path-parity.test.ts` · `hook-runtime-per-adapter.test.ts`
- 유지: `claude-code.test.ts` · `claude-code-memory.test.ts` · `codex.test.ts` · `codex-usage.test.ts` · `codex-external-mcp-routing.test.ts` · `detect-claude-code-in-vscode.test.ts`
- 인프라(어댑터 테스트가 아님): `zod3tov4.test.ts` · `zod3tov4-e2e.test.ts` · `zod3tov4-production.test.ts`

**편집 대상 테스트 ~31개** — 파일명은 무관하나 내용이 비지원 클라이언트를 참조: `tests/core/{cli,server,search,deny-policy,auto-memory-adapter,cache-plugin-root}.test.ts` · `tests/formatters.test.ts` · `tests/hooks/{core-routing,integration,tool-naming}.test.ts` · `tests/scripts/{version-sync,asymmetric-drift-assert}.test.ts` · `tests/{lifecycle,runtime,security,hook-runtime-resolution}.test.ts` · `tests/util/project-dir-matrix.test.ts` 등. 일부는 오탐이다(`tests/fixtures/playwright-snapshot.txt`). 실행 시 확인한다.

**`hooks/core/formatters.mjs`의 레지스트리 키 9개** 중 `claude-code`·`codex`만 남기고 7개(`gemini-cli`, `vscode-copilot`, `copilot-cli`, `jetbrains-copilot`, `kimi`, `antigravity-cli`, `cursor`)를 제거한다.

### 8.2 절차 — 컴파일러는 필요조건일 뿐 충분조건이 아니다

"`PlatformId`를 좁히면 `tsc`가 전부 열거한다"는 **거짓**이다(F26). Codex와 코드리뷰어가 독립적으로 같은 구멍을 지목했고 실물 확인됐다. **네 겹의 그물**을 쓴다.

1. `src/adapters/types.ts:474`의 `PlatformId`를 `"claude-code" | "codex" | "unknown"`으로 좁힌다.
2. **그물 1 — `tsc`.** `npm run typecheck`. 잡히는 것: `getAdapter` switch(TS2678), `validPlatforms: PlatformId[]`, `client-map`의 Record 값, 동적 import 지정자.
3. `git rm` 204개.
4. `tsc`가 가리킨 곳 수정: `detect.ts`(`getAdapter` switch, `PLATFORM_ENV_VARS`), `client-map.ts`, `cli.ts`, `server.ts`, `session/analytics.ts`, `session/extract.ts`.
5. **그물 2 — 문자열 grep.** 삭제되는 **16개** 플랫폼 식별자를 저장소 전체에서 검색해 잔재 0건 확인. `PlatformId` 19개 중 3개(`claude-code`, `codex`, `unknown`)만 남으므로 16개다 — **`kilo`를 빠뜨리기 쉽다.** `src/adapters/kilo/` 디렉토리는 없지만 `PlatformId`와 `configs/kilo`에는 존재하고 `getAdapter`의 `case "kilo":`가 `opencode`로 폴백한다. `tsc`가 놓치는 자리: `getSessionDirSegments(platform: string)`(`detect.ts:337`, 삭제 case 14개), `platformOverride as PlatformId`(`detect.ts:395`), `HOOK_MAP`·`hookDispatch(platform: string)`(`cli.ts:77,158`), `analytics.ts:628`·`:1761`의 두 라벨표, `extract.ts`.
   - **주의:** `kimi-k2`는 모델 이름이고 `executor.ts`/`lifecycle.ts`/`db.ts`의 매칭은 주석이다. 편집 대상이 아니다.
   - `assert-bundle`은 이 잔재를 못 막는다(F16). 번들에 `qwen`·`kimi` 문자열이 남아도 통과한다.
6. **그물 3 — `.mjs` 수동 검토.** `hooks/core/{tool-naming,formatters,platform-detect,routing}.mjs`, `hooks/session-helpers.mjs`(`ANTIGRAVITY_CLI_OPTS`). `tsc` 밖이다.
7. **그물 4 — 런타임 하드페일.** 미지원 `clientInfo.name`이 들어오면 조용히 `claude-code`로 폴백하지 말고 명시적으로 실패시킨다. 축소된 타입은 오라우팅을 막지 못한다.
8. **죽은 코드 제거:** `foreignWorkspaceEnv`/`foreignIdentificationEnv`(F24). 소비 테스트(`tests/util/project-dir-matrix.test.ts`, `tests/adapters/detect.test.ts`)도 함께 정리.
9. **스크립트·매니페스트 수정(D5):** `scripts/version-sync.mjs`의 `TARGETS` **10개(F39)** 중 삭제된 7개 경로 제거(남는 것은 `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`) · `package.json`의 `version` 스크립트 `git add` 목록 동기화 · **`files` 필드에서 `.openclaw-plugin`·`openclaw.plugin.json` 제거(F32)** · `postinstall.mjs`의 OpenClaw 감지 블록 제거 · `install:openclaw` 스크립트 제거 · `scripts/ctx-debug.sh` 정리.
9b. **`pluginKey` 파생 수정 잔여분(F42·F43·F52, D11의 이월분).** `start.mjs`의 네 지점은 **단계 2에서 이미 고쳤다**(F53). 여기서 남은 것:
   - `scripts/postinstall.mjs`(6곳) · `src/cli.ts`(5곳) · `src/server.ts`(1곳)의 `"context-mode@context-mode"` 리터럴 → `__dirname` 파생
   - `start.mjs:338`의 `healScript` 템플릿(배포되는 `cache-heal.mjs`의 원본)
   - 캐시 경로 리터럴: `src/cli.ts:1642`, `src/util/sibling-mcp.ts:68`
   - **`hooks/cache-heal-utils.mjs:291`의 `versionSegmentRe` 정규식(F52).** 주석이 아니라 매 세션 시작에 도는 코드다. 이걸 놓치면 셸 스냅샷 자가치유가 fork에서 계속 no-op이다
   
   **이건 상류 결함이다** — 하드코딩된 키는 `context-mode` 이외의 마켓플레이스명을 전부 깨뜨린다. §12의 이슈 후보. `src/adapters/codex/index.ts`의 같은 리터럴은 Codex 카탈로그명을 유지하므로 손대지 않는다.
9c. **`web/` 상류 fetch 제거(F40):** `web/{index,insight,context-saving}.html`, `web/og/render-og.mjs`.
10. **번들 재생성:** `npm run build`. `session-attribution.bundle.mjs`는 어느 목록에도 없다(F25). 런타임 로드되는 살아 있는 코드이므로 `bundle`·`assert-bundle` 목록에 **편입**하거나 미사용임을 확인 후 제거한다.
11. `docs/platform-support.md`(17플랫폼 나열) 갱신.

### 8.3 커밋 전략

"한 커밋" 제약은 `assert-bundle`이 스테일 번들을 잡는다는 **틀린 전제**(F16) 위에 있었다. 실제로는 CI가 잡지 않는다. 그러나 결론은 남는다 — 더 나쁜 이유로. **커밋된 `*.bundle.mjs`가 설치본에서 실제로 실행되는 코드**이므로, 스테일 번들은 CI 빨간불이 아니라 **런타임에 옛 코드가 조용히 도는 것**이다.

따라서: **작업 브랜치에서 점진 커밋(TDD/`tsc` 반복) → `main`에 squash로 1커밋.** 최종 커밋에만 번들 재생성을 포함한다. `merge=ours`로 번들을 덮는 것은 금지.

**번들 신선도 가드 (단계 3에서 추가).** `bundle.yml`을 수동 전환하면 자동 재빌드라는 안전망이 사라진다. `assert-bundle`은 스테일을 못 잡고(F16) 마켓플레이스는 `autoUpdate: true`다 → **옛 번들이 CI 초록인 채 조용히 배포되는 경로**가 열린다. 대체 가드를 `ci.yml`에 넣는다:

```yaml
- name: Assert bundles are fresh
  run: npm run bundle && git diff --exit-code -- server.bundle.mjs cli.bundle.mjs hooks/*.bundle.mjs
```

**전제:** esbuild 출력이 결정적이어야 한다. 현재 `package.json`은 `"esbuild": "^0.27.3"`이고 락파일은 `bun.lock`뿐이며 `ci.yml`은 `npm install`을 쓴다 → 러너마다 esbuild 버전이 달라져 오탐이 난다. **가드를 넣으려면 `esbuild`를 정확 버전으로 핀하거나 `package-lock.json`을 커밋하고 `npm ci`로 바꿔야 한다.** 이 전제를 먼저 처리한다.

---

## 9. 로컬 훅 흡수 + 보안 하드닝

### 9.0 사용자 레벨 힐 훅 5개 — D11이 만든 공백 (**단계 2**에서 처리)

`~/.claude/hooks/`에는 4개가 아니라 **5개**의 힐 훅이 있다(F50). 전부 옛 마켓플레이스에 고정돼 있어 개명 후 **새 트리를 서비스하지 않는다.**

| 훅 | 하드코딩 | 개명 후 |
|---|---|---|
| 훅 | 소유 | 개명 후 |
|---|---|---|
| `deps-heal` | **사용자 작성** (저장소 참조 0) | `activeInstallPath()`가 옛 키를 못 찾아 `cache/context-mode/context-mode`로 폴백 → **옛 트리의 `node_modules`를 치유한다.** 새 트리의 `@mixmark-io/domino` 부분 설치는 무점검 → `ctx_fetch_and_index` 크래시가 복구되지 않는다 ← **기능 상실** |
| `lock-heal` | **사용자 작성** | 캐시 경로 하드코딩(+`CLAUDE_CONFIG_DIR` 무시). 새 트리의 `.in_use` 좀비 PID 락이 청소되지 않아 **#576 재발**(재연결 실패 누적) ← **기능 상실** |
| `cache-heal` | **상류 배포** (`start.mjs:314,378`이 매 부팅 재배포) | `k !== "context-mode@context-mode"`로 새 키 스킵 → junction 위험은 사라지지만 **#46915(자동업데이트 심링크 치유)·#727(stale 경로 정규화) 보호도 함께 잃는다.** **온디스크 수정은 매 부팅 덮어써지므로 fork의 `start.mjs` 템플릿을 고쳐야 한다** |
| `orphan-reaper` | 사용자 작성 | 키를 안 쓴다. 새 경로도 매칭. §9.2의 오탐 문제는 그대로 |
| `prune-versions` | 사용자 작성 (미등록) | 옛 키 항목이 0이면 fail-safe `exit(0)` → **옛 트리를 지우지 않는다. 롤백 전제와 무충돌** |

**단계 2에서 `deps-heal`과 `lock-heal`을 고친다.** 사용자 작성 파일이라 온디스크 수정이 유지된다. 새 이름을 하드코딩하지 말고 **`installed_plugins.json`의 활성 `installPath`에서 캐시 부모를 유도**한다 — 그래야 다음 개명에도 안 깨진다.

**`cache-heal`은 단계 3으로 미룬다.** `start.mjs`의 `healScript` 템플릿을 고쳐야 하고, 그건 저장소 코드다. 그때까지 새 트리는 #46915·#727 보호를 받지 못한다. **위험이 아니라 안전망 상실이며, 고장 나면 드러나게 실패한다.** 수용한다.

### 9.05 흡수 (단계 4)

두 훅은 성격이 달라 **다른 곳에** 들어간다. 그리고 **둘 다 현재 상태로는 흡수할 수 없다.**

### 9.1 `deps-heal` (107줄) → `hooks/ensure-deps.mjs` 확장

**왜 gap인가:** 상류 `ensure-deps`는 `better-sqlite3`(네이티브) 전용, `heal-partial-install.mjs`는 플러그인 자체 파일만 검사. `@mixmark-io/domino` 같은 순수-JS 서브패키지의 부분 설치를 아무도 잡지 않는다. 증상: `ctx_fetch_and_index` 크래시 → WebFetch 리다이렉트 전부 에러. 캐시 6개 버전에서 동일 재발 = 설치 시점 결함.

**왜 `ensure-deps`인가:** 이미 "import 시점 `node_modules` 복구" 책임을 갖고, F12에 의해 훅 프로세스와 MCP 서버 양쪽이 import한다. `domino`가 실제로 require되는 곳이 서버다. 새 훅도, 새 등록도, `settings.json` 변경도 필요 없다.

**필수 하드닝** — 이 코드는 지금 사용자 머신에서 SessionStart마다 돌고 있다:

| # | 결함 | 조치 |
|---|---|---|
| 1 | `execSync(\`${npm} install ${name}@${range} …\`)` — 셸 문자열. Windows `execSync`는 `cmd.exe /c`라 `&`로 명령 분할. `range`는 플러그인 `package.json`에서 무필터 | `name`/`range`를 charset 화이트리스트로 검증. Windows `.cmd` 실행은 CVE-2024-27980 때문에 `execFileSync(shell:false)`만으로 불충분 → **검증이 load-bearing** |
| 2 | `--ignore-scripts` 부재 → 침해/타이포스쿼트 버전의 `postinstall` 자동 실행 | `--ignore-scripts` 추가. 대상이 순수-JS라 부작용 없음 |
| 3 | `rmSync(join(root,"node_modules",...name.split("/")), {recursive,force})` — `name`에 `..`가 있으면 root 이탈 | 삭제 전 해석된 경로가 `root/node_modules` 하위임을 assert |
| 4 | 복구 시 **stderr에 쓴다**(`:88,100,103`). Claude는 훅의 stderr를 실패로 해석 | `orphan-reaper`처럼 로그 파일로 |

**검증 필요:** `ensure-deps.mjs`가 node 내장 모듈만 쓰는지(깨진 `node_modules`에서도 로드돼야 함).

### 9.2 `orphan-reaper` (96줄) → 플러그인 `hooks/`의 SessionStart 훅

치유가 아니라 청소이므로 `ensure-deps`에 얹지 않는다. `hooks/hooks.json`과 `.codex-plugin/hooks.json`의 SessionStart에 등록한다.

**이건 안전망이다.** fork가 `flushAndExit`로 원인을 고쳤으므로 reaper는 그 수정이 놓친 경로를 쓸어 담는 이중화다. 원인 수정이 먼저, reaper가 뒤.

**필수 하드닝:**

- **kill 판정을 좁힌다.** 현재 `/context-mode/i`를 CommandLine **전체**에 부분 일치시킨다. 그런데 fork 작업 디렉토리 경로 자체가 `...\ClaudeCode\context-mode`다. 이 디렉토리에서 돌던 `vitest --watch`나 `npm run dev`는 터미널을 닫으면 부모를 잃고(Windows는 재부모화하지 않음) 60초 뒤 세 조건을 모두 만족한다 → **다음 SessionStart가 그것과 자손을 죽인다.** 단계 3의 vitest도 사정권이다.
  - 채택: **플러그인 캐시 루트 prefix 매칭.** `node.exe`는 Program Files에 있으므로 *실행 파일 경로*가 아니라 **CommandLine의 스크립트 인자**가 캐시 루트 하위인지를 본다. 기준은 버전 디렉토리가 아니라 **캐시 루트**(`…\plugins\cache\context-mode\context-mode\`) — 그래야 버전 상향 후에도 이전 버전이 남긴 고아가 사정권에 든다. junction일 수 있으므로 realpath로 정규화해 비교한다.
  - 기각: 마커 env var(`Win32_Process`가 env를 노출하지 않아 PEB 접근 필요), 실행파일명(동명 오탐), `installPath` 정확 일치(버전 상향 시 이전 고아를 놓침).
  - 자손 sweep도 캐시 루트 재매칭을 통과한 자식만.
- **플랫폼 가드.** `powershell.exe`+`Win32_Process`는 Windows 전용. I3에 의해 Linux에는 이 버그가 없다 → `process.platform !== "win32"`면 즉시 `exit(0)`.
- **실사살은 검증 후.** 먼저 `--dry-run`으로 배포하고 로그로 오탐 0건을 확인한 뒤 활성화한다.
- 확인됨(문제 없음): `execFileSync(powershell, [배열])`은 인젝션 안전 — 같은 코드베이스 `deps-heal`의 `execSync(문자열)`과 대조되는 정답. 자기·조상 보호, `DRY_RUN`, timeout도 정상.

### 9.3 공급망 (D10)

마켓플레이스가 개인 fork를 가리키고 `autoUpdate: true`, `source.ref` 핀 없음(F7). fork가 침해되면 다음 SessionStart에 무상호작용으로 코드가 실행된다. 하드 포크(D3)는 상류 자동 병합만 막을 뿐 `autoUpdate`가 self-deploy를 다시 연다.

**결정(D10): `autoUpdate`를 유지하고 페이로드 쪽만 막는다.** 근거 — fork에 push할 수 있는 주체가 계정 소유자 한 명이므로 현실적 침해 시나리오는 GitHub 계정 탈취이고, 그 경우 공격자는 `ref`가 가리키는 태그도 옮길 수 있어 `source.ref` 고정이 방어가 되지 못한다. 편의성을 잃고 방어를 얻지 못하는 교환이다.

방어는 §9.1의 하드닝 네 가지와 계정 보호(2FA, 브랜치 보호)에 둔다. **§9.1의 하드닝은 D10과 무관하게 필수다.**

**잔존 위험(수용):** 계정이 탈취되면 다음 세션에 코드가 실행된다. `version` 문자열이 바뀔 때만 재설치되므로(F5) 실질 자동반영 창은 좁지만 0은 아니다.

---

## 10. 검증 전략

- **단계 1:** `.github/`·`package.json`·워크플로에서 `mksglu`·`jsdelivr`·`shields.io`·`raw.githubusercontent.com/mksglu` grep 0건 (인용 링크 `#482`, `opencode#20259` 제외). 자동 커밋 봇 0건.
- **단계 2:** §5.3의 판정 6개. 여섯 다 만족해야 성공.
- **단계 6 (I1의 실제 검증):** 코드 변경 없이 `version`만 `1.0.1`로 올려 push → `/plugin marketplace update` + `/plugin update` → `installed_plugins.json`이 `1.0.1`을 가리키는가? 그렇다면 버전 문자열이 재설치 키라는 I1이 경험적으로 확인된다. 그렇지 않다면 앞으로 매 배포마다 재설치 절차를 다시 설계해야 한다.
- **단계 3:** `tsc --noEmit` · `vitest run` · **16개** 플랫폼 식별자 잔재 grep 0건(`kilo` 포함, F51) · 미지원 플랫폼 런타임 하드페일 동작 확인.
  - vitest 메모리 캡: `--pool=forks --maxWorkers=1`, `NODE_OPTIONS=--max-old-space-size=2048`.
  - `hooks/core/*`는 `tsc` 밖이지만 그물은 이미 있다(F29). **새 테스트를 추가하는 게 아니라, 편집 후에도 커버리지가 유지되는지 확인**한다. `platform-detect.mjs`가 1개뿐이므로 여기만 보강을 검토한다.
- **단계 4:**
  - `deps-heal`: `@mixmark-io/domino`의 `package.json`을 의도적으로 제거 → `ctx_fetch_and_index` 호출 → 자동 복구 후 성공. 하드닝 검증: `range`에 `& echo pwned`를 넣은 조작 `package.json`으로 인젝션이 **차단**되는지, `name`에 `../..`를 넣어 `rmSync`가 **거부**되는지.
  - `orphan-reaper`: 저장소 디렉토리에서 `vitest --watch`를 띄우고 부모를 죽인 뒤 `--dry-run`이 **would-reap=0**임을 확인(오탐 없음). 인위적 플러그인 고아 1개에 대해 would-reap=1. Linux에서 즉시 exit 0.
- **단계 6:** Codex와 Claude Code 각각 실제 세션 1회씩, `ctx_execute`·`ctx_search`·`ctx_fetch_and_index` 각 1회 성공.

### 명시적 한계 (과장 금지)

- **단계 2는 I1을 증명하지 않는다.** 새 마켓플레이스 아래의 설치는 버전 게이트를 타지 않는 신규 설치다. 통과해도 "버전 문자열이 재설치 키다"는 참일 수도 거짓일 수도 있다. I1은 단계 6에서 따로 검증한다.
- **§5.3의 판정 3(파일에 `process.exit(0)`가 있다)은 실행 증명이 아니다.** 판정 4·5(프로세스 CommandLine + 훅 발동)가 실행을 관측하지만, `process.exit(0)` **그 줄이 돌았다**는 것은 직접 관측되지 않는다. 고아 0건은 "새지 않았다"이지 "그 줄이 돌았다"가 아니다.
- `nodejs/node#22999`의 stdin 레이스는 **로컬 재현 불가**다(MSYS 파이프 ≠ Windows anonymous pipe, 100회 중 0회). 합성 flush 테스트와 바이트 동일성 비교가 최선이며 그 이상을 주장하지 않는다.
- 패치된 `run-hook`을 거치는 **Claude 어댑터 훅 5개는 아직 실제로 실행된 적이 없다.** 단계 2의 커토버가 그것을 처음 실행시킨다.
- `flushAndExit(payload, code)` 계약: write를 큐잉하고 반환한다. exit은 콜백에서 일어나므로 **경로의 마지막 문장이어야 하고**, write를 타지 않는 경로는 스스로 exit해야 한다.

### 롤백

- 단계 1 실패 → 워크플로 되돌리기. 무해.
- 단계 2 실패 → **옛 트리가 그대로 있으므로 싸다.** 다만 **첫 줄이 `enabledPlugins["context-mode@context-mode"]`를 `true`로 되돌리는 것**이어야 한다 — 커토버에서 넣은 `false`를 그대로 두면 `healSettingsEnabledPlugins`가 `explicit-opt-out`으로 존중해 아무도 되살리지 않는다(F43). 완화책이 만든 함정이다. 그다음 `/plugin uninstall context-mode@context-mode-js` → `/plugin marketplace add mksglu/context-mode` → `/plugin install context-mode@context-mode` → 재시작. **롤백 창은 약 7일이다**(F48 — 고아 캐시 자동 삭제). Codex는 `~/.codex/config.toml`의 source를 `mksglu`로 되돌리고 `codex plugin marketplace upgrade context-mode`. **`~/.claude`의 `37a64ea` revert만으로는 부족하다** — 그 커밋은 `settings.json` 한 줄(마켓플레이스 source)만 바꿨고 Codex 설정은 건드리지 않았다.
- 단계 3 실패 → squash 전이므로 브랜치 폐기. 이때 Claude에는 1.0.0(삭제 전 코드)이 설치돼 있고 동작한다 — 안전한 중간 상태다.
- 단계 5 실패 → 삭제 직전에 뜬 `tags.snapshot`에서 개별 복원. **`git push origin --tags` 금지** — 상류 태그를 다시 밀어 넣는다.
- 훅 흡수 실패 → best-effort 계약 유지. 세션 진행을 막지 않는다.

---

## 11. 하지 말 것

- fork 재생성 / 마켓플레이스 재전환 / PR 재오픈 — 전부 완료됨
- `assert-asymmetric-drift`를 어댑터 패리티 검사로 오해하기 — `.mcp.json.example`과 `plugin.json`의 `args[0]` 일치만 본다(#531)
- `assert-bundle`이 스테일 번들을 잡는다고 가정하기 — 잡지 않는다(F16)
- 번들 충돌을 `merge=ours`로 덮기
- `~/.claude/hooks/context-mode-cache-heal.mjs`를 손으로 수정 — `start.mjs`가 매 부팅 덮어쓴다
- Claude 훅에서 stderr 출력
- `flushAndExit` 호출 뒤에 코드 놓기
- `npm version` 사용 — 태그 충돌(F19)
- **fork를 상류와 같은 캐시 부모(`cache/context-mode/context-mode/`)에 설치하기** — `start.mjs:164`의 forward-heal이 매 부팅 상류로 되돌린다(F34)
- 커토버 후 `enabledPlugins`의 옛 키를 **삭제하기** — `false`로 명시해야 한다. 지우면 `postinstall.mjs`·`start.mjs`가 매번 `true`로 되살린다(F43)
- 커토버 후 옛 마켓플레이스 등록을 남겨두기
- `git push origin --tags` / `git fetch upstream --tags` — 상류 태그 198개를 origin에 재유입시킨다
- 단계 2의 통과를 "I1이 증명됐다"로 읽기 — 신규 설치는 버전 게이트를 타지 않는다

## 12. 범위 밖

- **첫 이슈 착수.** 후보:
  - 상류 열린 이슈: #901 병렬 설치트리 · #936 `ctx_execute` 무한 hang · #894 statusline 하드코딩 · #889 tarball 누락
  - **이번 리뷰에서 새로 발견한 상류 결함 4건:** (a) `hooks/session-attribution.bundle.mjs`가 런타임 로드되면서 `bundle`·`assert-bundle` 어느 목록에도 없어 아무도 재빌드하지 않는다(F25) (b) `hooks/formatters/` 4개가 프로덕션 미참조 죽은 코드이며 `formatDecision`이 `core/formatters.mjs`와 중복 구현돼 있다(F27) (c) `postinstall.mjs`·`start.mjs`·`cli.ts`·`server.ts`가 `pluginKey`를 하드코딩해 **`context-mode` 이외의 마켓플레이스명에서 전부 오작동한다**(F42) (d) `start.mjs:164`의 forward-heal이 semver-max를 무조건 따라가 다운그레이드된 설치를 조용히 되돌린다(F34) — #901과 같은 계열
- 신규 기능
- 상류 기여 PR (PR #937은 그대로 열어둔다 — 의도적 기여이며 D9의 예외)
