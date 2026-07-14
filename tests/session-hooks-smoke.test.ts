/**
 * Smoke test — Issue #117
 *
 * Verifies that session continuity hooks work WITHOUT the build/session/
 * directory. Simulates a fresh marketplace install where tsc has never run.
 *
 * GREEN phase: These tests PASS, proving the bundle-first fix works.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SessionDB } from "../src/session/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// Simulate marketplace install: copy plugin WITHOUT build/session/
let fakePluginDir: string;
let fakeProjectDir: string;
let fakeHomeDir: string;
/** Where getSessionDBPath() actually writes: <fakeHome>/.claude/ctxscribe/sessions/ */
let sessionDBDir: string;
let codexSessionDBDir: string;

beforeAll(() => {
  fakePluginDir = mkdtempSync(join(tmpdir(), "ctx-marketplace-sim-"));

  // Copy hooks directory
  cpSync(join(PROJECT_ROOT, "hooks"), join(fakePluginDir, "hooks"), { recursive: true });

  // Symlink node_modules (needed for better-sqlite3, too large to copy)
  if (existsSync(join(PROJECT_ROOT, "node_modules"))) {
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fakePluginDir, "node_modules"));
  }

  // Copy package.json (needed for module resolution)
  cpSync(join(PROJECT_ROOT, "package.json"), join(fakePluginDir, "package.json"));

  // DO NOT copy build/session/ — this simulates marketplace install
  // Verify build/session/ does NOT exist in our fake install
  expect(existsSync(join(fakePluginDir, "build", "session"))).toBe(false);

  // Fake project dir (value for CLAUDE_PROJECT_DIR)
  fakeProjectDir = mkdtempSync(join(tmpdir(), "ctx-project-"));

  // Fake HOME so getSessionDBPath() writes to an isolated location
  fakeHomeDir = mkdtempSync(join(tmpdir(), "ctx-fakehome-"));
  sessionDBDir = join(fakeHomeDir, ".claude", "ctxscribe", "sessions");
  codexSessionDBDir = join(fakeHomeDir, ".codex", "ctxscribe", "sessions");
});

afterAll(() => {
  try { rmSync(fakePluginDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fakeProjectDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fakeHomeDir, { recursive: true, force: true }); } catch {}
});

function runHook(hookFile: string, input: Record<string, unknown>, env?: Record<string, string>) {
  const hookPath = join(fakePluginDir, "hooks", hookFile);
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fakeProjectDir,
      CLAUDE_SESSION_ID: "test-session-117",
      CONTEXT_MODE_PLATFORM: "claude-code",
      // Isolate DB writes to fake HOME
      HOME: fakeHomeDir,
      USERPROFILE: fakeHomeDir,
      // $CLAUDE_CONFIG_DIR / $CODEX_HOME take PRECEDENCE over homedir() when the
      // hook resolves its config dir, and vitest.config.ts pins both globally so
      // that unisolated suites can't reach the real ~/.claude. Redirecting HOME
      // alone would therefore no longer steer the spawned hook: it would write
      // its session DB into the global test config dir, not sessionDBDir. Point
      // them at this suite's fake home so env and homedir() agree.
      CLAUDE_CONFIG_DIR: join(fakeHomeDir, ".claude"),
      CODEX_HOME: join(fakeHomeDir, ".codex"),
      ...env,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/** Check if any .db files were created in the isolated session directory */
function getDBFiles(): string[] {
  return existsSync(sessionDBDir)
    ? readdirSync(sessionDBDir).filter(f => f.endsWith(".db"))
    : [];
}

function getCodexDBFiles(): string[] {
  return existsSync(codexSessionDBDir)
    ? readdirSync(codexSessionDBDir).filter(f => f.endsWith(".db"))
    : [];
}

describe("Issue #117 — Session hooks without build/session/", () => {
  test("posttooluse.mjs creates session DB via bundle (no build/ needed)", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: "test-session-117",
      tool_name: "Read",
      tool_input: { file_path: "/src/main.ts" },
      tool_response: "const x = 1;",
    });

    expect(result.exitCode).toBe(0);

    // Bundle-first fix: DB is created in ~/.claude/ctxscribe/sessions/
    expect(getDBFiles().length).toBeGreaterThan(0);
  });

  test("hooks/codex/posttooluse.mjs normalizes failed apply_patch into tool_output.isError", () => {
    const sessionId = "codex-posttooluse-error";
    const result = runHook("codex/posttooluse.mjs", {
      session_id: sessionId,
      cwd: fakeProjectDir,
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/will-fail.ts",
          "+export {};",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch failed",
      tool_output: { is_error: true },
    }, {
      CONTEXT_MODE_PLATFORM: "codex",
      CODEX_PROJECT_DIR: fakeProjectDir,
    });

    expect(result.exitCode).toBe(0);
    const dbFiles = getCodexDBFiles();
    expect(dbFiles.length).toBeGreaterThan(0);

    const db = new SessionDB({ dbPath: join(codexSessionDBDir, dbFiles[0]!) });
    const events = db.getEvents(sessionId);
    db.close();

    expect(events.some((event) => event.type === "error_tool")).toBe(true);
    expect(events.some((event) => event.type === "file_write")).toBe(false);
    expect(events.some((event) => event.type === "file_edit")).toBe(false);
  });

  test("sessionstart.mjs routing block works (independent of build/)", () => {
    const result = runHook("sessionstart.mjs", {
      session_id: "test-session-117",
      source: "startup",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toBeDefined();
  });

  test("sessionstart.mjs compact recovery works via bundle", () => {
    // First capture some events with same session_id
    runHook("posttooluse.mjs", {
      session_id: "test-session-117",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    });

    // Trigger compact — session recovery now works via bundled session-db
    const result = runHook("sessionstart.mjs", {
      session_id: "test-session-117",
      source: "compact",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Fix verified: compact recovery injects session_knowledge
    expect(ctx).toContain("session_knowledge");
  });

  test("userpromptsubmit.mjs runs and creates the session DB via bundle", () => {
    const result = runHook("userpromptsubmit.mjs", {
      prompt: "fix the login bug",
      session_id: "test-session-117",
    });

    expect(result.exitCode).toBe(0);
    // DB is created for structured continuity even with raw capture off.
    expect(getDBFiles().length).toBeGreaterThan(0);
  });

  test("userpromptsubmit.mjs does NOT store the raw prompt by default (v1.0.3 capture off)", () => {
    const sessionId = "test-capture-off";
    // Example placeholder secret — NOT a real credential.
    const secret = "sk-ant-api03-EXAMPLEPLACEHOLDERdeadbeefdeadbeefdeadbeef0123";
    const result = runHook("userpromptsubmit.mjs", {
      prompt: `remember my token ${secret} and fix the login bug`,
      session_id: sessionId,
    });

    expect(result.exitCode).toBe(0);
    const dbFiles = getDBFiles();
    expect(dbFiles.length).toBeGreaterThan(0);
    const db = new SessionDB({ dbPath: join(sessionDBDir, dbFiles[0]!) });
    const events = db.getEvents(sessionId);
    db.close();

    // No raw user_prompt row, and the placeholder secret never reaches SQLite
    // (boundary redaction also scrubs structured events).
    expect(events.some((e) => e.type === "user_prompt")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  test("userpromptsubmit.mjs opt-in stores a redacted prompt (CONTEXT_MODE_PROMPT_CAPTURE=1)", () => {
    const sessionId = "test-capture-on";
    // Example placeholder secret — NOT a real credential.
    const secret = "ghp_EXAMPLEPLACEHOLDERdeadbeefdeadbeefdeadbeef01";
    const result = runHook("userpromptsubmit.mjs", {
      prompt: `store my github token ${secret} please`,
      session_id: sessionId,
    }, { CONTEXT_MODE_PROMPT_CAPTURE: "1" });

    expect(result.exitCode).toBe(0);
    const dbFiles = getDBFiles();
    const db = new SessionDB({ dbPath: join(sessionDBDir, dbFiles[0]!) });
    const events = db.getEvents(sessionId);
    db.close();

    // Raw capture happened, but the secret is masked before it touches SQLite.
    expect(events.some((e) => e.type === "user_prompt")).toBe(true);
    expect(JSON.stringify(events)).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  test("redactSecretText masks credentials but preserves normal PII-shaped prose (v1.0.3)", async () => {
    const { redactSecretText } = await import("../hooks/platform-bridge.mjs");
    // Example placeholder credential — NOT a real token.
    const cred = "ghp_EXAMPLEPLACEHOLDERdeadbeefdeadbeefdeadbeef01";
    const masked = redactSecretText(`use token ${cred} now`);
    expect(masked).toContain("[REDACTED]");
    expect(masked).not.toContain(cred);
    // Normal continuity prose that the BROAD wire PII regexes would over-match
    // (email-shaped filename, SSN-shaped ticket id) must survive local storage —
    // redactSecretText uses credential patterns only, not PII patterns.
    const prose = "update logo@2x.png for ticket 555-12-3456";
    expect(redactSecretText(prose)).toBe(prose);
  });

  test("precompact.mjs creates snapshot via bundle", () => {
    const result = runHook("precompact.mjs", {
      session_id: "test-session-117",
    });

    expect(result.exitCode).toBe(0);
  });
});
