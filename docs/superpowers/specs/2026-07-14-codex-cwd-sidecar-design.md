# Codex 첫-부팅 워크스페이스: 훅-사이드카 설계

- 날짜: 2026-07-14
- 상태: 승인됨 → 구현
- 관련: `HANDOFF-codex-first-boot-signal.md`

## 문제

Codex 하에서 ctxscribe MCP 서버는 자신이 어느 프로젝트(workspace)를 위해 도는지 알아야
한다. 남은 두 미세 한계:

1. **세션-매칭 레이스**: 우리 rollout이 디스크에 flush되기 전(~9s 지연)에 다른 Codex
   창이 우리 부팅 ~2초 내 열리면 그 외부 세션이 순간 매칭될 수 있음.
2. **첫 세션(힐 전, cwd=플러그인)** 은 세션-로그 휴리스틱(`resolveCodexSessionCwd`)에만
   의존.

## 조사 결론 — "첫 부팅 신뢰 신호" 전제는 반증됨

최신 Codex(0.144.4 / 소스 `rust-v0.145.0-alpha.9` `1280b5d`)에서 3중(소스·이슈·라이브
프로브) 확증:

- **R1** MCP 자식 env에 세션/워크스페이스 신호 없음: `stdio_server_launcher.rs:268`
  `env_clear()`+allowlist / GitHub #19937 **not_planned 거부**(#10096 CODEX_THREAD_ID는
  셸 env만) / 프로브 실측 env = allowlist 19개, CODEX_* 0.
- **R2** mcp.json `${...}` 확장 없음: `plugin_config.rs` 0건 / #2680 OPEN·미제공.
- **R3** 훅은 MCP 스폰 **이후** 발화: `session.rs:1201`(MCP 즉시 스폰) vs 1257(SessionStart
  큐잉, 첫-턴 실행) → MCP 스폰 전 실행되는 훅 없음.
- **R4** MCP roots/initialize 워크스페이스 필드 없음(elicitation만).
- **H1** #28914 `sandboxCwd`(`codex/sandbox-state-meta`)는 stdio MCP에 안 옴(프로브 stdin
  로그: initialize/initialized/tools-list 3개뿐).
- **유일 신호** = 자식 프로세스 cwd(cwd 생략 시 fallback=워크스페이스, 프로브로 확증). 단
  신선 clone 첫 부팅은 `./start.mjs` 해석 위해 cwd=플러그인 필수(§7.1 hang) → 못 씀.

→ **원초 삭제(휴리스틱 제거)는 불가**. Codex가 의도적으로 안 주는 신호다.

## 설계 — 훅-사이드카 (freshness 우선 · ppid 결정론 · 롤아웃 폴백)

Codex 훅 페이로드는 `input.cwd`(워크스페이스) + session_id를 실어 나른다(단 hook 자식에게만).
PreToolUse는 MCP tool 실행 **직전**에 blocking으로 발화한다. 이를 이용해 우리 워크스페이스
기록을 롤아웃 9초 지연 없이 즉시·신선하게 디스크에 둔다.

### Sidecar
- 경로: `${CODEX_HOME ?? ~/.codex}/ctxscribe-cwd/<sessionId>.json`
- 내용: `{ cwd, sessionId, ppid, ts }`

### Writer — `hooks/session-helpers.mjs :: writeCodexCwdSidecar({codexHome, sessionId, cwd, ppid})`
- `hooks/codex/sessionstart.mjs`: 세션 시작 시 기록(이른 백스톱).
- `hooks/codex/pretooluse.mjs`: 매 tool call 직전 갱신(핵심).
- write-tmp-rename(torn read 방지), dir 생성, best-effort, cwd 비면 스킵.

### Reader — `src/util/project-dir.ts :: resolveCodexSessionCwd` 재작성
1. `${codexHome}/ctxscribe-cwd/*.json` 스캔 → stale(mtime `now-ts > maxAge`)·플러그인경로·빈 cwd 제외.
2. `ppid === process.ppid`인 사이드카들 중 **mtime 최신** 반환(있으면). ← CLI/companion은 ppid가
   세션을 유일 식별(타이밍 무관); 데스크톱 공유 app-server면 형제 집합으로 좁혀 그중 활성(방금
   PreToolUse가 쓴) 것을 고름.
3. ppid 일치 0개 → 전체 중 **mtime 최신** 반환. ← 데스크톱: 방금 PreToolUse가 쓴 활성 세션.
4. 사이드카 전무 → **기존 롤아웃 스캔으로 폴백**(첫 신뢰-전 세션 대비).

**캐시 안 함**(Codex 리뷰 반영): 공유/재사용 ppid에서 일시적 오매치를 프로세스 생애 내내
고정할 위험 → 매 호출 재도출(dir 작고 mtime-prefilter라 저렴, 항상 디스크 반영). 롤아웃 폴백은
기존 tight-match 캐시 유지.

### 정리
SessionStart에서 오래된 사이드카 prune(7일, 기존 `cleanupOldSessions` 옆).

## 효과 / 정직한 한계
- 레이스 창: `9초` → `PreToolUse쓰기~MCP읽기 sub-초`. CLI는 ppid로 소멸. 세션1도 정확.
- **완전 삭제는 불가**(첫 신뢰-전 세션엔 훅 미발화 → 사이드카 없음). 휴리스틱은 **폴백으로 강등**.

## 테스트
- `resolveCodexSessionCwd`: ppid-exact / 다중ppid→freshness / freshness / recency 필터 /
  플러그인경로 거부 / 롤아웃 폴백 / 사이드카>롤아웃 우선 / ppid-exact 캐시.
- `writeCodexCwdSidecar`: 경로·내용·dir 생성·atomic·빈 cwd 스킵.

## 검증
`npm run build`(src/ 변경) · `vitest --pool=forks --maxWorkers=1` · Codex pre-commit 리뷰.
