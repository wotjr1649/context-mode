# Fork Foundation — Phase 0–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fork를 상류와 **완전히 분리된 설치 경로**로 옮기고, 상류 인프라를 건드리는 CI를 정지시킨 뒤, **fork 코드가 실제로 Claude Code에서 실행되는지** 검증한다.

**Architecture:** 세 단계다. (0) `upstream` remote를 읽기 전용으로 붙이고 병합 금지 규칙을 문서화한다. (1) `main`에 자동 커밋하는 워크플로 봇을 정지시키고 상류 CDN·이슈트래커·스폰서 접점을 제거한다 — 이게 먼저여야 다음 단계의 push가 봇을 깨우지 않는다. (2) Claude 마켓플레이스 이름을 `context-mode-js`로 바꾸고 버전을 `1.0.0`으로 내려 push한 뒤, 사용자가 커토버를 수행하고 6중 판정으로 검증한다.

**핵심 설계 — 왜 마켓플레이스 개명인가:** 캐시 경로는 `~/.claude/plugins/cache/<마켓플레이스명>/<플러그인명>/<버전>/`이고, `start.mjs:164`의 forward-heal은 **매 MCP 부팅마다** `<플러그인명>` 디렉토리 안의 최고 semver dir로 레지스트리를 다시 쓴다. `1.0.0 < 1.0.169`이므로 같은 캐시 부모를 쓰면 상류 코드로 조용히 되돌아간다. 이름을 바꾸면 캐시 부모가 새로 생겨 이 문제가 **뿌리에서** 사라지고, 캐시 수동 삭제도 Claude 강제 종료도 필요 없어진다.

**Tech Stack:** Node 22 · TypeScript(`tsc`) · vitest v4 · esbuild · GitHub Actions · git

**Spec:** `docs/superpowers/specs/2026-07-10-context-mode-fork-foundation-design.md`

## Global Constraints

- 파일 출력은 **UTF-8 (BOM 없음), LF**.
- **`npm version`을 절대 쓰지 않는다.** 태그 `v1.0.0`·`v1.0.1`이 이미 존재하므로(F19) 태그 충돌로 실패한다. `package.json`을 손으로 고치고 `npm run version-sync`를 돌린다.
- **fork를 상류와 같은 캐시 부모(`cache/context-mode/context-mode/`)에 설치하지 않는다.** `start.mjs:164`의 forward-heal이 매 부팅 상류로 되돌린다(F34).
- **`upstream/main`을 `main`에 merge하지 않는다.**
- **`git fetch upstream --tags` / `git push origin --tags` 금지.** 상류 태그 198개가 origin에 재유입된다.
- **`~/.claude/hooks/context-mode-cache-heal.mjs`를 손으로 고치지 않는다.** `start.mjs`가 매 부팅 덮어쓴다.
- **Claude 훅에서 stderr로 출력하지 않는다.**
- vitest 실행 시 메모리 캡 필수: `--pool=forks --maxWorkers=1`, `NODE_OPTIONS=--max-old-space-size=2048`.
- `README.md`의 "modified fork" 고지(3–13행)와 `LICENSE`, `author` 필드는 **ELv2 의무이므로 유지**한다. 제거 대상은 뱃지와 유도 링크뿐이다.
- **이 계획은 Task 5에서 멈춘다.** 단계 3(204파일 삭제) 이후는 Task 5의 판정이 통과한 뒤 별도 계획으로 작성한다.
- 기준 브랜치: `spec/fork-foundation` (스펙 커밋 `4e0c896`, 계획 커밋 `a168abb` 위에 쌓는다).

## File Structure

| 파일 | 이 계획에서 |
|---|---|
| `CLAUDE.md` | 하드 포크 규칙 섹션 추가 |
| `.github/workflows/{update-stats,openclaw-e2e,tier2-e2e-smoke}.yml` | **삭제** |
| `scripts/tier2-smoke/{assert-stats.mjs,fixtures/search-corpus.txt,run-pi-smoke.sh}` | **삭제** |
| `stats.json`, `tests/tier2-smoke-assert.test.ts` | **삭제** |
| `.github/FUNDING.yml` | **삭제** (`github: [mksglu]`) |
| `.github/workflows/bundle.yml` | `on:`을 `workflow_dispatch` 전용으로 |
| `.github/workflows/ci.yml` | 변경 없음 |
| `.github/ISSUE_TEMPLATE/{config,bug_report}.yml` | 상류 URL → fork |
| `CONTRIBUTING.md:98,271` | 상류 URL → fork |
| `README.md:17` | 상류 뱃지 제거 (고지는 유지) |
| `package.json` | `private:true` · `repository`/`homepage`/`bugs` → fork · `version` → `1.0.0` |
| `.claude-plugin/marketplace.json:2` | 마켓플레이스 `name` → `context-mode-js` |
| 매니페스트 9개 | `npm run version-sync`가 자동 갱신 |

---

### Task 1: upstream remote 연결 + 하드 포크 규칙 문서화

**Files:** Modify `CLAUDE.md`

**Interfaces:**
- Produces: `upstream/main` remote-tracking ref. 이후 모든 상류 diff 열람과 상류행 PR 브랜치의 베이스.

- [ ] **Step 1: 현재 remote 상태 확인 (RED)**

```bash
cd /c/Users/js/Documents/ClaudeCode/context-mode
git remote -v
```
Expected: `origin`만. `upstream` 없음.

- [ ] **Step 2: upstream을 태그 없이 추가한다**

```bash
git remote add upstream https://github.com/mksglu/context-mode.git
git config remote.upstream.tagOpt --no-tags
git fetch upstream
```

`--no-tags`인 이유: 로컬 태그 네임스페이스는 평면이다. 상류 198개를 끌어오면 단계 5에서 태그를 지운 뒤 임의의 `fetch`/`push --tags`가 그것들을 origin에 되돌린다.

- [ ] **Step 3: `upstream/main` 확인 (GREEN)**

```bash
git rev-parse --verify upstream/main
git config --get remote.upstream.tagOpt
```
Expected: 40자 SHA, 그리고 `--no-tags`.

- [ ] **Step 4: `CLAUDE.md` 끝에 하드 포크 규칙을 추가한다**

파일 맨 끝에 덧붙인다 (기존 파일은 영어이므로 영어로 맞춘다).

```markdown

## Fork rules — hard fork, do NOT merge upstream

This repository is a hard fork of `mksglu/context-mode`. Supported clients: **Claude Code and Codex only**.

- NEVER `git merge upstream/main` into `main`. Upstream changes are read, judged, and ported selectively on a branch.
- `upstream/main` is a read-only reference. To send a PR upstream: `git checkout -b <fix> upstream/main`.
- NEVER `git fetch upstream --tags` or `git push origin --tags`. Upstream's 198 tags would flood this fork's tag namespace.
- No automation in this fork may call upstream infrastructure — no jsDelivr purge of `mksglu/context-mode`, no shields.io badges pointing at it, no links funnelling issues or sponsorship to it.
- NEVER run `npm version`. Tags `v1.0.0` and `v1.0.1` already exist and the command would fail after committing. Edit `package.json` by hand, then run `npm run version-sync`.
- The Claude marketplace for this fork is named `context-mode-js`, so its plugin cache lives at `~/.claude/plugins/cache/context-mode-js/context-mode/`. NEVER install this fork under the `context-mode` marketplace name: `start.mjs`'s forward heal rewrites the registry to the highest-semver dir in the cache parent on every boot, and upstream's `1.0.169` outranks our `1.0.x`.
- NEVER hand-edit `~/.claude/hooks/context-mode-cache-heal.mjs`. `start.mjs` overwrites it on every boot.
- `assert-bundle` does NOT compare committed bundles against a rebuild — it only scans for the esbuild `__require("node:...")` shim. Stale bundles pass CI and ship broken code. Always run `npm run build` before committing a change under `src/`.
```

- [ ] **Step 5: 확인 (GREEN)**

```bash
grep -c "do NOT merge upstream" CLAUDE.md
grep -c "context-mode-js" CLAUDE.md
```
Expected: `1`, `1`

- [ ] **Step 6: 커밋**

```bash
git add CLAUDE.md
git commit -m "chore: add upstream remote and hard-fork rules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 자동 커밋 봇 정지 + 상류 인프라 접점 제거

**Files:**
- Delete (9): `.github/workflows/update-stats.yml`, `.github/workflows/openclaw-e2e.yml`, `.github/workflows/tier2-e2e-smoke.yml`, `scripts/tier2-smoke/assert-stats.mjs`, `scripts/tier2-smoke/fixtures/search-corpus.txt`, `scripts/tier2-smoke/run-pi-smoke.sh`, `stats.json`, `tests/tier2-smoke-assert.test.ts`, `.github/FUNDING.yml`
- Modify: `.github/workflows/bundle.yml`

**왜 이 순서인가:** `bundle.yml`의 트리거는 `on.push.paths = ['src/**','package.json','tsconfig.json']`이고 권한은 `contents: write`다. Task 4가 `package.json`을 고쳐 push하는 순간 봇이 번들을 재빌드해 `main`에 커밋을 밀어넣는다. `update-stats.yml`은 6시간 cron이라 작업 중 아무 때나 발화해 push를 non-fast-forward로 거부시킨다.

- [ ] **Step 1: 상류 접점이 실제로 존재함을 확인한다 (RED)**

```bash
grep -rlE "mksglu|jsdelivr|purge" .github/workflows/
cat .github/FUNDING.yml
grep -nE "^on:|push:|paths:|contents: write" .github/workflows/bundle.yml
```
Expected: `update-stats.yml` 한 줄 / `github: [mksglu]` / `push:`·`paths:`·`contents: write` 모두 존재.

- [ ] **Step 2: 9개 파일을 삭제한다**

`-r` 플래그를 쓰지 않는다 (경로를 하나씩 나열).

```bash
git rm .github/workflows/update-stats.yml \
       .github/workflows/openclaw-e2e.yml \
       .github/workflows/tier2-e2e-smoke.yml \
       .github/FUNDING.yml \
       scripts/tier2-smoke/assert-stats.mjs \
       scripts/tier2-smoke/fixtures/search-corpus.txt \
       scripts/tier2-smoke/run-pi-smoke.sh \
       stats.json \
       tests/tier2-smoke-assert.test.ts
```

`tests/tier2-smoke-assert.test.ts`가 함께 가는 이유: `:23`에서 `stats.json`을 읽고 `assert-stats.mjs`를 spawn한다. 남기면 vitest가 깨진다.

- [ ] **Step 3: `bundle.yml`을 수동 실행 전용으로 바꾼다**

`on:` 블록만 교체한다. `permissions`와 `jobs`는 건드리지 않는다 — 수동 실행 시에는 여전히 번들을 커밋할 수 있어야 한다.

교체 전 (파일 3–10행, 정확히 이 8줄):
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
grep -rlE "mksglu|jsdelivr|purge|shields\.io" .github/ ; test $? -eq 1 && echo "PASS: .github/ 에 상류 접점 없음"
git ls-files .github/workflows/
awk '/^on:/,/^permissions:/' .github/workflows/bundle.yml
```
Expected:
- `PASS: .github/ 에 상류 접점 없음`
- 워크플로는 `ci.yml`, `bundle.yml` 두 개
- `on:` 아래에 `workflow_dispatch:` 하나만

- [ ] **Step 5: 인접 테스트가 통과하는지 확인한다**

`tests/scripts/`에는 6개 파일이 있다. 이 변경과 무관한 `start-mjs-*` 3개와 `assert-bundle` 1개까지 끌어들이지 않도록 **두 파일만** 지정한다.

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run \
  tests/scripts/version-sync.test.ts \
  tests/scripts/asymmetric-drift-assert.test.ts \
  --pool=forks --maxWorkers=1
```
Expected: 모든 테스트 PASS.

- [ ] **Step 6: 커밋**

```bash
git add -A .github/workflows/bundle.yml
git commit -m "ci: stop auto-commit bots and remove upstream infrastructure calls

update-stats.yml purged mksglu's jsDelivr CDN cache every 6 hours and
auto-committed stats.json to main. bundle.yml pushed rebuilt bundles to
main on every src/ or package.json push, which would collide with the
version bump in the next phase. FUNDING.yml sent this fork's sponsor
button to the upstream author.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 상류로 유도하는 링크·뱃지·메타데이터 제거 + npm 재배포 차단

**Files:** `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml:19,20,35`, `CONTRIBUTING.md:98,271`, `README.md:17`, `package.json`

- [ ] **Step 1: 상류 링크가 존재함을 확인한다 (RED)**

```bash
grep -rn "github.com/mksglu" .github/ CONTRIBUTING.md package.json | grep -vE "issues/482|opencode#20259"
grep -c "cdn.jsdelivr.net" README.md
grep -c '"private"' package.json
```
Expected: 여러 줄 / `≥1` / `0`

- [ ] **Step 2: `.github/ISSUE_TEMPLATE/config.yml` 전체 교체**

```yaml
blank_issues_enabled: false
contact_links:
  - name: Open a PR instead
    url: https://github.com/wotjr1649/context-mode/blob/main/CONTRIBUTING.md
    about: PRs with TDD (red-green-refactor) are strongly preferred over issues. See CONTRIBUTING.md.
```

- [ ] **Step 3: `.github/ISSUE_TEMPLATE/bug_report.yml`의 세 줄**

19행:
```markdown
        3. **Write a failing test** (RED) and fix it (GREEN) — see [CONTRIBUTING.md](https://github.com/wotjr1649/context-mode/blob/main/CONTRIBUTING.md)
```
20행 (이 fork에는 `next` 브랜치가 없다):
```markdown
        4. **Open a PR** against `main` branch — CI verifies on Ubuntu, macOS, and Windows
```
35행:
```markdown
        1. [Search existing issues](https://github.com/wotjr1649/context-mode/issues)
```

- [ ] **Step 4: `CONTRIBUTING.md`의 두 줄**

98행:
```bash
git clone https://github.com/wotjr1649/context-mode.git
```
271행:
```bash
npx skills add https://github.com/wotjr1649/context-mode/tree/main/.claude/skills/context-mode-ops
```

`:350`·`:354`의 상류 이슈 `#482` 인용은 **건드리지 않는다.** 출처 표기이지 유도 링크가 아니다.

- [ ] **Step 5: `README.md` 17행의 뱃지 줄 교체**

3–13행의 "modified fork" 고지 블록은 **손대지 않는다** — ELv2 의무다.

17행은 뱃지 7개가 든 매우 긴 단일 라인이다 (`cdn.jsdelivr.net` 3건이 전부 여기 있다). **먼저 Read로 그 줄을 정확히 읽고** 전체를 다음 한 줄로 교체한다:

```markdown
[![License: ELv2](https://img.shields.io/badge/License-ELv2-blue.svg)](LICENSE)
```

18–19행(Discord, Hacker News)은 상류 인프라가 아니므로 건드리지 않는다.

- [ ] **Step 6: `package.json` — 메타데이터 4곳**

25–29행:
```json
  "repository": {
    "type": "git",
    "url": "https://github.com/wotjr1649/context-mode"
  },
  "homepage": "https://github.com/wotjr1649/context-mode#readme",
```
50행:
```json
  "bugs": "https://github.com/wotjr1649/context-mode/issues",
```
그리고 3행 `"version": "1.0.169",` 바로 아래에 삽입:
```json
  "private": true,
```

`bugs`가 특히 중요하다 — Task 1이 `CLAUDE.md`에 새로 넣는 "no links funnelling issues to its tracker"와 정면으로 충돌한다. `author` 필드는 **유지한다** (ELv2 저작자 고지).

`"private": true`는 `npm publish`만 차단하며 `npm install`·`postinstall`·플러그인 설치에는 영향이 없다.

- [ ] **Step 7: 확인 (GREEN)**

```bash
grep -rn "github.com/mksglu" .github/ CONTRIBUTING.md package.json | grep -vE "issues/482|opencode#20259" ; test $? -eq 1 && echo "PASS: 유도 링크 0건"
grep -c "cdn.jsdelivr.net" README.md ; test $? -ne 0 && echo "PASS: jsDelivr 뱃지 0건"
grep -c "This is a modified fork" README.md
grep -n '"private": true' package.json
```
Expected: `PASS: 유도 링크 0건` / `PASS: jsDelivr 뱃지 0건` / `1` / `"private": true` 1건

- [ ] **Step 8: 커밋**

```bash
git add .github/ISSUE_TEMPLATE/ CONTRIBUTING.md README.md package.json
git commit -m "chore: point fork metadata at the fork, drop upstream badges, block npm publish

D9: no automation, template, or manifest field funnels traffic to upstream.
The ELv2 'modified fork' notice, LICENSE, and author field stay — obligations.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 마켓플레이스 개명 + 버전 `1.0.0` + `main` 반영

**Files:**
- Modify: `.claude-plugin/marketplace.json:2`, `package.json:3`
- Modify (자동): `npm run version-sync`가 TARGETS 10개 중 존재하는 것들을 갱신

**Interfaces:**
- Consumes: Task 2 (봇이 자고 있어야 push가 안전하다)
- Produces: `origin/main`에 마켓플레이스명 `context-mode-js` + `plugin.json.version == "1.0.0"`인 커밋

- [ ] **Step 1: 현재 값 확인 (RED)**

```bash
grep -n '"name"' .claude-plugin/marketplace.json | head -1
grep -h '"version"' package.json .claude-plugin/plugin.json .codex-plugin/plugin.json
```
Expected: `2:  "name": "context-mode",` / 세 줄 모두 `1.0.169`

- [ ] **Step 2: Claude 마켓플레이스 이름을 바꾼다**

`.claude-plugin/marketplace.json` **2행만** 바꾼다. 13행의 `"name": "context-mode"`는 **플러그인 이름**이므로 그대로 둔다.

교체 전:
```json
  "name": "context-mode",
  "owner": {
```
교체 후:
```json
  "name": "context-mode-js",
  "owner": {
```

`.agents/plugins/marketplace.json`(Codex 카탈로그)의 `name`은 **바꾸지 않는다.** Codex는 SHA 기준이고, `src/adapters/codex/index.ts`가 `context-mode@context-mode`를 하드코딩하고 있다.

- [ ] **Step 3: `package.json`의 버전을 손으로 고친다**

```json
  "version": "1.0.0",
```

`"version": "1.0.169",`는 `package.json`에 정확히 1건이다 (87행의 `"version": "node scripts/version-sync..."`는 값이 달라 충돌하지 않는다).

- [ ] **Step 4: 매니페스트 동기화**

```bash
npm run version-sync
```

이 시점에 `TARGETS` 10개 경로가 전부 존재한다 (삭제는 아직 안 했다). 삭제를 먼저 했다면 `version-sync.mjs`의 fail-loud에 걸린다. **순서가 의미를 갖는 이유다.**

- [ ] **Step 5: 확인 (GREEN)**

```bash
NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/scripts/version-sync.test.ts --pool=forks --maxWorkers=1
```
Expected: PASS

```bash
# 버전 값만 뽑아 유일성 확인 (파일 전체를 grep 하면 npm 스크립트 라인까지 잡힌다)
grep -oh '"version": "[0-9][0-9.]*"' package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json | sort -u
grep -rc "1\.0\.169" package.json .claude-plugin/ .codex-plugin/
grep -n '"name": "context-mode-js"' .claude-plugin/marketplace.json
```
Expected: `"version": "1.0.0"` 한 줄만 / 모든 파일 `0` / 2행에 1건

- [ ] **Step 6: 커밋**

```bash
git add package.json .claude-plugin/ .cursor-plugin/ .codex-plugin/ .openclaw-plugin/ openclaw.plugin.json .pi/ configs/antigravity-cli/plugin.json configs/copilot-cli/.github/plugin/plugin.json
git commit -m "feat: isolate the fork under its own marketplace, start version line at 1.0.0

start.mjs:164 rewrites installed_plugins.json to the highest-semver dir in
the plugin cache parent on every MCP boot. The cache parent is keyed by
marketplace name, so sharing 'context-mode' with upstream means our 1.0.x
loses to upstream's 1.0.169 forever. Naming this fork's Claude marketplace
'context-mode-js' gives it a fresh cache parent where 1.0.0 is the only
version — no cache wipe, no forced shutdown, no revival hazard.

Codex's catalog name stays 'context-mode' (SHA-keyed, and codex/index.ts
hardcodes the plugin id).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: `main`에 반영하고 push한다**

> **사용자 확인 필요.** `origin/main`은 마켓플레이스가 추적하는 배포 브랜치다. 진행 전에 확인받는다.

```bash
git checkout main
git merge --ff-only spec/fork-foundation
git push origin main
```

`--ff-only`가 실패하면 `main`이 앞서 있다는 뜻 — 봇이 살아 있었다는 신호다. **멈추고 Task 2를 재검토한다.**

- [ ] **Step 8: 봇이 깨어나지 않았는지 확인한다**

```bash
gh run list --repo wotjr1649/context-mode --limit 5
git fetch origin && git log --oneline -1 origin/main
```
Expected: `bundle.yml` 실행 0건. `origin/main` HEAD가 방금 push한 커밋과 동일.

---

### Task 5: 커토버 + 6중 판정 — **정지 게이트**

**Files:** 없음 (저장소를 건드리지 않는다)

**Interfaces:**
- Consumes: Task 4가 push한 `origin/main`
- Produces: "fork 코드가 격리된 트리에서 실제로 실행된다"의 경험적 확인

> **에이전트는 1–7을 실행할 수 없다.** 재시작이 이 대화의 끝이기 때문이다. 사용자가 수행한다. 8–10은 재시작된 새 세션에서 에이전트가 수행한다.
>
> **캐시를 지우지 않으므로 Claude 강제 종료도 `.in_use` 잠금 해제도 필요 없다.** 옛 트리는 그대로 남고, 롤백은 재설치 한 번이다.

- [ ] **Step 1: (사용자) 옛 플러그인을 제거한다**
```
/plugin uninstall context-mode@context-mode
```
캐시 디렉토리는 남는다. 그게 롤백 경로다.

- [ ] **Step 2: (사용자) 옛 마켓플레이스 등록을 제거한다**
```
/plugin marketplace remove context-mode
```

- [ ] **Step 3: (사용자) 새 이름으로 마켓플레이스를 등록한다**
```
/plugin marketplace add wotjr1649/context-mode
```
카탈로그가 스스로를 `context-mode-js`라 선언하므로 그 이름으로 등록된다.

- [ ] **Step 4: (사용자) 플러그인을 설치한다**
```
/plugin install context-mode@context-mode-js
```

- [ ] **Step 5: (사용자) Claude Code를 재시작한다** — 일반 재시작이면 된다.

- [ ] **Step 6: (사용자) Codex 쪽 갱신**
```bash
codex plugin marketplace upgrade context-mode
```
Codex는 SHA 기준(F8)이라 이 한 줄로 끝난다. 이름은 그대로다.

- [ ] **Step 7: (사용자) `settings.json` 정합 확인**

`extraKnownMarketplaces`에 `context-mode-js` 키만 있고 옛 `context-mode` 키는 없어야 한다. `enabledPlugins`도 마찬가지다. 옛 키가 남으면 `heal-installed-plugins.mjs:105-110`이 매 부팅 재기입한다.

- [ ] **Step 8: (에이전트, 새 세션) 정적 판정 — 1·2·3·6**

`ctx_execute(language: "javascript")`로 실행한다.

```javascript
const fs = require('fs'), path = require('path'), os = require('os');
const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const reg = JSON.parse(fs.readFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), 'utf8'));

const entry = (reg.plugins['context-mode@context-mode-js'] || [])[0];
const oldEntry = reg.plugins['context-mode@context-mode'];
if (!entry) { console.log('FAIL  새 항목 없음'); }
else {
  const real = fs.realpathSync(entry.installPath);
  const runHook = fs.readFileSync(path.join(real, 'hooks', 'run-hook.mjs'), 'utf8');
  const codexHook = fs.readFileSync(path.join(real, 'hooks', 'codex', 'pretooluse.mjs'), 'utf8');
  const checks = [
    ['1. version === 1.0.0',           entry.version === '1.0.0'],
    ['2. realpath = context-mode-js/context-mode/1.0.0',
                                       /context-mode-js[\\/]context-mode[\\/]1\.0\.0$/.test(real)],
    ['3a. run-hook.mjs 명시적 exit',    /process\.exit\(0\)/.test(runHook)],
    ['3b. codex flushAndExit',         codexHook.includes('flushAndExit')],
    ['6. 옛 레지스트리 항목 제거됨',      !oldEntry],
  ];
  console.log('installPath(real):', real);
  for (const [n, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + '  ' + n);
  console.log(checks.every(c => c[1]) ? '\n정적 판정 통과' : '\n정적 판정 실패 — 진행 금지');
}
```
Expected: 다섯 줄 모두 `PASS`.

`2`가 FAIL이면 fork가 옛 캐시 부모에 깔렸다는 뜻이다. 즉시 중단한다 — forward-heal이 다음 부팅에 상류로 되돌린다.

- [ ] **Step 9: (에이전트, 새 세션) 런타임 판정 — 4**

바이트 존재는 실행을 증명하지 않는다. **실행 중인 프로세스가 어느 트리를 가리키는지** 본다.

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'context-mode' } |
  ForEach-Object {
    $tree = if ($_.CommandLine -match '(?i)cache\\(context-mode[^\\]*)\\context-mode\\([\d.]+)') { "$($Matches[1])/$($Matches[2])" } else { '(캐시 밖)' }
    [pscustomobject]@{ PID = $_.ProcessId; Tree = $tree }
  } | Format-Table -AutoSize
```
Expected: 캐시 안을 가리키는 모든 행이 `context-mode-js/1.0.0`. `context-mode/1.0.169`가 하나라도 보이면 **실패**.

- [ ] **Step 10: (에이전트, 새 세션) 훅 발동 판정 — 5**

PreToolUse 라우팅이 실제로 도는지 관측한다. context-mode는 `WebFetch`를 `ctx_fetch_and_index`로 리다이렉트한다.

`WebFetch`를 아무 URL로 한 번 호출한다. **훅이 돌면 리다이렉트되고, 안 돌면 그냥 fetch된다.** 리다이렉트가 관측되면 판정 5 통과.

이어서 고아가 쌓이지 않는지 본다. Bash 도구를 5회 연속 호출한 뒤:

```powershell
$root = "$env:USERPROFILE\.claude\plugins\cache\context-mode-js"
$procs = Get-CimInstance Win32_Process
$alive = $procs.ProcessId
($procs | Where-Object { $_.CommandLine -like "*$root*" -and ($alive -notcontains $_.ParentProcessId) }).Count
```
Expected: `0`

주의: 고아 0건은 "새지 않았다"이지 "`process.exit(0)` 그 줄이 돌았다"의 증명이 아니다. 스펙 §10의 명시적 한계다.

- [ ] **Step 11: 정지. 판정 결과를 보고한다**

**이 계획은 여기서 끝난다.** 8·9·10이 모두 통과하면 단계 3(204파일 삭제)을 별도 계획으로 작성한다.

**하나라도 실패하면 롤백한다** (옛 트리가 그대로 있어 싸다):

```
/plugin uninstall context-mode@context-mode-js
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
```
그리고 Codex: `~/.codex/config.toml`의 `[marketplaces.context-mode]` source를 `mksglu/context-mode`로 되돌린 뒤 `codex plugin marketplace upgrade context-mode`.

> `~/.claude`에서 `git revert 37a64ea`만 하는 것으로는 **부족하다.** 그 커밋은 `settings.json` 한 줄만 바꿨고 Codex 설정은 건드리지 않았다.

---

## Self-Review

**1. Spec coverage (단계 0–2)**

| 스펙 요구 | 태스크 |
|---|---|
| §6 단계 0: upstream remote `--no-tags` + merge 금지 규칙 | Task 1 |
| §7 삭제 9파일 (FUNDING.yml 포함) | Task 2 Step 2 |
| §7 `bundle.yml` 수동 전환 / `ci.yml` 유지 | Task 2 Step 3–4 |
| §7 상류 링크·뱃지 제거 | Task 3 Step 2–5 |
| §7 `package.json` repository·homepage·bugs (F40) | Task 3 Step 6 |
| §7 README ELv2 고지·LICENSE·author 유지 | Task 3 Step 5–6, Step 7 검증 |
| §7 `"private": true` | Task 3 Step 6 |
| **D11 마켓플레이스 개명** | Task 4 Step 2 |
| §5.1 `npm version` 금지 | Task 4 Step 3–4 |
| §5.2 커토버 7단계 | Task 5 Step 1–7 |
| §5.3 판정 6개 | Task 5 Step 8(1,2,3,6) · Step 9(4) · Step 10(5) |
| §6.2 정지 게이트 | Task 5 Step 11 |
| §6.1 봇 정지가 버전 push보다 앞 | Task 2 → Task 4, `--ff-only` 가드 |
| §10 롤백 (Claude + Codex 양쪽) | Task 5 Step 11 |

단계 3·4·5·6은 **의도적으로 이 계획 밖**이다.

**2. Placeholder scan:** "TBD"·"TODO"·"적절히 처리"·"비슷하게" 없음.

**3. 검수에서 잡힌 오류 (수정 완료):**
- Task 4의 GREEN 판정이 `grep '"version"'`로 4줄을 반환해 오판을 유발 → 값만 추출하도록 교체
- Task 2의 vitest 스텝이 `tests/scripts` 6개를 전부 돌림 → 두 파일만 지정
- D9 게이트가 `.github/FUNDING.yml`과 `package.json` 메타를 놓침 → Task 2·3에 추가
- `git fetch upstream --tags`가 상류 태그를 유입 → `--no-tags`로 교체
- 롤백이 Claude만 되돌리고 Codex를 방치 → 양쪽 명시

**4. 남은 한계 (스펙 §10에 기록):** 단계 2는 I1을 증명하지 않는다 — 새 마켓플레이스 아래의 설치는 버전 게이트를 타지 않는 신규 설치다. I1은 단계 6에서 `1.0.0 → 1.0.1` 상향으로 따로 검증한다.
