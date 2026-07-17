# R3 Large-Read Guard Implementation Plan (rev 2 — post-Codex, > 1 MiB scope)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deny full-file Reads (no `offset`/`limit`) of text files > 1 MiB at PreToolUse — the band R1 can never index — with a recipe redirecting to `ctx_execute_file` (analysis) or a windowed Read (editing), plus a nudge-accounting fix so the deny telemetry survives the recovery path.

**Architecture:** A stateless sibling of the R1 read-guard. `evaluateLargeReadGuard` lives in `hooks/core/readstate.mjs` (same module as `evaluateReadGuard`), called from the Read branch of `hooks/core/routing.mjs` *after* the R1 guard and *before* the 50 KB nudge, reusing the nudge's `statSync`. The 50 KB nudge attaches `redirectMeta` only to full Reads (accounting fix). No MCP gating; subagents exempt (R1 parity).

**Tech Stack:** hand-authored ESM hooks (`hooks/core/*.mjs`, node builtins only — PreToolUse must never load native modules), vitest tests in `tests/hooks/*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-07-17-r3-large-read-guard-design.md` (rev: accepted, > 1 MiB)

## Global Constraints

- Threshold: `LARGE_READ_GUARD_BYTES = MAX_INDEX_FILE_BYTES` (1_048_576) — R3 denies exactly what R1 cannot index; lowering it requires a raw-source recall path (ADR-0008 R3 disposition).
- Kill-switch: `CONTEXT_MODE_LARGE_READ_GUARD === "0"` disables. Every failure path fails OPEN (return `null`, never throw).
- Decision priority in the Read branch: R1 read-guard → R3 large-read guard → 50 KB nudge.
- `redirectMeta.type = "large-read-denied"` (existing marker → PostToolUse `redirect` event plumbing; no posttooluse change).
- Visual/media exemption `VISUAL_READ_EXTS`: `.png .jpg .jpeg .gif .webp .bmp .ico .pdf .ipynb` — deliberately narrower than toolindex `BINARY_EXTS`.
- Test runs are memory-capped, one file at a time: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run <file> --pool=forks --maxWorkers=1`.
- `npm run build` (5 assert gates) must pass before every commit; stage everything, single commit (pre-commit hook enforces worktree == index).
- File output: UTF-8 no BOM, LF.

---

### Task 1: `evaluateLargeReadGuard` in readstate.mjs (unit level)

**Files:**
- Modify: `hooks/core/readstate.mjs` (add exports; refactor `evaluateReadGuard` to the shared predicate; update module header)
- Create: `tests/hooks/r3-large-read-guard.test.ts`

**Interfaces:**
- Produces: `isWindowedRead(toolInput): boolean`; `LARGE_READ_GUARD_BYTES` (=== `MAX_INDEX_FILE_BYTES`); `evaluateLargeReadGuard({ toolInput, filePath, st, isSubagent }): {action:"deny",...} | null` — `st` is a `fs.Stats` already obtained by the caller (single stat).

- [ ] **Step 1: Write the failing unit tests**

Create `tests/hooks/r3-large-read-guard.test.ts`:

```ts
/**
 * ADR-0008 R3 large-read guard (> 1 MiB) — discriminating cases from
 * docs/superpowers/specs/2026-07-17-r3-large-read-guard-design.md.
 * Unit matrix first; routePreToolUse integration and livefire below.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTING_PATH = resolve(__dirname, "..", "..", "hooks", "core", "routing.mjs");
const READSTATE_PATH = resolve(__dirname, "..", "..", "hooks", "core", "readstate.mjs");

const BIG = 1_500_000;   // > 1 MiB → R3 territory
const MID = 800_000;     // R1 band — must stay untouched
const SMALL = 120_000;   // R1 band — must stay untouched

let routing: any;
let rs: any;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  routing = await import(pathToFileURL(ROUTING_PATH).href);
  rs = await import(pathToFileURL(READSTATE_PATH).href);
});

afterEach(() => {
  delete process.env.CONTEXT_MODE_LARGE_READ_GUARD;
  while (cleanups.length) cleanups.pop()!();
});

function tmpFile(name: string, bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "r3-lrg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  writeFileSync(file, "x".repeat(bytes), "utf-8");
  return file;
}

function unitEval(file: string, toolInput: Record<string, unknown>, isSubagent = false) {
  return rs.evaluateLargeReadGuard({ toolInput, filePath: file, st: statSync(file), isSubagent });
}

describe("evaluateLargeReadGuard unit matrix", () => {
  it("denies a full Read of a 1.5MB text file with the execute_file + windowed recipe", () => {
    const file = tmpFile("huge.log", BIG);
    const d = unitEval(file, { file_path: file });
    expect(d?.action).toBe("deny");
    expect(d?.reason).toContain("ctx_execute_file");
    expect(d?.reason).toContain("offset");
    expect(d?.reason).toContain("NOT indexed");
    expect(d?.reason).toContain("CONTEXT_MODE_LARGE_READ_GUARD=0");
    expect(d?.redirectMeta?.type).toBe("large-read-denied");
    expect(d?.redirectMeta?.bytesAvoided).toBe(BIG);
  });

  it("passes a windowed Read of the same file (documented residual: presence-only predicate)", () => {
    const file = tmpFile("huge.log", BIG);
    expect(unitEval(file, { file_path: file, offset: 0, limit: 999_999 })).toBeNull();
    expect(unitEval(file, { file_path: file, offset: 10, limit: 50 })).toBeNull();
  });

  it("passes the R1 band untouched (120KB and 800KB full Reads)", () => {
    for (const [name, bytes] of [["small.ts", SMALL], ["mid.ts", MID]] as const) {
      const file = tmpFile(name, bytes);
      expect(unitEval(file, { file_path: file }), name).toBeNull();
    }
  });

  it("stays exactly aligned with the R1 indexing ceiling", () => {
    expect(rs.LARGE_READ_GUARD_BYTES).toBe(rs.MAX_INDEX_FILE_BYTES);
  });

  it("passes visual files Read renders natively (.png, .pdf, .ipynb) even above the threshold", () => {
    for (const name of ["shot.png", "doc.pdf", "nb.ipynb"]) {
      const file = tmpFile(name, BIG);
      expect(unitEval(file, { file_path: file }), name).toBeNull();
    }
  });

  it("passes when CONTEXT_MODE_LARGE_READ_GUARD=0", () => {
    process.env.CONTEXT_MODE_LARGE_READ_GUARD = "0";
    const file = tmpFile("huge.log", BIG);
    expect(unitEval(file, { file_path: file })).toBeNull();
  });

  it("passes inside a subagent context (R1 parity)", () => {
    const file = tmpFile("huge.log", BIG);
    expect(unitEval(file, { file_path: file }, true)).toBeNull();
  });

  it("isWindowedRead matches the R1 predicate exactly", () => {
    expect(rs.isWindowedRead({})).toBe(false);
    expect(rs.isWindowedRead({ offset: 0 })).toBe(true);
    expect(rs.isWindowedRead({ limit: 999_999 })).toBe(true);
    expect(rs.isWindowedRead(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: FAIL — `rs.evaluateLargeReadGuard is not a function`.

- [ ] **Step 3: Implement in readstate.mjs**

3a. Extend the path import (line 14) to include `extname`:

```js
import { resolve, join, extname } from "node:path";
```

3b. Below `MAX_INDEX_FILE_BYTES` (line 22), add:

```js
// ─── ADR-0008 R3 large-read guard ───
// R3 denies full-file Reads of exactly the band R1 can never index: a
// > 1 MiB payload (≈ 269K tok at 3.9 B/tok) exceeds any usable context
// window, and no FTS5 recall exists up there to regress. Lower this only
// with a raw-source recall path for denied files (see ADR-0008 R3).
export const LARGE_READ_GUARD_BYTES = MAX_INDEX_FILE_BYTES;

// Read renders these visually (images/PDF) or as structured cells (ipynb) —
// no ctx tool substitutes for that, so the large-read guard lets them
// through. Deliberately narrower than toolindex BINARY_EXTS: an archive or
// executable full Read SHOULD be denied (ctx_execute_file analyzes those).
const VISUAL_READ_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".ipynb",
]);

/** The single definition of "windowed" shared by both Read guards. */
export function isWindowedRead(toolInput) {
  const ti = toolInput ?? {};
  return ti.offset != null || ti.limit != null;
}
```

3c. In `evaluateReadGuard`, replace the inline predicate

```js
    const ti = toolInput ?? {};
    if (ti.offset != null || ti.limit != null) return null;
```

with:

```js
    if (isWindowedRead(toolInput)) return null;
```

3d. Append after `evaluateReadGuard`:

```js
/**
 * ADR-0008 R3: deny a full-file Read of a text file too large for R1 to
 * index. Stateless — evaluated after the R1 read-guard (an armed re-read
 * keeps R1's ctx_search recipe; overlap is impossible anyway since R1 only
 * arms ≤ MAX_INDEX_FILE_BYTES) and before the 50 KB nudge. `st` comes from
 * the caller's statSync so the Read branch stays at one stat syscall.
 * Anything ambiguous → null (allow); fail open like everything else here.
 */
export function evaluateLargeReadGuard({ toolInput, filePath, st, isSubagent }) {
  try {
    if (process.env.CONTEXT_MODE_LARGE_READ_GUARD === "0") return null;
    if (isSubagent || !filePath) return null;
    if (isWindowedRead(toolInput)) return null;
    if (!st || !st.isFile() || st.size <= LARGE_READ_GUARD_BYTES) return null;
    const abs = resolve(String(filePath));
    if (VISUAL_READ_EXTS.has(extname(abs).toLowerCase())) return null;
    return {
      action: "deny",
      reason:
        `ctxscribe large-read guard: ${abs} is ${Math.round(st.size / 1024)} KB — a full Read would flood the context window. ` +
        `For analysis, call ctx_execute_file(path, language, code) and print only the answer. ` +
        `For editing, Read a window with offset/limit around the target lines — a windowed Read re-arms Edit for the whole file. ` +
        `This file's content is NOT indexed, so do not try ctx_search for it. ` +
        `Set CONTEXT_MODE_LARGE_READ_GUARD=0 to disable this guard.`,
      redirectMeta: {
        tool: "Read",
        type: "large-read-denied",
        bytesAvoided: st.size,
        commandSummary: String(abs).slice(0, 200),
      },
    };
  } catch {
    return null;
  }
}
```

3e. Update the module header comment (lines 1-11):

```js
/**
 * R1/R3 read guards and sidecar state (ADR-0008 amendments).
 *
 * R1: PostToolUse records each successfully indexed full-file Read here (per
 * session, main conversation only); the PreToolUse Read branch consults it
 * to deny byte-identical full-file re-reads with a recall recipe.
 * R3: stateless large-read guard — a full Read of a text file too large for
 * R1 to index (> MAX_INDEX_FILE_BYTES) is denied with an execute_file /
 * windowed recipe (evaluated after R1 in the Read branch).
 *
 * Plain node builtins ONLY — PreToolUse must never load native modules
 * (native module load breaks the hook's stdout JSON, see pretooluse.mjs).
 * Every path fails OPEN: any error, mismatch, or ambiguity → allow / no-op.
 */
```

- [ ] **Step 4: Run to verify it passes**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: PASS (8 tests).

- [ ] **Step 5: Regression check the R1 files touched by the refactor**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r1-readstate.test.ts --pool=forks --maxWorkers=1`
Then: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r1-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
npm run build && git add -A && git commit -m "feat(hooks): ADR-0008 R3 — evaluateLargeReadGuard in readstate (>1MiB)"
```

---

### Task 2: routing.mjs integration + nudge accounting fix

**Files:**
- Modify: `hooks/core/routing.mjs:20` (import) and the Read branch (`:835-850`)
- Modify: `tests/hooks/r3-large-read-guard.test.ts` (append integration describe block)

**Interfaces:**
- Consumes: `evaluateLargeReadGuard`, `isWindowedRead` from Task 1.
- Produces: `routePreToolUse("Read", {file_path: <big>}, ...)` → `{action:"deny", redirectMeta:{type:"large-read-denied"}}`; windowed Reads no longer carry `read-redirected` redirectMeta.

- [ ] **Step 1: Append the failing integration tests**

Append to `tests/hooks/r3-large-read-guard.test.ts`:

```ts
/** Arm the R1 guard exactly like posttooluse would (copied from r1-read-guard.test.ts). */
function armedSetup(bytes = SMALL) {
  const dir = mkdtempSync(join(tmpdir(), "r3-armed-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "armed.ts");
  writeFileSync(file, "x".repeat(bytes), "utf-8");
  const dbPath = join(dir, "content.db");
  writeFileSync(dbPath, "fake-db", "utf-8");
  const sessionId = randomUUID();
  const st = statSync(file);
  rs.recordFullRead(sessionId, file, {
    hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
    size: st.size,
    mtimeMs: st.mtimeMs,
    dbPath,
    dbFileId: rs.fileIdOf(dbPath),
  });
  cleanups.push(() => { try { unlinkSync(rs.statePath(sessionId)); } catch { /* gone */ } });
  return { file, sessionId };
}

describe("R3 large-read guard inside routePreToolUse", () => {
  it("denies a first-ever full Read of a 1.5MB file", () => {
    const file = tmpFile("fresh.log", BIG);
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).toBe("deny");
    expect(d?.redirectMeta?.type).toBe("large-read-denied");
  });

  it("R1 read-guard still wins for an armed unchanged file in its own band", () => {
    const { file, sessionId } = armedSetup(SMALL);
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", sessionId, { isSubagent: false });
    expect(d?.action).toBe("deny");
    expect(d?.redirectMeta?.type).toBe("read-guard-denied");
  });

  it("windowed Read of a big file is not denied AND carries no redirectMeta (accounting fix)", () => {
    const file = tmpFile("fresh.log", BIG);
    const d = routing.routePreToolUse("Read", { file_path: file, offset: 1, limit: 100 }, dirname(file), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).not.toBe("deny");
    expect(d?.redirectMeta).toBeUndefined();
  });

  it("full Read in the R1 band keeps the 50KB-nudge redirectMeta (existing accounting preserved)", () => {
    const file = tmpFile("mid.ts", MID);
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).not.toBe("deny");
    expect(d?.redirectMeta?.type).toBe("read-redirected");
    expect(d?.redirectMeta?.bytesAvoided).toBe(MID);
  });

  it("nonexistent path is not denied (native Read error path preserved)", () => {
    const d = routing.routePreToolUse("Read", { file_path: join(tmpdir(), "r3-no-such-file-xyz.ts") }, tmpdir(), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).not.toBe("deny");
  });
});
```

- [ ] **Step 2: Run to verify the new block fails**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: the 1.5MB deny case and the windowed-no-redirectMeta case FAIL; the rest of the integration block already passes.

- [ ] **Step 3: Wire the guard + accounting fix into routing.mjs**

3a. Extend `hooks/core/routing.mjs:20`:

```js
import { evaluateLargeReadGuard, evaluateReadGuard, isWindowedRead } from "./readstate.mjs";
```

3b. In the Read branch, replace the `try { ... }` body (currently lines 836-848):

```js
      try {
        const st = statSync(filePath);
        // ─── ADR-0008 R3 large-read guard ───
        // After the R1 read-guard, before the 50 KB nudge. Stateless; denies
        // only the > MAX_INDEX_FILE_BYTES band R1 can never index or recall.
        const largeRead = evaluateLargeReadGuard({
          toolInput,
          filePath,
          st,
          isSubagent: options.isSubagent === true,
        });
        if (largeRead) return largeRead;
        if (st.isFile() && st.size > 50_000) {
          const decision = guidanceOnce("read", readGuidance, sessionId)
            ?? { action: "context", additionalContext: readGuidance };
          // Accounting fix (ADR-0008 R3 review): only a FULL read forfeits the
          // file-sized payload. A windowed read returns a slice — claiming the
          // whole file as bytes_avoided overcounted, and its marker write
          // clobbered a pending large-read-denied marker (last-write-wins).
          if (!isWindowedRead(toolInput)) {
            decision.redirectMeta = {
              tool: "Read",
              type: "read-redirected",
              bytesAvoided: st.size,
              commandSummary: String(filePath).slice(0, 200),
            };
          }
          return decision;
        }
      } catch { /* file missing or unreadable — fall through to plain guidance */ }
```

- [ ] **Step 4: Run to verify all pass**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: PASS (13 tests).

- [ ] **Step 5: Regression check the routing + marker suites**

Run each (capped, one file at a time):
- `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/core-routing.test.ts --pool=forks --maxWorkers=1`
- `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/redirect-marker-read.test.ts --pool=forks --maxWorkers=1`
- `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r1-read-guard.test.ts --pool=forks --maxWorkers=1`

Expected: PASS all. (`redirect-marker-read` uses full reads of an 80 KB file — unaffected by both the R3 threshold and the windowed-only redirectMeta gate.)

- [ ] **Step 6: Commit**

```bash
npm run build && git add -A && git commit -m "feat(hooks): ADR-0008 R3 — wire large-read guard + fix windowed-read bytes_avoided overcount"
```

---

### Task 3: livefire — real hook child + latency budget

**Files:**
- Modify: `tests/hooks/r3-large-read-guard.test.ts` (append livefire describe block)
- Modify: `tests/hooks/hook-latency.test.ts` (add one PRETOOL case for the deny path)

**Interfaces:**
- Consumes: `hooks/pretooluse.mjs` stdin contract `{session_id, tool_name, tool_input, agent_id?, agent_type?}` + env (`CLAUDE_PROJECT_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_SESSION_ID`, `HOME`/`USERPROFILE`, `CONTEXT_MODE_SESSION_SUFFIX: ""`) — recipe from `tests/hooks/redirect-marker-read.test.ts:113-124`. **Before writing the subagent case, grep `pretooluse.mjs` for how it derives `isSubagent` (`agent_id` / `agent_type` fields) and mirror the real field name.**
- Produces: proof that the shipped hook emits the deny JSON (~0.6 KB) instead of a 1.5 MB payload, that the marker survives a windowed retry, and that kill-switch + subagent exemption reach the shipped hook.

- [ ] **Step 1: Append the failing livefire tests**

Append to `tests/hooks/r3-large-read-guard.test.ts`:

```ts
describe("R3 livefire — real pretooluse.mjs child process", () => {
  const PRETOOL_PATH = resolve(__dirname, "..", "..", "hooks", "pretooluse.mjs");

  function livefireSetup(bytes: number) {
    const fakeHome = mkdtempSync(join(tmpdir(), "r3-lf-home-"));
    const fakeProject = mkdtempSync(join(tmpdir(), "r3-lf-proj-"));
    cleanups.push(() => rmSync(fakeHome, { recursive: true, force: true }));
    cleanups.push(() => rmSync(fakeProject, { recursive: true, force: true }));
    const file = join(fakeProject, "big.txt");
    writeFileSync(file, "x".repeat(bytes), "utf-8");
    const sessionId = `r3-lf-${randomUUID()}`;
    cleanups.push(() => { try { unlinkSync(resolve(tmpdir(), `ctxscribe-redirect-${sessionId}.txt`)); } catch {} });
    return { file, sessionId, fakeHome, fakeProject };
  }

  function runPre(
    ctx: { file: string; sessionId: string; fakeHome: string; fakeProject: string },
    toolInput: Record<string, unknown>,
    extra: { env?: Record<string, string>; payload?: Record<string, unknown> } = {},
  ) {
    return spawnSync("node", [PRETOOL_PATH], {
      input: JSON.stringify({
        session_id: ctx.sessionId,
        tool_name: "Read",
        tool_input: toolInput,
        ...(extra.payload ?? {}),
      }),
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: ctx.fakeHome,
        USERPROFILE: ctx.fakeHome,
        CLAUDE_CONFIG_DIR: join(ctx.fakeHome, ".claude"),
        CLAUDE_PROJECT_DIR: ctx.fakeProject,
        CLAUDE_SESSION_ID: ctx.sessionId,
        CONTEXT_MODE_SESSION_SUFFIX: "",
        ...(extra.env ?? {}),
      },
    });
  }

  function markerOf(sessionId: string): string {
    return readFileSync(resolve(tmpdir(), `ctxscribe-redirect-${sessionId}.txt`), "utf-8");
  }

  it("1.5MB file: shipped hook denies with ~0.6KB JSON instead of a 1.5MB payload", () => {
    const ctx = livefireSetup(BIG);
    const started = performance.now();
    const r = runPre(ctx, { file_path: ctx.file });
    const elapsedMs = performance.now() - started;
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("ctx_execute_file");
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThan(2_048);
    expect(markerOf(ctx.sessionId).startsWith(`Read:large-read-denied:${BIG}:`)).toBe(true);
    console.log(`[livefire] 1.5MB deny: ${elapsedMs.toFixed(1)}ms, stdout ${Buffer.byteLength(r.stdout, "utf8")}B vs ${BIG}B payload`);
  });

  it("deny marker survives the windowed retry (telemetry fix, Codex finding 1)", () => {
    const ctx = livefireSetup(BIG);
    const denied = runPre(ctx, { file_path: ctx.file });
    expect(JSON.parse(denied.stdout)?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const retry = runPre(ctx, { file_path: ctx.file, offset: 1, limit: 100 });
    expect(retry.status).toBe(0);
    if (retry.stdout.trim() !== "") {
      expect(JSON.parse(retry.stdout)?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    }
    expect(markerOf(ctx.sessionId).startsWith(`Read:large-read-denied:${BIG}:`)).toBe(true);
  });

  it("kill-switch reaches the shipped hook (CONTEXT_MODE_LARGE_READ_GUARD=0 → no deny)", () => {
    const ctx = livefireSetup(BIG);
    const r = runPre(ctx, { file_path: ctx.file }, { env: { CONTEXT_MODE_LARGE_READ_GUARD: "0" } });
    expect(r.status).toBe(0);
    if (r.stdout.trim() !== "") {
      expect(JSON.parse(r.stdout)?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    }
  });

  it("subagent payload is exempt through the shipped hook (R1 parity)", () => {
    const ctx = livefireSetup(BIG);
    const r = runPre(ctx, { file_path: ctx.file }, { payload: { agent_id: "sub-1", agent_type: "general-purpose" } });
    expect(r.status).toBe(0);
    if (r.stdout.trim() !== "") {
      expect(JSON.parse(r.stdout)?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    }
  });
});
```

- [ ] **Step 2: Verify the subagent wiring assumption**

Run: `grep -n "agent_id\|agent_type\|isSubagent" hooks/pretooluse.mjs` (via the Grep tool).
If `pretooluse.mjs` derives `isSubagent` from different payload fields, adjust the subagent test's `payload` to the real contract. If it does NOT thread `isSubagent` into `routePreToolUse`'s options at all, extend it minimally to do so (mirror how R1's `isSubagent` reaches `evaluateReadGuard`).

- [ ] **Step 3: Run the livefire block**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: PASS (17 tests). If the marker assertion fails, check `pretooluse.mjs:209-224` (marker write from `decision.redirectMeta`).

- [ ] **Step 4: Add the latency case**

In `tests/hooks/hook-latency.test.ts`: `PRETOOL_CASES` starts at line 75. Before the declaration, create a > 1 MiB file; add a case; clean up in `afterAll` (import `afterAll` from vitest if missing):

```ts
// R3 large-read deny path — must stay inside the same p95 budget (stat-only).
const r3BigFile = resolve(_sentinelDir, `ctxscribe-r3-latency-${process.pid}.txt`);
writeFileSync(r3BigFile, "x".repeat(1_200_000), "utf-8");
```

```ts
  { name: "Read large file (R3 deny)", tool: "Read", input: { file_path: r3BigFile } },
```

```ts
afterAll(() => {
  try { unlinkSync(r3BigFile); } catch {}
});
```

- [ ] **Step 5: Run the latency suite**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/hook-latency.test.ts --pool=forks --maxWorkers=1`
Expected: PASS — R3 deny path p95 < 3 ms (stat + Set lookup only).

- [ ] **Step 6: Commit**

```bash
npm run build && git add -A && git commit -m "test(hooks): R3 livefire child-spawn, marker-survival, latency budget"
```

---

### Task 4: docs — ADR-0008 amendment, CLAUDE.md, spec already updated

**Files:**
- Modify: `docs/adr/0008-what-actually-saves-context.md` (append R3 amendment — read the file's existing R1 amendment format first and match it)
- Modify: `CLAUDE.md` (`### Read (for analysis)` section)

- [ ] **Step 1: Append the R3 amendment to ADR-0008**

Read the tail of `docs/adr/0008-what-actually-saves-context.md` (the R1 amendment section) and append a matching section. Content requirements (adapt wording to the file's format):

- Title: `## Amendment (2026-07-17): R3 large-read guard — adopted at > 1 MiB`
- Decision: deny full-file Reads of text files > `LARGE_READ_GUARD_BYTES` (= `MAX_INDEX_FILE_BYTES`, 1 MiB) — exactly the band R1 can never index; kill-switch `CONTEXT_MODE_LARGE_READ_GUARD=0`; subagents and windowed reads exempt; `VISUAL_READ_EXTS` (`.png .jpg .jpeg .gif .webp .bmp .ico .pdf .ipynb`) exempt; priority R1 → R3 → 50 KB nudge.
- Codex adversarial disposition (2026-07-17): original > 100 KB scope rejected — recall regression for the 100 KB–1 MiB R1 band and unmeasured eligible slice; telemetry-overwrite finding adopted (windowed reads no longer attach `read-redirected` redirectMeta — also fixes the pre-existing whole-file `bytes_avoided` overcount); subagent + `.ipynb` exemptions adopted; presence-only windowed predicate kept for R1 parity (residual: `offset:0, limit:huge` passes; current Claude Code rejects over-limit ranges at the tool layer).
- Threshold-lowering preconditions: a raw-source recall path for denied files (marker-delegated indexing) OR a corpus dry-run with defined retry/abandonment ceilings.
- Honest sizing: the > 1 MiB slice was not separately measured; primary value = eliminating a guaranteed-fatal call class (1 MB ≈ 269K tok) + first-ever coverage for the unindexable band; real effect measured post-deploy via `large-read-denied` `bytes_avoided` events.
- Residuals: parallel-call redirect markers are last-write-wins (pre-existing, all redirect types); denied files have no FTS5 recall (nothing to lose above 1 MiB today).

- [ ] **Step 2: Add the CLAUDE.md line**

In `CLAUDE.md`, section `### Read (for analysis)`, append one line:

```markdown
Full Read of a >1MiB text file → denied with a recipe (`ctx_execute_file` for analysis, offset/limit windowed Read for editing). `CONTEXT_MODE_LARGE_READ_GUARD=0` disables.
```

- [ ] **Step 3: Build gates + commit**

```bash
npm run build && git add -A && git commit -m "docs: ADR-0008 R3 amendment (>1MiB) + CLAUDE.md large-read rule"
```

---

### Task 5: PR, CI, merge

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/r3-large-read-guard
gh pr create --title "feat(hooks): ADR-0008 R3 — large-read guard (>1MiB full Read deny)" --body "<summary + spec/ADR links + Codex disposition + livefire numbers>"
```

- [ ] **Step 2: Watch the fresh CI run (not a stale one)**

```bash
gh run list --branch feat/r3-large-read-guard --limit 3   # grab the NEW run id
gh run watch <id> --exit-status
```

- [ ] **Step 3: Merge after green**

```bash
gh pr list --state open   # confirm no dependent PRs
gh pr merge <n> --squash --delete-branch
git checkout main && git pull origin main
```

## Self-review notes

- Spec coverage: discriminating tests 1-9 → Task 1 (1,2,3,5,6,7 unit + threshold-alignment), Task 2 (4, 8, 9-first-half, integration), Task 3 (9-second-half marker survival, livefire, subagent, latency). Docs → Task 4 + spec (already revised). All spec sections covered.
- The `evaluateReadGuard` refactor (isWindowedRead) is behavior-preserving; guarded by `r1-readstate.test.ts` + `r1-read-guard.test.ts` in Task 1 Step 5.
- The nudge accounting fix intentionally changes behavior for windowed reads of > 50 KB files (no more redirectMeta) — covered by an explicit test in Task 2 and the `redirect-marker-read.test.ts` regression run (full reads only, unaffected).
- No placeholders; every step has runnable code/commands.
