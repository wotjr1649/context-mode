/**
 * R1 hook-process integration (discriminating cases ① ②) — spawns the real
 * hooks/posttooluse.mjs with stdin JSON and asserts against the real
 * per-project ContentStore db (raw better-sqlite3, no store API guessing).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, "..", "..", "hooks", "posttooluse.mjs");
const READSTATE_PATH = resolve(__dirname, "..", "..", "hooks", "core", "readstate.mjs");

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHookChild(input: unknown, configDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    const killer = setTimeout(() => { child.kill(); reject(new Error(`hook child timed out; stderr=${stderr}`)); }, 25_000);
    child.on("close", (code) => { clearTimeout(killer); resolvePromise({ code, stdout, stderr }); });
    child.on("error", (err) => { clearTimeout(killer); reject(err); });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function contentDbIn(configDir: string): string {
  const contentDir = join(configDir, "ctxscribe", "content");
  if (!existsSync(contentDir)) throw new Error(`content dir missing: ${contentDir}`);
  const dbs = readdirSync(contentDir).filter((f) => f.endsWith(".db"));
  if (dbs.length !== 1) throw new Error(`expected exactly one content db, got: ${dbs.join(", ")}`);
  return join(contentDir, dbs[0]);
}

function ftsCount(dbPath: string, token: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT count(*) AS c FROM chunks WHERE chunks MATCH ?").get(token) as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

function sourceIdOf(dbPath: string, label: string): number | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT id FROM sources WHERE label = ?").get(label) as { id: number } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

function readInputFor(file: string, projectDir: string, sessionId: string, extraTop: Record<string, unknown> = {}, extraToolInput: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    cwd: projectDir,
    tool_name: "Read",
    tool_input: { file_path: file, ...extraToolInput },
    tool_response: { type: "text", text: "r".repeat(6000) },
    ...extraTop,
  };
}

describe("R1 posttooluse passive indexing (hook process)", () => {
  it("① indexes a >4KB full-file Read into the ContentStore and records the sidecar", async () => {
    const configDir = tempDir("r1-cfg-");
    const projectDir = tempDir("r1-proj-");
    const token = `R1UNIQ${randomUUID().replace(/-/g, "")}`;
    const file = join(projectDir, "indexed-target.ts");
    writeFileSync(file, `// ${token}\n` + "export const filler = 1;\n".repeat(400), "utf-8");
    const sessionId = randomUUID();
    const rs: any = await import(pathToFileURL(READSTATE_PATH).href);
    cleanups.push(() => { try { rmSync(rs.statePath(sessionId)); } catch { /* gone */ } });

    const r = await runHookChild(readInputFor(file, projectDir, sessionId), configDir);
    expect(r.code).toBe(0);

    const dbPath = contentDbIn(configDir);
    expect(ftsCount(dbPath, token)).toBeGreaterThan(0);
    expect(sourceIdOf(dbPath, resolve(file))).not.toBeNull();

    const entry = rs.lookupEntry(sessionId, file);
    expect(entry).not.toBeNull();
    expect(entry.dbPath).toBe(dbPath);
  });

  it("② skips re-indexing an unchanged file (source row survives untouched)", async () => {
    const configDir = tempDir("r1-cfg-");
    const projectDir = tempDir("r1-proj-");
    const file = join(projectDir, "stable.ts");
    writeFileSync(file, "export const stable = true;\n".repeat(300), "utf-8");
    const sessionId = randomUUID();
    const rs: any = await import(pathToFileURL(READSTATE_PATH).href);
    cleanups.push(() => { try { rmSync(rs.statePath(sessionId)); } catch { /* gone */ } });

    await runHookChild(readInputFor(file, projectDir, sessionId), configDir);
    const dbPath = contentDbIn(configDir);
    const firstId = sourceIdOf(dbPath, resolve(file));
    expect(firstId).not.toBeNull();

    await runHookChild(readInputFor(file, projectDir, sessionId), configDir);
    const secondId = sourceIdOf(dbPath, resolve(file));
    expect(secondId).toBe(firstId); // re-index would delete + reinsert → new id
  });

  it("indexes subagent reads without arming the guard", async () => {
    const configDir = tempDir("r1-cfg-");
    const projectDir = tempDir("r1-proj-");
    const token = `R1SUB${randomUUID().replace(/-/g, "")}`;
    const file = join(projectDir, "subagent-read.ts");
    writeFileSync(file, `// ${token}\n` + "export const sub = 2;\n".repeat(400), "utf-8");
    const sessionId = randomUUID();
    const rs: any = await import(pathToFileURL(READSTATE_PATH).href);
    cleanups.push(() => { try { rmSync(rs.statePath(sessionId)); } catch { /* gone */ } });

    const r = await runHookChild(
      readInputFor(file, projectDir, sessionId, { agent_id: "agent-1", agent_type: "Explore" }),
      configDir,
    );
    expect(r.code).toBe(0);
    expect(ftsCount(contentDbIn(configDir), token)).toBeGreaterThan(0);
    expect(rs.lookupEntry(sessionId, file)).toBeNull();
  });

  it("does not index windowed reads at all", async () => {
    const configDir = tempDir("r1-cfg-");
    const projectDir = tempDir("r1-proj-");
    const file = join(projectDir, "windowed.ts");
    writeFileSync(file, "export const win = 3;\n".repeat(400), "utf-8");
    const sessionId = randomUUID();

    const r = await runHookChild(readInputFor(file, projectDir, sessionId, {}, { offset: 10 }), configDir);
    expect(r.code).toBe(0);
    const contentDir = join(configDir, "ctxscribe", "content");
    const dbs = existsSync(contentDir) ? readdirSync(contentDir).filter((f) => f.endsWith(".db")) : [];
    if (dbs.length === 1) {
      expect(sourceIdOf(join(contentDir, dbs[0]), resolve(file))).toBeNull();
    } else {
      expect(dbs.length).toBe(0); // store never even created — also a pass
    }
  });
});
