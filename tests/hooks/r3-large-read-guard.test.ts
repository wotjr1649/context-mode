/**
 * ADR-0008 R3 large-read guard (> 1 MiB) — discriminating cases from
 * docs/superpowers/specs/2026-07-17-r3-large-read-guard-design.md.
 * Unit matrix first; routePreToolUse integration and livefire below.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, unlinkSync } from "node:fs";
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
