/**
 * R1 read-guard routing integration (discriminating cases ③ ④ at the
 * routePreToolUse level — the deny/allow matrix itself is unit-tested in
 * r1-readstate.test.ts).
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
  while (cleanups.length) cleanups.pop()!();
});

/** Arm the guard exactly like posttooluse would: big file + sidecar record. */
function armedSetup() {
  const dir = mkdtempSync(join(tmpdir(), "r1-rg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "armed.ts");
  writeFileSync(file, "export const armed = true; // pad\n".repeat(2000), "utf-8"); // ~68KB > 50KB nudge threshold
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

describe("R1 read-guard inside routePreToolUse", () => {
  it("denies an armed full-file re-read, taking precedence over the 50KB nudge", () => {
    const { file, sessionId } = armedSetup();
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", sessionId, { isSubagent: false });
    expect(d?.action).toBe("deny");
    expect(d?.reason).toContain(resolve(file));
    expect(d?.redirectMeta?.type).toBe("read-guard-denied");
  });

  it("never denies inside a subagent context", () => {
    const { file, sessionId } = armedSetup();
    const d = routing.routePreToolUse("Read", { file_path: file }, dirname(file), "claude-code", sessionId, { isSubagent: true });
    expect(d?.action).not.toBe("deny");
  });

  it("falls through to existing behavior for windowed reads", () => {
    const { file, sessionId } = armedSetup();
    const d = routing.routePreToolUse("Read", { file_path: file, offset: 100 }, dirname(file), "claude-code", sessionId, { isSubagent: false });
    expect(d?.action).not.toBe("deny");
  });
});
