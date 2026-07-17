/**
 * R1 passive indexing orchestrator (hooks/core/toolindex.mjs) — unit level
 * with injected store/security deps. Hook-process integration is covered by
 * r1-posttooluse-index.test.ts.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(__dirname, "..", "..", "hooks", "core", "toolindex.mjs");
const READSTATE_PATH = resolve(__dirname, "..", "..", "hooks", "core", "readstate.mjs");

let ti: any;
let rs: any;
const cleanups: Array<() => void> = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build a projectDir + big text file + fake store deps. */
function setup(opts: { fileName?: string; content?: string; denied?: boolean; sources?: number; meta?: any } = {}) {
  const projectDir = tempDir("r1-ti-proj-");
  const file = join(projectDir, opts.fileName ?? "big.ts");
  writeFileSync(file, opts.content ?? "const x = 1;\n".repeat(500), "utf-8"); // ~6.5KB
  const dbPath = join(projectDir, "content.db");
  writeFileSync(dbPath, "fake-db", "utf-8");

  const store = {
    index: vi.fn(() => ({ chunks: 3 })),
    getSourceMeta: vi.fn(() => opts.meta ?? null),
    listSources: vi.fn(() => new Array(opts.sources ?? 0).fill({ label: "s", chunkCount: 1 })),
    close: vi.fn(),
  };
  const deps = {
    openStore: () => ({ store, dbPath }),
    security: {
      readToolDenyPatterns: () => [],
      evaluateFilePath: () => ({ denied: opts.denied ?? false }),
    },
  };
  const sessionId = randomUUID();
  cleanups.push(() => { try { unlinkSync(rs.statePath(sessionId)); } catch { /* gone */ } });
  return { projectDir, file, dbPath, store, deps, sessionId };
}

function readInput(file: string, extra: any = {}) {
  return {
    session_id: "ignored-here",
    tool_name: "Read",
    tool_input: { file_path: file, ...(extra.tool_input ?? {}) },
    tool_response: { type: "text", text: "n".repeat(5000) },
    ...extra.top,
  };
}

beforeAll(async () => {
  rs = await import(pathToFileURL(READSTATE_PATH).href);
  ti = await import(pathToFileURL(MODULE_PATH).href);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.CONTEXT_MODE_TOOL_INDEX;
});

describe("toolindex: skip gates", () => {
  it("ignores non-Read tools (Bash deferred from R1)", async () => {
    const { projectDir, deps, sessionId } = setup();
    const input = { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x".repeat(9000) };
    expect(await ti.maybeIndexToolResult({ input, projectDir, sessionId, deps })).toBeNull();
  });

  it("honors the CONTEXT_MODE_TOOL_INDEX kill switch", async () => {
    const { projectDir, file, deps, sessionId } = setup();
    process.env.CONTEXT_MODE_TOOL_INDEX = "0";
    expect(await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps })).toBeNull();
  });

  it("skips windowed reads entirely", async () => {
    const { projectDir, file, store, deps, sessionId } = setup();
    const r = await ti.maybeIndexToolResult({ input: readInput(file, { tool_input: { offset: 5 } }), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("windowed");
    expect(store.index).not.toHaveBeenCalled();
    expect(rs.lookupEntry(sessionId, file)).toBeNull();
  });

  it("skips small responses (<=4096 bytes)", async () => {
    const { projectDir, file, store, deps, sessionId } = setup();
    const input = readInput(file);
    input.tool_response = { type: "text", text: "s".repeat(4096) };
    const r = await ti.maybeIndexToolResult({ input, projectDir, sessionId, deps });
    expect(r?.skipped).toBe("small");
    expect(store.index).not.toHaveBeenCalled();
  });

  it("skips files outside the project directory", async () => {
    const { projectDir, deps, sessionId } = setup();
    const outside = tempDir("r1-ti-out-");
    const file = join(outside, "elsewhere.ts");
    writeFileSync(file, "const y = 2;\n".repeat(500), "utf-8");
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("outside-project");
  });

  it("skips sensitive basenames regardless of user patterns", async () => {
    const { projectDir, deps, sessionId } = setup();
    const file = join(projectDir, ".env.production");
    writeFileSync(file, "SECRET=".padEnd(5000, "x"), "utf-8");
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("sensitive");
  });

  it("skips binary content (NUL sniff or extension)", async () => {
    const { projectDir, deps, sessionId } = setup();
    const file = join(projectDir, "blob.dat");
    writeFileSync(file, Buffer.concat([Buffer.from("a".repeat(5000)), Buffer.from([0, 1, 2])]));
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("binary");

    const png = join(projectDir, "img.png");
    writeFileSync(png, "not-really-binary".repeat(400), "utf-8");
    const r2 = await ti.maybeIndexToolResult({ input: readInput(png), projectDir, sessionId, deps });
    expect(r2?.skipped).toBe("binary");
  });

  it("skips paths matching user Read deny patterns", async () => {
    const { projectDir, file, deps, sessionId } = setup({ denied: true });
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("denied");
  });

  it("skips new sources past the global source cap", async () => {
    const { projectDir, file, deps, sessionId } = setup({ sources: 800 });
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("global-cap");
  });

  it("skips files above the 1MiB index cap", async () => {
    const { projectDir, deps, sessionId } = setup();
    const file = join(projectDir, "huge.txt");
    writeFileSync(file, "h".repeat(1_048_577), "utf-8");
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("too-large");
  });

  it("skips new indexing when the session cap is exhausted", async () => {
    const { projectDir, file, deps, sessionId } = setup();
    writeFileSync(rs.statePath(sessionId), JSON.stringify({ entries: {}, files: 300, bytes: 0 }), "utf-8");
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r?.skipped).toBe("session-cap");
  });
});

describe("toolindex: indexing + recording", () => {
  it("indexes a full-file Read and records the sidecar entry", async () => {
    const { projectDir, file, dbPath, store, deps, sessionId } = setup();
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir, sessionId, deps });
    expect(r).toMatchObject({ indexed: true, recorded: true });
    expect(store.index).toHaveBeenCalledWith(expect.objectContaining({
      path: resolve(file),
      attribution: { sessionId },
    }));
    expect(store.close).toHaveBeenCalled();

    const entry = rs.lookupEntry(sessionId, file);
    expect(entry).not.toBeNull();
    expect(entry.dbPath).toBe(dbPath);
    expect(entry.dbFileId).toBe(rs.fileIdOf(dbPath));
  });

  it("skips re-indexing on same content hash but still records", async () => {
    const first = setup();
    // Prime: compute the real hash by doing a full pass once.
    await ti.maybeIndexToolResult({ input: readInput(first.file), projectDir: first.projectDir, sessionId: first.sessionId, deps: first.deps });
    const hash = rs.lookupEntry(first.sessionId, first.file)!.hash;

    const second = setup({ meta: { contentHash: hash } });
    // Same file content lives in second.projectDir's own file — rebuild it to match first's content? Instead reuse first's file with second's deps.
    const r = await ti.maybeIndexToolResult({
      input: readInput(first.file),
      projectDir: first.projectDir,
      sessionId: second.sessionId,
      deps: { ...second.deps, openStore: () => ({ store: second.store, dbPath: second.dbPath }) },
    });
    expect(r).toMatchObject({ indexed: false, recorded: true, skipped: "same-hash" });
    expect(second.store.index).not.toHaveBeenCalled();
    expect(rs.lookupEntry(second.sessionId, first.file)).not.toBeNull();
  });

  it("indexes subagent reads without recording a guard entry, but still counts volume", async () => {
    const { projectDir, file, store, deps, sessionId } = setup();
    const input = readInput(file, { top: { agent_id: "a-123", agent_type: "Explore" } });
    const r = await ti.maybeIndexToolResult({ input, projectDir, sessionId, deps });
    expect(r).toMatchObject({ indexed: true, recorded: false });
    expect(store.index).toHaveBeenCalled();
    expect(rs.lookupEntry(sessionId, file)).toBeNull();
    // Session caps must see subagent volume too, or one subagent could fill
    // the store to the global cap unchecked.
    expect(rs.readState(sessionId).bytes).toBeGreaterThan(0);
  });

  it("re-checks project containment and sensitivity against the symlink target", async () => {
    const { projectDir, deps, sessionId } = setup();
    const outside = tempDir("r1-ti-sym-");
    const secret = join(outside, "outside-credentials.txt");
    writeFileSync(secret, "TOKEN=".padEnd(6000, "x"), "utf-8");
    const link = join(projectDir, "notes.md"); // innocent lexical name inside the project
    const { symlinkSync } = await import("node:fs");
    try {
      symlinkSync(secret, link, "file");
    } catch {
      return; // no symlink privilege on this runner (win32 without Developer Mode) — covered on POSIX CI
    }
    const r = await ti.maybeIndexToolResult({ input: readInput(link), projectDir, sessionId, deps });
    expect(["outside-project", "sensitive"]).toContain(r?.skipped);
    expect(rs.lookupEntry(sessionId, link)).toBeNull();
  });

  it("indexes normally when the project dir itself is reached via a symlink (macOS /var→/private/var)", async () => {
    const { projectDir: realProject, deps, sessionId } = setup();
    const aliasParent = tempDir("r1-ti-alias-");
    const alias = join(aliasParent, "proj-link");
    const { symlinkSync } = await import("node:fs");
    try {
      symlinkSync(realProject, alias, "dir");
    } catch {
      return; // no symlink privilege on this runner — covered on POSIX CI
    }
    const file = join(alias, "via-alias.ts");
    writeFileSync(file, "export const alias = 1;\n".repeat(400), "utf-8");
    const r = await ti.maybeIndexToolResult({ input: readInput(file), projectDir: alias, sessionId, deps });
    expect(r).toMatchObject({ indexed: true, recorded: true });
  });
});
