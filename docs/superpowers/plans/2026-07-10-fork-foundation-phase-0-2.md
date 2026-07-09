# Fork Foundation — Phase 0–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fork의 CI가 상류를 건드리지 않게 만들고, 봇을 재운 뒤, `plugin.json` 버전을 `1.0.0`으로 내려 **fork 코드가 실제로 Claude Code에서 실행되는지 증명**한다.

**Architecture:** 세 단계다. (0) `upstream` remote를 읽기 전용으로 붙이고 병합 금지 규칙을 문서화한다. (1) `main`에 자동 커밋하는 워크플로 봇을 정지시키고 상류 CDN·이슈트래커 접점을 제거한다 — 이게 먼저여야 다음 단계의 push가 봇을 깨우지 않는다. (2) 버전 문자열만 바꿔 push한 뒤, 사용자가 세션 밖에서 커토버 의식을 수행하고 4중 판정으로 검증한다.

**Tech Stack:** Node 22 · TypeScript(`tsc`) · vitest v4 · esbuild · GitHub Actions · git

**Spec:** `docs/superpowers/specs/2026-07-10-context-mode-fork-foundation-design.md`

## Global Constraints

- 파일 출력은 **UTF-8 (BOM 없음), LF**.
- **`npm version`을 절대 쓰지 않는다.** 태그 `v1.0.0`·`v1.0.1`이 이미 존재하므로(F19) 태그 충돌로 실패한다. `package.json`을 손으로 고치고 `npm run version-sync`를 돌린다.
- **`upstream/main`을 `main`에 merge하지 않는다.** 이 저장소는 하드 포크다.
- **`~/.claude/hooks/context-mode-cache-heal.mjs`를 손으로 고치지 않는다.** `start.mjs`가 매 부팅 덮어쓴다.
- **Claude 훅에서 stderr로 출력하지 않는다.** Claude Code는 훅의 어떤 stderr 출력이든 실패로 해석한다.
- vitest 실행 시 메모리 캡 필수: `--pool=forks --maxWorkers=1`, `NODE_OPTIONS=--max-old-space-size=2048`.
- `README.md`의 "modified fork" 고지(3–13행)와 상류 링크는 **ELv2 라이선스 의무이므로 유지**한다. 제거 대상은 뱃지뿐이다.
- **이 계획은 Task 5에서 멈춘다.** 단계 3(204파일 삭제) 이후는 Task 5의 판정이 통과한 뒤 별도 계획으로 작성한다.
- 기준 브랜치: `spec/fork-foundation` (스펙 커밋 `4e0c896` 위에 쌓는다).

## File Structure

| 파일 | 책임 | 이 계획에서 |
|---|---|---|
| `CLAUDE.md` | 이 저장소에서 일하는 에이전트의 규칙 | 하드 포크 규칙 섹션 추가 |
| `.github/workflows/update-stats.yml` | 6h cron. 상류 CDN purge + `main` 자동 커밋 | **삭제** |
| `.github/workflows/openclaw-e2e.yml` | 삭제 예정 코드의 e2e | **삭제** |
| `.github/workflows/tier2-e2e-smoke.yml` | 삭제 예정 코드의 smoke | **삭제** |
| `scripts/tier2-smoke/assert-stats.mjs` | tier2 게이팅 로직 | **삭제** |
| `scripts/tier2-smoke/fixtures/search-corpus.txt` | tier2 픽스처 | **삭제** |
| `scripts/tier2-smoke/run-pi-smoke.sh` | pi 전용 smoke | **삭제** |
| `stats.json` | 상류 통계 스냅샷 | **삭제** |
| `tests/tier2-smoke-assert.test.ts` | 위 두 파일을 spawn/읽음 | **삭제** |
| `.github/workflows/bundle.yml` | src/package.json push마다 번들 재빌드 후 `main`에 push | `on:`을 `workflow_dispatch` 전용으로 |
| `.github/workflows/ci.yml` | 테스트. 외부 호출 0건 | 변경 없음 |
| `.github/ISSUE_TEMPLATE/config.yml` | 이슈 작성자를 상류로 유도 | URL을 fork로 |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 상류 CONTRIBUTING·이슈 링크 | URL을 fork로, `next` → `main` |
| `CONTRIBUTING.md` | 상류 clone·skills URL | URL을 fork로 |
| `README.md` | 상류 CDN·API 뱃지 | 뱃지 줄 교체 (고지는 유지) |
| `package.json` | 패키지 매니페스트 | `"private": true` 추가, `version` → `1.0.0` |
| `.claude-plugin/plugin.json` 외 10개 매니페스트 | 버전 동기화 대상 | `npm run version-sync`가 자동 갱신 |

---

### Task 1: upstream remote 연결 + 하드 포크 규칙 문서화

**Files:**
- Modify: `CLAUDE.md` (파일 끝에 섹션 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `upstream/main` remote-tracking ref. 이후 모든 상류 diff 열람과 상류행 PR 브랜치가 이걸 베이스로 쓴다.

- [ ] **Step 1: 현재 remote 상태를 확인한다 (RED)**

```bash
cd /c/Users/js/Documents/ClaudeCode/context-mode
git remote -v
```

Expected: `origin`만 보이고 `upstream`은 없다.

- [ ] **Step 2: upstream을 읽기 전용으로 추가하고 태그까지 가져온다**

```bash
git remote add upstream https://github.com/mksglu/context-mode.git
git fetch upstream --tags
```

태그를 함께 가져오는 이유: 단계 5에서 태그 198개를 지운 뒤 복원이 필요할 때 `git push origin --tags`로 되돌릴 수 있어야 한다 (F20).

- [ ] **Step 3: `upstream/main`이 존재하는지 확인한다 (GREEN)**

```bash
git rev-parse --verify upstream/main
git remote -v
```

Expected: 40자 SHA가 출력되고, `remote -v`에 `upstream ... (fetch)` / `(push)` 두 줄이 보인다.

- [ ] **Step 4: `CLAUDE.md` 끝에 하드 포크 규칙을 추가한다**

파일 맨 끝에 다음을 덧붙인다. (기존 파일은 영어이므로 영어로 맞춘다.)

```markdown

## Fork rules — hard fork, do NOT merge upstream

This repository is a hard fork of `mksglu/context-mode`. Supported clients: **Claude Code and Codex only**.

- NEVER `git merge upstream/main` into `main`. Upstream changes are read, judged, and ported selectively on a branch.
- `upstream/main` is a read-only reference. To send a PR upstream: `git checkout -b <fix> upstream/main`.
- No automation in this fork may call upstream infrastructure — no jsDelivr purge of `mksglu/context-mode`, no shields.io badges pointing at it, no links funnelling issues to its tracker.
- NEVER run `npm version`. Tags `v1.0.0` and `v1.0.1` already exist and the command would fail after committing. Edit `package.json` by hand, then run `npm run version-sync`.
- NEVER hand-edit `~/.claude/hooks/context-mode-cache-heal.mjs`. `start.mjs` overwrites it on every boot.
- `assert-bundle` does NOT compare committed bundles against a rebuild — it only scans for the esbuild `__require("node:...")` shim. Stale bundles pass CI and ship broken code. Always run `npm run build` before committing a change under `src/`.
```

- [ ] **Step 5: 규칙이 들어갔는지 확인한다**

```bash
grep -c "do NOT merge upstream" CLAUDE.md
```

Expected: `1`

- [ ] **Step 6: 커밋**

```bash
git add CLAUDE.md
git commit -m "chore: add upstream remote and hard-fork rules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

`upstream` remote는 로컬 설정이라 커밋되지 않는다. 규칙 문서만 커밋된다.

---

### Task 2: 자동 커밋 봇 정지 + 상류 CDN 접점 제거

**Files:**
- Delete: `.github/workflows/update-stats.yml`, `.github/workflows/openclaw-e2e.yml`, `.github/workflows/tier2-e2e-smoke.yml`, `scripts/tier2-smoke/assert-stats.mjs`, `scripts/tier2-smoke/fixtures/search-corpus.txt`, `scripts/tier2-smoke/run-pi-smoke.sh`, `stats.json`, `tests/tier2-smoke-assert.test.ts`
- Modify: `.github/workflows/bundle.yml`

**Interfaces:**
- Consumes: Task 1의 커밋 위에 쌓는다
- Produces: `main`에 push해도 어떤 워크플로도 자동 커밋하지 않는 상태. Task 4가 `package.json`을 push할 수 있게 된다.

**왜 이 순서인가:** `bundle.yml`의 트리거는 `on.push.paths = ['src/**','package.json','tsconfig.json']`이고 권한은 `contents: write`다. Task 4가 `package.json`을 고쳐 push하는 순간 봇이 번들을 재빌드해 `main`에 커밋을 밀어넣는다. `update-stats.yml`은 6시간 cron이라 작업 중 아무 때나 발화해 push를 non-fast-forward로 거부시킨다.

- [ ] **Step 1: 상류 접점이 실제로 존재함을 확인한다 (RED)**

```bash
grep -rlE "mksglu|jsdelivr|purge" .github/workflows/
```

Expected: `.github/workflows/update-stats.yml` 한 줄이 출력된다 (exit 0).

```bash
grep -nE "^on:|push:|paths:|contents: write" .github/workflows/bundle.yml
```

Expected: `push:`, `paths:`, `contents: write`가 모두 보인다.

- [ ] **Step 2: 8개 파일을 삭제한다**

`-r` 플래그를 쓰지 않는다 (경로를 하나씩 나열).

```bash
git rm .github/workflows/update-stats.yml \
       .github/workflows/openclaw-e2e.yml \
       .github/workflows/tier2-e2e-smoke.yml \
       scripts/tier2-smoke/assert-stats.mjs \
       scripts/tier2-smoke/fixtures/search-corpus.txt \
       scripts/tier2-smoke/run-pi-smoke.sh \
       stats.json \
       tests/tier2-smoke-assert.test.ts
```

`tests/tier2-smoke-assert.test.ts`가 함께 가는 이유: `:23`에서 `stats.json`을 읽고 `assert-stats.mjs`를 spawn한다. 남기면 vitest가 깨진다.

- [ ] **Step 3: `bundle.yml`을 수동 실행 전용으로 바꾼다**

`.github/workflows/bundle.yml`의 `on:` 블록을 다음으로 교체한다. 나머지(`permissions`, `jobs`)는 건드리지 않는다 — 수동 실행 시에는 여전히 번들을 커밋할 수 있어야 한다.

교체 전:
```yaml
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'package.json'
      - 'tsconfig.json'
```

교체 후:
```yaml
on:
  workflow_dispatch:
```

- [ ] **Step 4: 봇과 상류 접점이 사라졌는지 확인한다 (GREEN)**

```bash
# 상류 접점 0건이어야 한다 → grep 이 아무것도 못 찾아 exit 1
grep -rlE "mksglu|jsdelivr|purge|shields\.io" .github/workflows/ ; test $? -eq 1 && echo "PASS: 워크플로에 상류 접점 없음"

# 자동 push 트리거 0건이어야 한다
grep -rn "git push" .github/workflows/bundle.yml
grep -A2 "^on:" .github/workflows/bundle.yml
```

Expected:
- 첫 명령: `PASS: 워크플로에 상류 접점 없음`
- `git push`는 `bundle.yml`에 남아 있으나 `on:`이 `workflow_dispatch:` 하나뿐이므로 자동 발화하지 않는다.

```bash
git ls-files .github/workflows/
```

Expected: `ci.yml`, `bundle.yml` 두 줄만.

- [ ] **Step 5: 테스트가 여전히 통과하는지 확인한다**

삭제한 테스트가 사라졌으므로 전체 스위트 대신 인접 스위트만 돌린다.

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/scripts --pool=forks --maxWorkers=1
```

Expected: 모든 테스트 PASS. (`tests/scripts/version-sync.test.ts`, `tests/scripts/asymmetric-drift-assert.test.ts`)

- [ ] **Step 6: 커밋**

```bash
git add -A .github/workflows/bundle.yml
git commit -m "ci: stop auto-commit bots and remove upstream infrastructure calls

update-stats.yml purged mksglu's jsDelivr CDN cache every 6 hours and
auto-committed stats.json to main. bundle.yml pushed rebuilt bundles to
main on every src/ or package.json push, which would collide with the
version bump in the next phase.

- delete update-stats.yml, openclaw-e2e.yml, tier2-e2e-smoke.yml
- delete scripts/tier2-smoke/*, stats.json, tests/tier2-smoke-assert.test.ts
- bundle.yml: workflow_dispatch only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 상류로 유도하는 링크·뱃지 제거 + npm 재배포 차단

**Files:**
- Modify: `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml:19,20,35`, `CONTRIBUTING.md:98,271`, `README.md:17`, `package.json`

**Interfaces:**
- Consumes: Task 2
- Produces: D9(상류 무해화) 충족. `npm publish` 원천 차단.

- [ ] **Step 1: 상류 링크가 존재함을 확인한다 (RED)**

```bash
grep -rn "github.com/mksglu" .github/ISSUE_TEMPLATE/ CONTRIBUTING.md | grep -vE "issues/482" | head
grep -c "cdn.jsdelivr.net" README.md
grep -c '"private"' package.json
```

Expected: 링크 여러 줄, `cdn.jsdelivr.net` ≥ 1, `"private"` = 0.

- [ ] **Step 2: `.github/ISSUE_TEMPLATE/config.yml` 전체를 교체한다**

```yaml
blank_issues_enabled: false
contact_links:
  - name: Open a PR instead
    url: https://github.com/wotjr1649/context-mode/blob/main/CONTRIBUTING.md
    about: PRs with TDD (red-green-refactor) are strongly preferred over issues. See CONTRIBUTING.md.
```

- [ ] **Step 3: `.github/ISSUE_TEMPLATE/bug_report.yml`의 세 줄을 고친다**

19행 — 상류 CONTRIBUTING → fork:
```markdown
        3. **Write a failing test** (RED) and fix it (GREEN) — see [CONTRIBUTING.md](https://github.com/wotjr1649/context-mode/blob/main/CONTRIBUTING.md)
```

20행 — 이 fork에는 `next` 브랜치가 없다:
```markdown
        4. **Open a PR** against `main` branch — CI verifies on Ubuntu, macOS, and Windows
```

35행 — 상류 이슈트래커 → fork:
```markdown
        1. [Search existing issues](https://github.com/wotjr1649/context-mode/issues)
```

- [ ] **Step 4: `CONTRIBUTING.md`의 두 줄을 고친다**

98행:
```bash
git clone https://github.com/wotjr1649/context-mode.git
```

271행:
```bash
npx skills add https://github.com/wotjr1649/context-mode/tree/main/.claude/skills/context-mode-ops
```

`:350`·`:354`의 상류 이슈 `#482` 인용은 **건드리지 않는다.** 출처 표기이지 유도 링크가 아니다.

- [ ] **Step 5: `README.md` 17행의 뱃지 줄을 교체한다**

3–13행의 "modified fork" 고지 블록은 **손대지 않는다** — ELv2 의무다.

17행(users·npm·marketplace·stars·forks·last-commit·License 뱃지가 한 줄에 있음) 전체를 다음 한 줄로 교체한다. 상류 `stats.json`(jsDelivr)과 상류 저장소 API를 참조하는 뱃지 6개가 사라지고, 상류를 참조하지 않는 License 뱃지만 남는다.

```markdown
[![License: ELv2](https://img.shields.io/badge/License-ELv2-blue.svg)](LICENSE)
```

18–19행(Discord, Hacker News)은 상류 인프라가 아니므로 건드리지 않는다.

- [ ] **Step 6: `package.json`에 `"private": true`를 넣는다**

3행 `"version": "1.0.169",` 바로 아래에 삽입한다.

교체 전:
```json
  "name": "context-mode",
  "version": "1.0.169",
```

교체 후:
```json
  "name": "context-mode",
  "version": "1.0.169",
  "private": true,
```

ELv2는 `context-mode` 이름으로의 npm 재배포를 금지한다. `"private": true`는 `npm publish`를 원천 차단하는 안전장치다. `npm install`·`npm run`에는 영향이 없다.

- [ ] **Step 7: 상류 접점이 사라졌는지 확인한다 (GREEN)**

```bash
grep -rn "github.com/mksglu" .github/ CONTRIBUTING.md | grep -vE "issues/482|opencode#20259"
```
Expected: 출력 없음.

```bash
grep -c "cdn.jsdelivr.net" README.md ; test $? -ne 0 || echo "FAIL: jsDelivr 뱃지 잔존"
grep -c "This is a modified fork" README.md
grep -n '"private": true' package.json
```
Expected: jsDelivr 0건, 고지 1건, `"private": true` 1건.

- [ ] **Step 8: 커밋**

```bash
git add .github/ISSUE_TEMPLATE/config.yml .github/ISSUE_TEMPLATE/bug_report.yml CONTRIBUTING.md README.md package.json
git commit -m "chore: point fork docs at the fork, drop upstream badges, block npm publish

D9: no automation or template in this fork funnels traffic to upstream.
The ELv2 'modified fork' notice in README stays — it is a license obligation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 버전을 `1.0.0`으로 내리고 `main`에 반영

**Files:**
- Modify: `package.json:3`
- Modify (자동): `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.openclaw-plugin/openclaw.plugin.json`, `.openclaw-plugin/package.json`, `openclaw.plugin.json`, `.pi/extensions/context-mode/package.json`, `configs/antigravity-cli/plugin.json`, `configs/copilot-cli/.github/plugin/plugin.json` — `npm run version-sync`가 갱신
- Test: `tests/scripts/version-sync.test.ts`

**Interfaces:**
- Consumes: Task 2 (봇이 자고 있어야 push가 안전하다)
- Produces: `origin/main`에 `plugin.json.version == "1.0.0"`인 커밋. Task 5의 커토버가 이걸 설치한다.

**왜 `npm version`이 아닌가:** 태그 `v1.0.0`이 이미 존재한다(F19). `npm version 1.0.0`은 커밋을 만든 뒤 태그 생성에서 실패해 반쯤 진행된 상태를 남긴다. `version-sync.mjs:48-49`는 `package.json`의 버전을 **읽어 복사만** 하므로, 손으로 고친 뒤 스크립트를 돌리면 된다.

- [ ] **Step 1: 매니페스트가 아직 `1.0.169`임을 확인한다 (RED)**

```bash
grep '"version"' package.json .claude-plugin/plugin.json .codex-plugin/plugin.json
```

Expected: 세 줄 모두 `1.0.169`.

- [ ] **Step 2: `package.json`의 버전만 손으로 고친다**

교체 전:
```json
  "version": "1.0.169",
```
교체 후:
```json
  "version": "1.0.0",
```

- [ ] **Step 3: 매니페스트를 동기화한다**

```bash
npm run version-sync
```

이 시점에 `version-sync.mjs`의 `TARGETS` 11개 경로가 **전부 존재한다** (삭제는 아직 안 했다). 삭제를 먼저 했다면 `:66-72`의 fail-loud에 걸린다. 순서가 의미를 갖는 이유다.

- [ ] **Step 4: 동기화 테스트를 돌린다 (GREEN)**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/scripts/version-sync.test.ts --pool=forks --maxWorkers=1
```

Expected: PASS.

```bash
grep -h '"version"' package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json | sort -u
```

Expected: `"version": "1.0.0",` 한 종류만 출력.

- [ ] **Step 5: 커밋**

```bash
git add package.json .claude-plugin/ .cursor-plugin/ .codex-plugin/ .openclaw-plugin/ openclaw.plugin.json .pi/ configs/antigravity-cli/plugin.json configs/copilot-cli/.github/plugin/plugin.json
git commit -m "chore: start independent version line at 1.0.0

Claude Code keys plugin reinstall on the plugin.json version string. The
fork carried upstream's 1.0.169, so the installed tree was never refreshed
and fork code has never run. Changing the string forces a reinstall.

npm version is not used: tag v1.0.0 already exists and would collide.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: `main`에 반영하고 push한다**

> **사용자 확인 필요.** `origin/main`에 push하는 것은 되돌리기 어려운 외부 작업이며, 마켓플레이스가 추적하는 배포 브랜치다. 진행 전에 사용자에게 확인받는다.

```bash
git checkout main
git merge --ff-only spec/fork-foundation
git push origin main
```

`--ff-only`가 실패하면 `main`이 앞서 있다는 뜻이다 — 봇이 살아 있었다는 신호이므로 **멈추고 Task 2를 재검토한다.**

- [ ] **Step 7: 봇이 깨어나지 않았는지 확인한다**

```bash
gh run list --repo wotjr1649/context-mode --limit 5
git fetch origin && git log --oneline -1 origin/main
```

Expected: `bundle.yml` 실행 0건. `origin/main`의 HEAD가 방금 push한 커밋과 동일(봇 커밋이 뒤에 붙지 않음).

---

### Task 5: 커토버 의식 + 4중 판정 — **정지 게이트**

**Files:** 없음 (저장소를 건드리지 않는다)

**Interfaces:**
- Consumes: Task 4가 push한 `origin/main`
- Produces: I1(버전 문자열이 재설치 키다)의 **경험적 증명**. 이 판정이 통과해야 단계 3 이후를 계획한다.

> **에이전트는 이 태스크를 실행할 수 없다.** 캐시 디렉토리 6개가 현재 실행 중인 PID로 `.in_use` 잠겨 있고(F15), 잠금 해제는 Claude Code 완전 종료가 전제다. 세션 안에서 종료하면 이 대화가 끝난다. **아래 1–6은 사용자가 세션 밖에서 수행한다.** 7–8은 재시작된 새 세션에서 에이전트가 수행한다.

- [ ] **Step 1: (사용자) 마켓플레이스 카탈로그를 갱신한다**

Claude Code 세션에서:
```
/plugin marketplace update context-mode
```

이 단계를 빼먹으면 카탈로그가 옛 커밋에 머물러 재설치가 **stale 카탈로그에서** 깔린다. 조용히 실패한다.

- [ ] **Step 2: (사용자) 플러그인을 제거한다**

```
/plugin uninstall context-mode
```

`uninstall`은 `data` 디렉토리를 지우지 캐시를 지우지 않는다. 캐시는 Step 4에서 손으로 지운다.

- [ ] **Step 3: (사용자) Claude Code를 완전히 종료한다**

`.in_use` 잠금이 풀린다.

- [ ] **Step 4: (사용자) 캐시 버전 디렉토리를 *전부* 삭제한다**

`C:\Users\js\.claude\plugins\cache\context-mode\context-mode\` 아래의 `1.0.162`, `1.0.163`, `1.0.165`, `1.0.166`, `1.0.168`, `1.0.169` **여섯 개 모두**를 지운다.

> **일부만 지우면 안 된다.** `cache-heal.mjs:17`은 `installPath`가 없으면 남아 있는 디렉토리 중 **semver가 가장 높은 것**으로 junction을 건다. `1.0.0 < 1.0.169`이므로 하나라도 남기면 상류 코드가 조용히 부활한다. 그 훅은 `uninstall` 후에도 `~/.claude/hooks/`에 남아 매 세션 실행되고 `start.mjs`가 매 부팅 재배포한다.

삭제 후 확인:
```
디렉토리가 비어 있거나 존재하지 않아야 한다.
```

- [ ] **Step 5: (사용자) Claude Code를 재시작한다**

플러그인이 `1.0.0`으로 재설치된다.

- [ ] **Step 6: (사용자) Codex 쪽도 갱신한다**

```bash
codex plugin marketplace upgrade context-mode
```

Codex는 git SHA 기준이라(F8) 이 한 줄로 끝난다.

- [ ] **Step 7: (에이전트, 새 세션) 정적 판정 3개를 돌린다**

`ctx_execute(language: "javascript")`로 실행한다. `installPath`를 **realpath로 해석**하는 것이 핵심이다 — junction이면 하드코딩한 `1.0.0/` 경로와 실제 로드되는 디렉토리가 다를 수 있다.

```javascript
const fs = require('fs'), path = require('path'), os = require('os');
const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const reg = JSON.parse(fs.readFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), 'utf8'));
const entry = reg.plugins['context-mode@context-mode'][0];
const real = fs.realpathSync(entry.installPath);
const runHook = fs.readFileSync(path.join(real, 'hooks', 'run-hook.mjs'), 'utf8');
const codexHook = fs.readFileSync(path.join(real, 'hooks', 'codex', 'pretooluse.mjs'), 'utf8');

const checks = [
  ['1. version === 1.0.0',        entry.version === '1.0.0'],
  ['2. installPath realpath',     /[\\/]1\.0\.0$/.test(real)],
  ['3a. run-hook.mjs 명시적 exit', /process\.exit\(0\)/.test(runHook)],
  ['3b. codex flushAndExit',      codexHook.includes('flushAndExit')],
];
console.log('installPath(real):', real);
for (const [name, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
console.log(checks.every(c => c[1]) ? '\n정적 판정 통과' : '\n정적 판정 실패 — 단계 3으로 진행 금지');
```

Expected: 네 줄 모두 `PASS`.

`2`가 FAIL이면 junction이 걸려 있다는 뜻이다 — Step 4에서 디렉토리를 일부만 지웠는지 확인한다.

- [ ] **Step 8: (에이전트, 새 세션) 런타임 판정을 돌린다**

바이트 존재는 실행을 증명하지 않는다. **실제로 도는 프로세스**가 `1.0.0` 트리를 가리키는지 본다.

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'context-mode' } |
  ForEach-Object {
    $v = if ($_.CommandLine -match '(?i)context-mode\\context-mode\\([\d.]+)') { $Matches[1] } else { '(경로 없음)' }
    [pscustomobject]@{ PID = $_.ProcessId; Version = $v }
  } | Format-Table -AutoSize
```

Expected: 출력되는 모든 행의 `Version`이 `1.0.0`. `1.0.169`가 하나라도 보이면 **실패** — 옛 트리가 아직 실행 중이다.

이어서 훅이 실제로 발동하고 고아를 남기지 않는지 본다. Bash 도구를 5회 연속 호출한 뒤:

```powershell
$root = "$env:USERPROFILE\.claude\plugins\cache\context-mode\context-mode"
$procs = Get-CimInstance Win32_Process
$alive = $procs.ProcessId
$orphans = $procs | Where-Object {
  $_.CommandLine -like "*$root*" -and ($alive -notcontains $_.ParentProcessId)
}
"고아 프로세스: " + $orphans.Count
```

Expected: `고아 프로세스: 0`

이게 fork가 존재하는 이유다 — 상류 코드에서는 훅이 성공 경로에서 `exit`하지 않아 Windows에서 고아가 쌓인다.

- [ ] **Step 9: 정지. 사용자에게 판정 결과를 보고한다**

**이 계획은 여기서 끝난다.** Step 7·8이 모두 통과하면 I1이 경험적으로 증명된 것이고, 그때 비로소 단계 3(204파일 삭제)을 별도 계획으로 작성한다.

**하나라도 실패하면 단계 3으로 넘어가지 않는다.** 롤백:

```bash
# ~/.claude 에서 마켓플레이스 소스를 상류로 되돌린 뒤 재시작
cd /c/Users/js/.claude && git revert --no-edit 37a64ea
```

---

## Self-Review

**1. Spec coverage (단계 0–2 범위)**

| 스펙 요구 | 태스크 |
|---|---|
| §6 단계 0: `git remote add upstream` + `fetch --tags` + merge 금지 규칙 | Task 1 |
| §7 삭제 8파일 | Task 2 Step 2 |
| §7 `bundle.yml` 수동 전환 | Task 2 Step 3 |
| §7 `ci.yml` 유지 | Task 2 Step 4 (검증만) |
| §7 상류 링크 제거 (ISSUE_TEMPLATE, CONTRIBUTING, README 뱃지) | Task 3 Step 2–5 |
| §7 README ELv2 고지 유지 | Task 3 Step 5, Step 7 검증 |
| §7 `"private": true` | Task 3 Step 6 |
| §5.1 `npm version` 금지, 수동 편집 + `version-sync` | Task 4 Step 2–3 |
| §5.2 커토버 의식 6단계 | Task 5 Step 1–6 |
| §5.3 성공 판정 4개 | Task 5 Step 7 (1,2,3) + Step 8 (4) |
| §6.2 단계 2는 정지 게이트 | Task 5 Step 9 |
| §6.1 봇 정지가 버전 push보다 앞 | Task 2 → Task 4 순서, Task 4 Step 6에 `--ff-only` 가드 |
| §10 롤백 | Task 5 Step 9 |

단계 3·4·5·6은 **의도적으로 이 계획 밖**이다 (Global Constraints 참조).

**2. Placeholder scan:** "TBD"·"TODO"·"적절히 처리"·"비슷하게" 없음. 모든 코드 스텝에 실제 내용이 들어 있다. Task 5의 검증 스니펫은 복사해서 바로 실행 가능하다.

**3. Type consistency:** 이 계획은 새 함수를 만들지 않는다. 참조하는 식별자는 전부 기존 파일의 것이다 — `version-sync.mjs`의 `TARGETS`, `cache-heal.mjs`의 junction 로직, `installed_plugins.json`의 `context-mode@context-mode` 키, `entry.installPath`·`entry.version` 필드. 모두 스펙 §2.1에서 실물 확인됐다.

**4. 발견된 불일치 (수정 완료):** 스펙 초안은 단계 1 삭제를 7파일로 적었으나, `stats.json`을 지우면 `tests/tier2-smoke-assert.test.ts`가 깨진다. 스펙을 8파일(총 212)로 고쳤고 이 계획은 8개를 지운다.
