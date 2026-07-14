import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexSessionCwd,
  resolveProjectDir,
} from "../../src/util/project-dir.js";

// ─────────────────────────────────────────────────────────
// Issue #45 / c4529042182 — Codex MCP servers do NOT receive any
// workspace env var (CODEX has no workspace-role env in PLATFORM_ENV_VARS).
// When Codex CLI is launched from a non-project cwd (e.g. ~), the spawned
// MCP child inherits that cwd and every project-aware tool (ctx_stats,
// SessionDB, hash) ends up rooted at $HOME instead of the user's project.
//
// Mitigation: read meta.cwd from the most-recently-modified Codex session
// log (`${CODEX_HOME ?? ~/.codex}/sessions/<uuid>.jsonl`, line 1 is the
// SessionMeta JSON struct per refs/platforms/codex/codex-rs).
// ─────────────────────────────────────────────────────────

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

function makeCodexHome(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-codex-home-"));
  cleanup.push(d);
  return d;
}

function writeSession(
  codexHome: string,
  uuid: string,
  cwd: string | null,
  mtime?: Date,
  malformed = false,
): string {
  const sessionsDir = join(codexHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${uuid}.jsonl`);

  let content: string;
  if (malformed) {
    content = "{not valid json\n";
  } else {
    // Mirror Codex's SessionMeta shape — line 1 carries `meta.cwd`.
    const meta: Record<string, unknown> = { sessionId: uuid };
    if (cwd !== null) meta.cwd = cwd;
    content = JSON.stringify({ meta }) + "\n";
  }
  writeFileSync(file, content);
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function writeDesktopSession(
  codexHome: string,
  name: string,
  cwd: string,
  mtime?: Date,
  extraPayload?: Record<string, unknown>,
): string {
  const sessionsDir = join(codexHome, "sessions", "2026", "05", "28");
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${name}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { cwd, ...extraPayload } }),
    JSON.stringify({ type: "turn_context", payload: { cwd } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

describe("resolveCodexSessionCwd", () => {
  it("returns meta.cwd from the most-recently-modified session.jsonl", () => {
    const codexHome = makeCodexHome();
    writeSession(codexHome, "old-uuid", "/project/old", new Date(Date.now() - 60_000));
    writeSession(codexHome, "new-uuid", "/project/new", new Date());

    expect(resolveCodexSessionCwd({ codexHome })).toBe("/project/new");
  });

  it("returns payload.cwd from Codex Desktop's dated rollout session layout", () => {
    const codexHome = makeCodexHome();
    writeDesktopSession(
      codexHome,
      "rollout-2026-05-28T12-00-00-000Z",
      "/Users/x/Work/Dev/ucw",
      new Date(),
    );

    expect(resolveCodexSessionCwd({ codexHome })).toBe("/Users/x/Work/Dev/ucw");
  });

  it("handles Codex Desktop session_meta lines larger than the old 8KB head read", () => {
    const codexHome = makeCodexHome();
    writeDesktopSession(
      codexHome,
      "rollout-large-meta",
      "/project/large-meta",
      new Date(),
      { dynamic_tools: "x".repeat(16_000) },
    );

    expect(resolveCodexSessionCwd({ codexHome })).toBe("/project/large-meta");
  });

  it("prefers the most-recently-modified Codex Desktop session recursively", () => {
    const codexHome = makeCodexHome();
    writeDesktopSession(
      codexHome,
      "rollout-old",
      "/project/old",
      new Date(Date.now() - 60_000),
    );
    writeDesktopSession(codexHome, "rollout-new", "/project/new", new Date());

    expect(resolveCodexSessionCwd({ codexHome })).toBe("/project/new");
  });

  // A busier foreign window used to steal the project root: mtime says which
  // Codex session is streaming right now, not which one spawned this server.
  // Codex opens the session and spawns its stdio MCP servers together, so the
  // session that started next to OUR process start is ours. Numbers below are
  // the ones measured in production — a Codex Desktop window on another project
  // (session start 519 s away, freshest mtime) was re-rooting a codex-companion
  // run whose own session had started 808 ms before the server booted.
  it("matches the session that started with this process, not the busiest one", () => {
    const codexHome = makeCodexHome();
    const processStartMs = Date.parse("2026-07-14T02:41:35.060Z");

    writeDesktopSession(
      codexHome,
      "rollout-foreign-desktop",
      "/project/other",
      new Date(processStartMs + 221_000), // still streaming → freshest mtime
      { timestamp: "2026-07-14T02:32:56.222Z" },
    );
    writeDesktopSession(
      codexHome,
      "rollout-ours",
      "/project/mine",
      new Date(processStartMs + 35_000), // quiet since our last turn
      { timestamp: "2026-07-14T02:41:34.252Z" },
    );

    expect(resolveCodexSessionCwd({ codexHome, processStartMs })).toBe(
      "/project/mine",
    );
  });

  // Regression: an earlier cut of this fix inspected only the 16 freshest logs.
  // The list is mtime-ordered and our own session is routinely the QUIETEST one
  // on the machine, so a "top N" cut drops exactly the log we are looking for —
  // and the fallback then re-roots us onto a stranger. No cap may sit in front
  // of the start-time check.
  it("finds our session even when many busier Codex logs are newer", () => {
    const codexHome = makeCodexHome();
    const processStartMs = Date.now();

    for (let i = 0; i < 40; i++) {
      writeDesktopSession(
        codexHome,
        `rollout-foreign-${i}`,
        `/project/other-${i}`,
        new Date(processStartMs + 60_000 + i), // every one is fresher than ours
        {
          timestamp: new Date(processStartMs - 3_600_000 - i * 1_000)
            .toISOString(),
        },
      );
    }
    writeDesktopSession(
      codexHome,
      "rollout-ours",
      "/project/mine",
      new Date(processStartMs + 1_000), // quiet: oldest mtime of the lot
      { timestamp: new Date(processStartMs - 500).toISOString() },
    );

    expect(resolveCodexSessionCwd({ codexHome, processStartMs })).toBe(
      "/project/mine",
    );
  });

  it("ignores a session that started long before this process booted", () => {
    const codexHome = makeCodexHome();
    const processStartMs = Date.now();

    // Only candidate carrying a start timestamp, and it is an hour stale — but
    // it is still being written, so mtime alone would have picked it.
    writeDesktopSession(
      codexHome,
      "rollout-foreign-desktop",
      "/project/other",
      new Date(processStartMs + 1_000),
      { timestamp: new Date(processStartMs - 3_600_000).toISOString() },
    );
    writeDesktopSession(
      codexHome,
      "rollout-ours",
      "/project/mine",
      new Date(processStartMs),
      { timestamp: new Date(processStartMs + 500).toISOString() },
    );

    expect(resolveCodexSessionCwd({ codexHome, processStartMs })).toBe(
      "/project/mine",
    );
  });

  // When nothing started alongside us (a resumed session whose logged start is
  // hours old, a mid-session MCP respawn) the timing tells us nothing, so we
  // must NOT confidently pick the nearest stranger — degrade to the historical
  // newest-by-mtime pick instead.
  it("degrades to newest-by-mtime when no session started alongside this process", () => {
    const codexHome = makeCodexHome();
    const processStartMs = Date.now();

    writeDesktopSession(
      codexHome,
      "rollout-stale-start",
      "/project/stale-start",
      new Date(processStartMs + 5_000), // freshest mtime
      { timestamp: new Date(processStartMs - 3_600_000).toISOString() },
    );
    writeDesktopSession(
      codexHome,
      "rollout-quiet",
      "/project/quiet",
      new Date(processStartMs - 10_000),
      { timestamp: new Date(processStartMs - 7_200_000).toISOString() },
    );

    expect(resolveCodexSessionCwd({ codexHome, processStartMs })).toBe(
      "/project/stale-start",
    );
  });

  it("falls back to the newest session when no log records a start timestamp", () => {
    const codexHome = makeCodexHome();
    const processStartMs = Date.now();
    writeDesktopSession(
      codexHome,
      "rollout-old",
      "/project/old",
      new Date(processStartMs - 30_000),
    );
    writeDesktopSession(
      codexHome,
      "rollout-new",
      "/project/new",
      new Date(processStartMs + 5_000),
    );

    expect(resolveCodexSessionCwd({ codexHome, processStartMs })).toBe(
      "/project/new",
    );
  });

  it("ignores session.jsonl older than transcriptMaxAgeMs", () => {
    const codexHome = makeCodexHome();
    const now = Date.now();
    writeSession(codexHome, "stale", "/project/stale", new Date(now - 60_000));

    const result = resolveCodexSessionCwd({
      codexHome,
      transcriptMaxAgeMs: 30_000,
      now,
    });
    expect(result).toBeNull();
  });

  it("returns meta.cwd when newest session is within transcriptMaxAgeMs", () => {
    const codexHome = makeCodexHome();
    const now = Date.now();
    writeSession(codexHome, "fresh", "/project/fresh", new Date(now - 10_000));

    const result = resolveCodexSessionCwd({
      codexHome,
      transcriptMaxAgeMs: 30_000,
      now,
    });
    expect(result).toBe("/project/fresh");
  });

  it("rejects when meta.cwd points to plugin install path (isPluginInstallPath)", () => {
    const codexHome = makeCodexHome();
    writeSession(
      codexHome,
      "poisoned",
      "/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.148",
    );
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });

  it("rejects when meta.cwd points to Codex plugin install path (isPluginInstallPath)", () => {
    const codexHome = makeCodexHome();
    writeSession(
      codexHome,
      "poisoned-codex",
      "/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.151",
    );
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });

  it("rejects when Codex Desktop payload.cwd points to Codex plugin install path", () => {
    const codexHome = makeCodexHome();
    writeDesktopSession(
      codexHome,
      "rollout-poisoned",
      "/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.151",
    );
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });

  it("returns null when sessions dir does not exist", () => {
    const codexHome = makeCodexHome();
    // No sessions/ subdir created.
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });

  it("returns null when codexHome itself does not exist", () => {
    expect(resolveCodexSessionCwd({ codexHome: "/nonexistent/.codex" })).toBeNull();
  });

  it("returns null when sessions dir is empty", () => {
    const codexHome = makeCodexHome();
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });

  it("handles malformed session.jsonl gracefully (no throw)", () => {
    const codexHome = makeCodexHome();
    writeSession(codexHome, "broken", null, undefined, /* malformed */ true);
    expect(() => resolveCodexSessionCwd({ codexHome })).not.toThrow();
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });

  it("returns null when meta.cwd is missing from the SessionMeta line", () => {
    const codexHome = makeCodexHome();
    writeSession(codexHome, "no-cwd", null);
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });

  it("returns null when meta.cwd is non-string", () => {
    const codexHome = makeCodexHome();
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "weird.jsonl"),
      JSON.stringify({ meta: { cwd: 123 } }) + "\n",
    );
    expect(resolveCodexSessionCwd({ codexHome })).toBeNull();
  });
});

describe("resolveProjectDir({strictPlatform: 'codex'})", () => {
  it("honors CONTEXT_MODE_PROJECT_DIR env (universal escape hatch)", () => {
    const codexHome = makeCodexHome();
    writeSession(codexHome, "fresh", "/from/session", new Date());

    const result = resolveProjectDir({
      env: { CONTEXT_MODE_PROJECT_DIR: "/from/env" },
      cwd: "/cwd",
      pwd: "/pwd",
      strictPlatform: "codex",
      codexHome,
    });
    expect(result).toBe("/from/env");
  });

  it("falls back to Codex session log when no workspace env is set", () => {
    const codexHome = makeCodexHome();
    writeSession(codexHome, "fresh", "/project/from-session", new Date());

    const result = resolveProjectDir({
      env: {},
      cwd: "/should-not-win",
      pwd: undefined,
      strictPlatform: "codex",
      codexHome,
    });
    expect(result).toBe("/project/from-session");
  });

  it("falls back to Codex Desktop session log before poisoned plugin cwd", () => {
    const codexHome = makeCodexHome();
    writeDesktopSession(codexHome, "rollout-active", "/project/from-desktop", new Date());

    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.151",
      pwd: undefined,
      strictPlatform: "codex",
      codexHome,
    });
    expect(result).toBe("/project/from-desktop");
  });

  it("falls through to PWD when no env and no session log", () => {
    const codexHome = makeCodexHome();
    // No sessions written.

    const result = resolveProjectDir({
      env: {},
      cwd: "/cwd-fallback",
      pwd: "/pwd-wins",
      strictPlatform: "codex",
      codexHome,
    });
    expect(result).toBe("/pwd-wins");
  });

  it("ignores foreign workspace env (CLAUDE_PROJECT_DIR) under strict codex", () => {
    const codexHome = makeCodexHome();
    writeSession(codexHome, "fresh", "/project/from-session", new Date());

    const result = resolveProjectDir({
      env: { CLAUDE_PROJECT_DIR: "/leak/from/claude" },
      cwd: "/cwd",
      pwd: undefined,
      strictPlatform: "codex",
      codexHome,
    });
    expect(result).toBe("/project/from-session");
  });

  it("rejects stale codex session log via transcriptMaxAgeMs", () => {
    const codexHome = makeCodexHome();
    const now = Date.now();
    writeSession(codexHome, "stale", "/project/stale", new Date(now - 60_000));

    const result = resolveProjectDir({
      env: {},
      cwd: "/cwd",
      pwd: "/pwd-real",
      strictPlatform: "codex",
      codexHome,
      transcriptMaxAgeMs: 30_000,
      nowMs: now,
    });
    expect(result).toBe("/pwd-real");
  });
});
