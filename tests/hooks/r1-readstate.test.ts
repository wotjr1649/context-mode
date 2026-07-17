/**
 * R1 read-guard sidecar state (hooks/core/readstate.mjs) — ADR-0008 R1 amendment.
 *
 * Discriminating cases (design v2):
 *  - record → lookup roundtrip, TTL expiry, corrupted-sidecar fail-open
 *  - evaluateReadGuard deny/allow matrix incl. store-identity invalidation
 *    (purge/regen → allow) and mtime-preserving edit (hash mismatch → allow).
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(__dirname, "..", "..", "hooks", "core", "readstate.mjs");

// Plain .mjs module — no type declarations; loaded via file URL like
// ensure-deps.test.ts does.
let rs: any;
const cleanups: Array<() => void> = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Create a fake content-store db file and return {dbPath, dbFileId}. */
function makeDbFile(dir: string): { dbPath: string; dbFileId: string } {
  const dbPath = join(dir, "content.db");
  writeFileSync(dbPath, "fake-sqlite", "utf-8");
  const id = rs.fileIdOf(dbPath);
  if (!id) throw new Error("fileIdOf returned null for existing file");
  return { dbPath, dbFileId: id };
}

/** Record a full read for a real file and return everything the guard needs. */
function recordFor(sessionId: string, filePath: string, dbInfo: { dbPath: string; dbFileId: string }) {
  const st = statSync(filePath);
  const content = readFileSync(filePath, "utf-8");
  rs.recordFullRead(sessionId, filePath, {
    hash: sha256(content),
    size: st.size,
    mtimeMs: st.mtimeMs,
    dbPath: dbInfo.dbPath,
    dbFileId: dbInfo.dbFileId,
  });
  cleanups.push(() => { try { unlinkSync(rs.statePath(sessionId)); } catch { /* gone */ } });
}

beforeAll(async () => {
  rs = await import(pathToFileURL(MODULE_PATH).href);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.CONTEXT_MODE_READ_GUARD;
});

describe("readstate: record/lookup", () => {
  it("roundtrips a recorded full read", () => {
    const dir = tempDir("r1-rs-");
    const file = join(dir, "big.txt");
    writeFileSync(file, "x".repeat(5000), "utf-8");
    const db = makeDbFile(dir);
    const sid = randomUUID();

    recordFor(sid, file, db);

    const entry = rs.lookupEntry(sid, file);
    expect(entry).not.toBeNull();
    expect(entry!.size).toBe(5000);
    expect(entry!.hash).toBe(sha256("x".repeat(5000)));
    expect(entry!.dbPath).toBe(db.dbPath);
    expect(entry!.dbFileId).toBe(db.dbFileId);
  });

  it("returns empty state on corrupted sidecar and lookups fail open", () => {
    const sid = randomUUID();
    writeFileSync(rs.statePath(sid), "{ not json !!!", "utf-8");
    cleanups.push(() => { try { unlinkSync(rs.statePath(sid)); } catch { /* gone */ } });

    expect(rs.readState(sid).files).toBe(0);
    expect(rs.lookupEntry(sid, join(tmpdir(), "whatever.txt"))).toBeNull();
  });

  it("expires entries older than the TTL", () => {
    const dir = tempDir("r1-rs-");
    const file = join(dir, "old.txt");
    writeFileSync(file, "y".repeat(4200), "utf-8");
    const db = makeDbFile(dir);
    const sid = randomUUID();
    recordFor(sid, file, db);

    // Rewrite the sidecar with a 49h-old timestamp.
    const raw = JSON.parse(readFileSync(rs.statePath(sid), "utf-8"));
    const key = Object.keys(raw.entries)[0];
    raw.entries[key].ts = Date.now() - 49 * 60 * 60 * 1000;
    writeFileSync(rs.statePath(sid), JSON.stringify(raw), "utf-8");

    expect(rs.lookupEntry(sid, file)).toBeNull();
  });

  it("canonicalKey folds case and separators on win32 only", () => {
    const a = rs.canonicalKey("C:\\Repo\\File.TXT");
    const b = rs.canonicalKey("C:/repo/file.txt");
    if (process.platform === "win32") {
      expect(a).toBe(b);
    } else {
      expect(a).not.toBe(b);
    }
  });

  it("re-recording an existing entry replaces its byte contribution", () => {
    const dir = tempDir("r1-rs-");
    const file = join(dir, "rerecorded.txt");
    writeFileSync(file, "a".repeat(6000), "utf-8");
    const db = makeDbFile(dir);
    const sid = randomUUID();
    recordFor(sid, file, db);
    recordFor(sid, file, db); // e.g. re-read after Edit — must replace, not accumulate
    const state = rs.readState(sid);
    expect(state.files).toBe(1);
    expect(state.bytes).toBe(6000);
  });

  it("recordVolume counts bytes without creating a guard entry", () => {
    const sid = randomUUID();
    cleanups.push(() => { try { unlinkSync(rs.statePath(sid)); } catch { /* gone */ } });
    rs.recordVolume(sid, 5000);
    rs.recordVolume(sid, 7000);
    const state = rs.readState(sid);
    expect(state.bytes).toBe(12000);
    expect(Object.keys(state.entries)).toHaveLength(0);
  });

  it("capExceeded gates on file count and byte volume", () => {
    expect(rs.capExceeded({ entries: {}, files: 0, bytes: 0 }, 1000)).toBe(false);
    expect(rs.capExceeded({ entries: {}, files: 300, bytes: 0 }, 1000)).toBe(true);
    expect(rs.capExceeded({ entries: {}, files: 1, bytes: 25_165_824 }, 1)).toBe(true);
  });
});

describe("readstate: evaluateReadGuard", () => {
  function setup() {
    const dir = tempDir("r1-guard-");
    const file = join(dir, "guarded.txt");
    writeFileSync(file, "z".repeat(6000), "utf-8");
    const db = makeDbFile(dir);
    const sid = randomUUID();
    recordFor(sid, file, db);
    return { dir, file, db, sid };
  }

  it("denies an identical full-file re-read with recipe and redirectMeta", () => {
    const { file, sid } = setup();
    const d = rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: sid, isSubagent: false });
    expect(d).not.toBeNull();
    expect(d!.action).toBe("deny");
    expect(d!.reason).toContain(resolve(file));
    expect(d!.reason).toContain("offset");
    expect(d!.redirectMeta).toMatchObject({ tool: "Read", type: "read-guard-denied", bytesAvoided: 6000 });
  });

  it("allows windowed reads (offset or limit present)", () => {
    const { file, sid } = setup();
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file, offset: 10 }, filePath: file, sessionId: sid, isSubagent: false })).toBeNull();
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file, limit: 5 }, filePath: file, sessionId: sid, isSubagent: false })).toBeNull();
  });

  it("allows subagent reads and first reads", () => {
    const { file, sid } = setup();
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: sid, isSubagent: true })).toBeNull();
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: randomUUID(), isSubagent: false })).toBeNull();
  });

  it("allows when the kill switch is set", () => {
    const { file, sid } = setup();
    process.env.CONTEXT_MODE_READ_GUARD = "0";
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: sid, isSubagent: false })).toBeNull();
  });

  it("allows after the file changes (size/mtime)", () => {
    const { file, sid } = setup();
    writeFileSync(file, "z".repeat(6001), "utf-8");
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: sid, isSubagent: false })).toBeNull();
  });

  it("allows on a content change that preserves size and mtime (hash mismatch)", () => {
    const { file, sid } = setup();
    writeFileSync(file, "w".repeat(6000), "utf-8");
    // Patch the sidecar to match the file's CURRENT stat while keeping the
    // original hash — isolates the hash comparison deterministically.
    const st = statSync(file);
    const raw = JSON.parse(readFileSync(rs.statePath(sid), "utf-8"));
    const key = Object.keys(raw.entries)[0];
    raw.entries[key].size = st.size;
    raw.entries[key].mtimeMs = st.mtimeMs;
    writeFileSync(rs.statePath(sid), JSON.stringify(raw), "utf-8");
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: sid, isSubagent: false })).toBeNull();
  });

  it("allows when the content store db is gone or recreated (purge safety)", () => {
    const { file, db, sid } = setup();
    unlinkSync(db.dbPath);
    expect(rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: sid, isSubagent: false })).toBeNull();

    // Recreate the db file — new identity must still invalidate the record.
    writeFileSync(db.dbPath, "fake-sqlite-v2", "utf-8");
    const recreated = rs.evaluateReadGuard({ toolInput: { file_path: file }, filePath: file, sessionId: sid, isSubagent: false });
    if (rs.fileIdOf(db.dbPath) !== db.dbFileId) {
      expect(recreated).toBeNull();
    } else {
      // Exotic FS where ino+birthtime are both unavailable — documented residual.
      expect(recreated).not.toBeNull();
    }
  });
});
