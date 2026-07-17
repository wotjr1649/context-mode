# R3 Large-Read Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deny full-file Reads (no `offset`/`limit`) of text files > 100 KB at PreToolUse, with a recipe redirecting to `ctx_execute_file` (analysis) or a windowed Read (editing).

**Architecture:** A stateless sibling of the R1 read-guard. `evaluateLargeReadGuard` lives in `hooks/core/readstate.mjs` (same module as `evaluateReadGuard`), is called from the Read branch of `hooks/core/routing.mjs` *after* the R1 guard and *before* the 50 KB nudge, reusing the nudge's `statSync`. No new state, no MCP-readiness gating (the windowed-Read escape hatch is a native tool), subagents skipped (R1 parity).

**Tech Stack:** hand-authored ESM hooks (`hooks/core/*.mjs`, node builtins only — PreToolUse must never load native modules), vitest tests in `tests/hooks/*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-07-17-r3-large-read-guard-design.md`

## Global Constraints

- Threshold: `LARGE_READ_GUARD_BYTES = 102_400`. Kill-switch: `CONTEXT_MODE_LARGE_READ_GUARD === "0"` disables.
- Every failure path fails OPEN (return `null`, never throw) — mirror `evaluateReadGuard`.
- Decision priority in the Read branch: R1 read-guard → R3 large-read guard → 50 KB nudge.
- `redirectMeta.type = "large-read-denied"` (existing marker → PostToolUse `redirect` event plumbing; no posttooluse change).
- Visual/media exemption: `.png .jpg .jpeg .gif .webp .bmp .ico .pdf .ipynb` pass (Read renders them; no ctx substitute). This is deliberately narrower than toolindex's `BINARY_EXTS` — a `.zip`/`.exe` full Read SHOULD be denied (ctx_execute_file analyzes those fine).
- Test runs are memory-capped, one file at a time: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run <file> --pool=forks --maxWorkers=1`.
- `npm run build` (5 assert gates) must pass before every commit; stage everything, single commit (pre-commit hook enforces worktree == index).
- File output: UTF-8 no BOM, LF.

---

### Task 1: `evaluateLargeReadGuard` in readstate.mjs (unit level)

**Files:**
- Modify: `hooks/core/readstate.mjs` (add exports; refactor `evaluateReadGuard:139` to use the shared predicate)
- Create: `tests/hooks/r3-large-read-guard.test.ts`

**Interfaces:**
- Produces: `isWindowedRead(toolInput): boolean`; `LARGE_READ_GUARD_BYTES = 102_400`; `evaluateLargeReadGuard({ toolInput, filePath, st, isSubagent }): {action:"deny",...} | null` — `st` is a `fs.Stats` already obtained by the caller (single stat).

- [ ] **Step 1: Write the failing unit tests**

Create `tests/hooks/r3-large-read-guard.test.ts`:

```ts
/**
 * ADR-0008 R3 large-read guard — discriminating cases from
 * docs/superpowers/specs/2026-07-17-r3-large-read-guard-design.md.
 * Unit matrix here; routePreToolUse integration in the next describe block.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTING_PATH = resolve(__dirname, "..", "..", "hooks", "core", "routing.mjs");
const READSTATE_PATH = resolve(__dirname, "..", "..", "hooks", "core", "readstate.mjs");

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

describe("evaluateLargeReadGuard unit matrix", () => {
  it("denies a full Read of a 120KB text file with the execute_file + windowed recipe", () => {
    const file = tmpFile("big.ts", 120_000);
    const d = rs.evaluateLargeReadGuard({ toolInput: { file_path: file }, filePath: file, st: statSync(file), isSubagent: false });
    expect(d?.action).toBe("deny");
    expect(d?.reason).toContain("ctx_execute_file");
    expect(d?.reason).toContain("offset");
    expect(d?.reason).toContain("NOT indexed");
    expect(d?.redirectMeta?.type).toBe("large-read-denied");
    expect(d?.redirectMeta?.bytesAvoided).toBe(120_000);
  });

  it("passes a windowed Read of the same file", () => {
    const file = tmpFile("big.ts", 120_000);
    const d = rs.evaluateLargeReadGuard({ toolInput: { file_path: file, offset: 10, limit: 50 }, filePath: file, st: statSync(file), isSubagent: false });
    expect(d).toBeNull();
  });

  it("passes a 60KB file (below threshold)", () => {
    const file = tmpFile("mid.ts", 60_000);
    const d = rs.evaluateLargeReadGuard({ toolInput: { file_path: file }, filePath: file, st: statSync(file), isSubagent: false });
    expect(d).toBeNull();
  });

  it("denies a 1.5MB text file (the band R1 can never index)", () => {
    const file = tmpFile("huge.log", 1_500_000);
    const d = rs.evaluateLargeReadGuard({ toolInput: { file_path: file }, filePath: file, st: statSync(file), isSubagent: false });
    expect(d?.action).toBe("deny");
    expect(d?.redirectMeta?.bytesAvoided).toBe(1_500_000);
  });

  it("passes visual files Read renders natively (.png, .pdf, .ipynb)", () => {
    for (const name of ["shot.png", "doc.pdf", "nb.ipynb"]) {
      const file = tmpFile(name, 200_000);
      const d = rs.evaluateLargeReadGuard({ toolInput: { file_path: file }, filePath: file, st: statSync(file), isSubagent: false });
      expect(d, name).toBeNull();
    }
  });

  it("passes when CONTEXT_MODE_LARGE_READ_GUARD=0", () => {
    process.env.CONTEXT_MODE_LARGE_READ_GUARD = "0";
    const file = tmpFile("big.ts", 120_000);
    const d = rs.evaluateLargeReadGuard({ toolInput: { file_path: file }, filePath: file, st: statSync(file), isSubagent: false });
    expect(d).toBeNull();
  });

  it("passes inside a subagent context (R1 parity)", () => {
    const file = tmpFile("big.ts", 120_000);
    const d = rs.evaluateLargeReadGuard({ toolInput: { file_path: file }, filePath: file, st: statSync(file), isSubagent: true });
    expect(d).toBeNull();
  });

  it("isWindowedRead matches the R1 predicate exactly", () => {
    expect(rs.isWindowedRead({})).toBe(false);
    expect(rs.isWindowedRead({ offset: 0 })).toBe(true);   // offset 0 is windowed-in-form
    expect(rs.isWindowedRead({ limit: 999_999 })).toBe(true);
    expect(rs.isWindowedRead(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: FAIL — `rs.evaluateLargeReadGuard is not a function`.

- [ ] **Step 3: Implement in readstate.mjs**

In `hooks/core/readstate.mjs`:

3a. Extend the path import (line 14) to include `extname`:

```js
import { resolve, join, extname } from "node:path";
```

3b. Below `MAX_INDEX_FILE_BYTES` (line 22), add:

```js
// ─── ADR-0008 R3 large-read guard ───
// Full-file Reads above this are denied outright (analysis → ctx_execute_file,
// editing → windowed Read). Distinct from the R1 read-guard: R1 needs an armed
// sidecar entry (so it only covers repeats of ≤1 MiB indexed files); R3 is
// stateless, so it also covers first reads and the >1 MiB band R1 never indexes.
export const LARGE_READ_GUARD_BYTES = 102_400;

// Read renders these visually (images/PDF) or as structured cells (ipynb) —
// no ctx tool substitutes for that, so the large-read guard lets them through.
// Deliberately narrower than toolindex BINARY_EXTS: an archive/binary full
// Read SHOULD be denied (ctx_execute_file analyzes those fine).
const VISUAL_READ_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".ipynb",
]);

/** The single definition of "windowed" shared by both Read guards. */
export function isWindowedRead(toolInput) {
  const ti = toolInput ?? {};
  return ti.offset != null || ti.limit != null;
}
```

3c. In `evaluateReadGuard`, replace the inline predicate (lines 138-139)

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
 * ADR-0008 R3: deny a full-file Read of a large text file. Stateless —
 * evaluated after the R1 read-guard (an armed re-read keeps R1's better
 * ctx_search recipe) and before the 50 KB nudge. `st` comes from the
 * caller's statSync so the Read branch stays at one stat syscall.
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

3e. Update the module header comment (lines 1-11) first line block to mention both guards:

```js
/**
 * R1/R3 read-guard sidecar state and guards (ADR-0008 amendments).
 *
 * R1: PostToolUse records each successfully indexed full-file Read here (per
 * session, main conversation only); the PreToolUse Read branch consults it
 * to deny byte-identical full-file re-reads with a recall recipe.
 * R3: stateless large-read guard — a full Read of a >100 KB text file is
 * denied with an execute_file/windowed recipe (evaluated after R1).
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
npm run build && git add -A && git commit -m "feat(hooks): ADR-0008 R3 — evaluateLargeReadGuard in readstate"
```

---

### Task 2: routing.mjs integration

**Files:**
- Modify: `hooks/core/routing.mjs:20` (import) and `:835-850` (Read branch)
- Modify: `tests/hooks/r3-large-read-guard.test.ts` (append integration describe block)

**Interfaces:**
- Consumes: `evaluateLargeReadGuard` from Task 1.
- Produces: `routePreToolUse("Read", {file_path: <big>}, ...)` → `{action:"deny", redirectMeta:{type:"large-read-denied"}}`.

- [ ] **Step 1: Append the failing integration tests**

Append to `tests/hooks/r3-large-read-guard.test.ts`:

```ts
/** Arm the R1 guard exactly like posttooluse would (copied from r1-read-guard.test.ts). */
function armedSetup(bytes = 120_000) {
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
  it("denies a first-ever full Read of a 120KB file", () => {
    const file = tmpFile("fresh.ts", 120_000);
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).toBe("deny");
    expect(d?.redirectMeta?.type).toBe("large-read-denied");
  });

  it("R1 read-guard wins for an armed unchanged file (better recipe first)", () => {
    const { file, sessionId } = armedSetup(120_000);
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", sessionId, { isSubagent: false });
    expect(d?.action).toBe("deny");
    expect(d?.redirectMeta?.type).toBe("read-guard-denied");
  });

  it("windowed Read of a large file falls through to existing behavior (not denied)", () => {
    const file = tmpFile("fresh.ts", 120_000);
    const d = routing.routePreToolUse("Read", { file_path: file, offset: 1, limit: 100 }, dirname(file), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).not.toBe("deny");
  });

  it("60KB file keeps the 50KB-nudge path (not denied)", () => {
    const file = tmpFile("mid.ts", 60_000);
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).not.toBe("deny");
  });

  it("nonexistent path is not denied (native Read error path preserved)", () => {
    const d = routing.routePreToolUse("Read", { file_path: join(tmpdir(), "r3-no-such-file-xyz.ts") }, tmpdir(), "claude-code", randomUUID(), { isSubagent: false });
    expect(d?.action).not.toBe("deny");
  });
});
```

- [ ] **Step 2: Run to verify the new block fails**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: unit block PASS, integration block FAIL (`d?.action` is `"context"`/undefined, not `"deny"`) — except the R1-wins case and the pass-through cases, which already pass.

- [ ] **Step 3: Wire the guard into routing.mjs**

3a. Extend `hooks/core/routing.mjs:20`:

```js
import { evaluateLargeReadGuard, evaluateReadGuard } from "./readstate.mjs";
```

3b. In the Read branch, insert the R3 evaluation between the stat and the nudge — replace lines 836-848 (`try { ... }` body):

```js
      try {
        const st = statSync(filePath);
        // ─── ADR-0008 R3 large-read guard ───
        // After the R1 read-guard (an armed re-read keeps R1's ctx_search
        // recall recipe), before the 50 KB nudge. Stateless; shares this stat.
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
          decision.redirectMeta = {
            tool: "Read",
            type: "read-redirected",
            bytesAvoided: st.size,
            commandSummary: String(filePath).slice(0, 200),
          };
          return decision;
        }
      } catch { /* file missing or unreadable — fall through to plain guidance */ }
```

- [ ] **Step 4: Run to verify all pass**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: PASS (13 tests).

- [ ] **Step 5: Regression check the routing suite**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/core-routing.test.ts --pool=forks --maxWorkers=1`
Then: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/redirect-marker-read.test.ts --pool=forks --maxWorkers=1`
Expected: PASS both. (`redirect-marker-read` uses an 80 KB file — below the R3 threshold, so slices 4.4-4.6 are unaffected.)

- [ ] **Step 6: Commit**

```bash
npm run build && git add -A && git commit -m "feat(hooks): ADR-0008 R3 — wire large-read guard into the Read branch"
```

---

### Task 3: livefire — real hook child + latency budget

**Files:**
- Modify: `tests/hooks/r3-large-read-guard.test.ts` (append livefire describe block)
- Modify: `tests/hooks/hook-latency.test.ts` (add one PRETOOL case for the deny path)

**Interfaces:**
- Consumes: `hooks/pretooluse.mjs` stdin contract `{session_id, tool_name, tool_input}` + env (`CLAUDE_PROJECT_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_SESSION_ID`, `HOME`/`USERPROFILE`, `CONTEXT_MODE_SESSION_SUFFIX: ""`) — recipe from `tests/hooks/redirect-marker-read.test.ts:113-124`.
- Produces: proof that the shipped hook process emits the deny JSON (~0.6 KB) instead of a 200 KB / 1.5 MB payload, and that the marker for PostToolUse accounting is written.

- [ ] **Step 1: Append the failing livefire tests**

Append to `tests/hooks/r3-large-read-guard.test.ts` (extend the existing imports with `spawnSync` from `node:child_process` and `existsSync`, `mkdirSync` from `node:fs`):

```ts
describe("R3 livefire — real pretooluse.mjs child process", () => {
  const PRETOOL_PATH = resolve(__dirname, "..", "..", "hooks", "pretooluse.mjs");

  function runPre(filePath: string, sessionId: string, fakeHome: string, fakeProject: string) {
    return spawnSync("node", [PRETOOL_PATH], {
      input: JSON.stringify({ session_id: sessionId, tool_name: "Read", tool_input: { file_path: filePath } }),
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CONFIG_DIR: join(fakeHome, ".claude"),
        CLAUDE_PROJECT_DIR: fakeProject,
        CLAUDE_SESSION_ID: sessionId,
        CONTEXT_MODE_SESSION_SUFFIX: "",
      },
    });
  }

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

  it("200KB file: shipped hook denies with ~0.6KB JSON instead of a 200KB payload", () => {
    const { file, sessionId, fakeHome, fakeProject } = livefireSetup(200_000);
    const started = performance.now();
    const r = runPre(file, sessionId, fakeHome, fakeProject);
    const elapsedMs = performance.now() - started;
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("ctx_execute_file");
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThan(2_048);
    // marker for PostToolUse byte accounting
    const marker = readFileSync(resolve(tmpdir(), `ctxscribe-redirect-${sessionId}.txt`), "utf-8");
    expect(marker.startsWith("Read:large-read-denied:200000:")).toBe(true);
    // wall-clock sanity for the report (spawn + parse + stat), not an assert gate
    console.log(`[livefire] 200KB deny: ${elapsedMs.toFixed(1)}ms, stdout ${Buffer.byteLength(r.stdout, "utf8")}B vs 200000B payload`);
  });

  it("1.5MB file (R1-unindexable band): shipped hook denies", () => {
    const { file, sessionId, fakeHome, fakeProject } = livefireSetup(1_500_000);
    const r = runPre(file, sessionId, fakeHome, fakeProject);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const marker = readFileSync(resolve(tmpdir(), `ctxscribe-redirect-${sessionId}.txt`), "utf-8");
    expect(marker.startsWith("Read:large-read-denied:1500000:")).toBe(true);
  });

  it("kill-switch reaches the shipped hook (CONTEXT_MODE_LARGE_READ_GUARD=0 → no deny)", () => {
    const { file, sessionId, fakeHome, fakeProject } = livefireSetup(200_000);
    const r = spawnSync("node", [PRETOOL_PATH], {
      input: JSON.stringify({ session_id: sessionId, tool_name: "Read", tool_input: { file_path: file } }),
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_CONFIG_DIR: join(fakeHome, ".claude"),
        CLAUDE_PROJECT_DIR: fakeProject,
        CLAUDE_SESSION_ID: sessionId,
        CONTEXT_MODE_SESSION_SUFFIX: "",
        CONTEXT_MODE_LARGE_READ_GUARD: "0",
      },
    });
    expect(r.status).toBe(0);
    if (r.stdout.trim() !== "") {
      const out = JSON.parse(r.stdout);
      expect(out?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    }
  });
});
```

- [ ] **Step 2: Run to verify livefire passes against the wired guard**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/r3-large-read-guard.test.ts --pool=forks --maxWorkers=1`
Expected: PASS (16 tests). If the marker line fails, check `pretooluse.mjs:209-224` marker write — the deny path must carry `redirectMeta` through (it does for R1's `read-guard-denied`; same shape).

- [ ] **Step 3: Add the latency case**

In `tests/hooks/hook-latency.test.ts`, the `PRETOOL_CASES` array (starts line 75) contains entries like `{ name: "Read file", tool: "Read", input: { file_path: "/tmp/test.ts" } }`. Add a real >100 KB file case. Before the `PRETOOL_CASES` declaration, add:

```ts
// R3 large-read deny path — must stay inside the same p95 budget (stat-only).
const r3BigFile = resolve(_sentinelDir, `ctxscribe-r3-latency-${process.pid}.txt`);
writeFileSync(r3BigFile, "x".repeat(150_000), "utf-8");
```

And add to `PRETOOL_CASES`:

```ts
  { name: "Read large file (R3 deny)", tool: "Read", input: { file_path: r3BigFile } },
```

Clean up after (find the existing cleanup/afterAll in the file; if none for files, append):

```ts
afterAll(() => {
  try { unlinkSync(r3BigFile); } catch {}
});
```

(Import `afterAll` from vitest if not already imported.)

- [ ] **Step 4: Run the latency suite**

Run: `NODE_OPTIONS=--max-old-space-size=2048 npx vitest run tests/hooks/hook-latency.test.ts --pool=forks --maxWorkers=1`
Expected: PASS — R3 deny path p95 < 3 ms (stat + Set lookup only).

- [ ] **Step 5: Commit**

```bash
npm run build && git add -A && git commit -m "test(hooks): R3 livefire child-spawn + latency budget case"
```

---

### Task 4: docs — ADR-0008 amendment, CLAUDE.md, spec status

**Files:**
- Modify: `docs/adr/0008-what-actually-saves-context.md` (append R3 amendment — read the file's existing amendment format first and match it)
- Modify: `CLAUDE.md` (`### Read (for analysis)` section)
- Modify: `docs/superpowers/specs/2026-07-17-r3-large-read-guard-design.md` (status line)

- [ ] **Step 1: Append the R3 amendment to ADR-0008**

Read the tail of `docs/adr/0008-what-actually-saves-context.md` (the R1 amendment section) and append a matching section. Content requirements (adapt wording to the file's format):

- Title: `## Amendment (2026-07-17): R3 large-read guard — adopted`
- Decision: deny full-file Reads of text files > `LARGE_READ_GUARD_BYTES = 102_400`; kill-switch `CONTEXT_MODE_LARGE_READ_GUARD=0`; subagents and windowed reads exempt; visual exts (`.png .jpg .jpeg .gif .webp .bmp .ico .pdf .ipynb`) exempt; priority R1 → R3 → 50 KB nudge.
- Rejected alternatives: warn-once pass (saves ~0 — R1 already denies repeats), marker-delegated indexing (cross-hook state; revisit on telemetry), `permissionDecision:"ask"` (blocks autonomous flows).
- Honest sizing: 20 KB-cap corpus modeling bounded 4.02–8.03 MB/62d; the > 100 KB slice is smaller and unmeasured; primary value = tail-risk cap (1 MB Read ≈ 269 K tok) + the > 1 MiB band R1 never indexes; real effect measured post-deploy via `large-read-denied` `bytes_avoided` events.
- Residual: denied 100 KB–1 MiB first-reads are not FTS5-indexed (no `ctx_search` recall; `ctx_execute_file` covers derivation). Subagent enforcement deferred.

- [ ] **Step 2: Add the CLAUDE.md line**

In `CLAUDE.md`, section `### Read (for analysis)`, append one line:

```markdown
Full Read of a >100KB text file → denied with a recipe (`ctx_execute_file` for analysis, offset/limit windowed Read for editing). `CONTEXT_MODE_LARGE_READ_GUARD=0` disables.
```

- [ ] **Step 3: Flip the spec status**

In `docs/superpowers/specs/2026-07-17-r3-large-read-guard-design.md`, change `Status: draft (pending Codex adversarial review)` to `Status: accepted (Codex adversarial review passed 2026-07-17)` — only after the Codex verdict actually lands; incorporate any accepted findings first.

- [ ] **Step 4: Build gates + commit**

```bash
npm run build && git add -A && git commit -m "docs: ADR-0008 R3 amendment + CLAUDE.md large-read rule"
```

---

### Task 5: PR, CI, merge

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/r3-large-read-guard
gh pr create --title "feat(hooks): ADR-0008 R3 — large-read guard (>100KB full Read deny)" --body "<summary + spec/ADR links + livefire numbers>"
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

- Spec coverage: discriminating tests 1-9 → Task 1 (1,2,3,5,6,7 unit + 9 implicit), Task 2 (4, 8, integration 1-3), Task 3 (livefire + latency). Docs → Task 4. All spec sections covered.
- The `evaluateReadGuard` refactor (isWindowedRead) is behavior-preserving; guarded by `r1-readstate.test.ts` + `r1-read-guard.test.ts` in Task 1 Step 5.
- No placeholders; every step has runnable code/commands.
