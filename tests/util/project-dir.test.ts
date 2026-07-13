import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isPluginInstallPath,
  resolveProjectDir,
  resolveProjectDirFromTranscript,
} from "../../src/util/project-dir.js";

const cleanup: string[] = [];
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

function makeTranscriptsRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-transcripts-"));
  cleanup.push(d);
  return d;
}

function writeTranscript(root: string, encodedDir: string, sessionId: string, cwd: string, mtime?: Date) {
  const dir = join(root, encodedDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  // Mirror Claude Code's transcript shape: line 1 = session metadata, line 2+ has cwd
  const lines = [
    JSON.stringify({ type: "session-meta", sessionId, permissionMode: "default" }),
    JSON.stringify({ type: "user", cwd, sessionId }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function compiledResolverScript(): string {
  const moduleUrl = pathToFileURL(join(process.cwd(), "build/util/project-dir.js")).href;
  return `
    import { resolveProjectDir } from ${JSON.stringify(moduleUrl)};
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/fallback",
      pwd: undefined,
      transcriptsRoot: "/nonexistent/transcripts"
    });
    console.log(result);
  `;
}

function runCompiledResolver(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    env: { ...process.env, PWD: "" },
  }).trim();
}

describe("isPluginInstallPath", () => {
  it("matches macOS / Linux plugin cache paths", () => {
    expect(isPluginInstallPath("/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.112")).toBe(true);
    expect(isPluginInstallPath("/home/x/.claude/plugins/cache/foo/foo/1.0.0")).toBe(true);
    expect(isPluginInstallPath("/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.151")).toBe(true);
    expect(isPluginInstallPath("/home/x/.codex/plugins/cache/foo/foo/1.0.0")).toBe(true);
  });

  it("matches plugin marketplace paths", () => {
    expect(isPluginInstallPath("/Users/x/.claude/plugins/marketplaces/wotjr1649")).toBe(true);
    expect(isPluginInstallPath("/Users/x/.codex/plugins/marketplaces/wotjr1649")).toBe(true);
  });

  it("matches Windows plugin cache paths (backslash + drive letter)", () => {
    expect(isPluginInstallPath("C:\\Users\\x\\.claude\\plugins\\cache\\foo\\foo\\1.0.0")).toBe(true);
    expect(isPluginInstallPath("C:\\Users\\x\\.codex\\plugins\\cache\\foo\\foo\\1.0.0")).toBe(true);
  });

  it("returns false for ordinary project paths", () => {
    expect(isPluginInstallPath("/Users/x/Server/proj")).toBe(false);
    expect(isPluginInstallPath("/home/x/work/proj")).toBe(false);
    expect(isPluginInstallPath("C:\\Users\\x\\proj")).toBe(false);
  });

  it("returns false for unrelated .claude subpaths (e.g. session storage)", () => {
    // This path is under .claude but NOT under .claude/plugins/* — must not match.
    expect(isPluginInstallPath("/Users/x/.claude/projects/-Users-x-proj")).toBe(false);
    expect(isPluginInstallPath("/Users/x/.claude/ctxscribe/sessions/abc.db")).toBe(false);
  });

  it("returns false for empty / null-ish inputs", () => {
    expect(isPluginInstallPath("")).toBe(false);
    expect(isPluginInstallPath("/")).toBe(false);
  });
});

describe("resolveProjectDir", () => {
  it("returns the first non-plugin env var in priority order", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/proj",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // poisoned
      },
      cwd: "/some/cwd",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("rejects plugin path env vars and falls through to the next source", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      },
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: "/Users/x/Server/realproj",
    });
    expect(result).toBe("/Users/x/Server/realproj"); // PWD wins, skipping poisoned env + plugin cwd
  });

  it("rejects Codex plugin path env vars and falls through to the next source", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.151",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.151",
      },
      cwd: "/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.151",
      pwd: "/Users/x/Work/Dev/ucw",
    });
    expect(result).toBe("/Users/x/Work/Dev/ucw");
  });

  it("uses cwd as last resort when env + PWD are missing or all poisoned", () => {
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/proj",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("falls back to cwd EVEN IF cwd is plugin path when nothing else exists (no panics)", () => {
    // Last-resort behavior: rather than throw, return cwd. ctx_stats can detect
    // and render a "project context unavailable" message, but the function
    // itself stays total so other tools (sandbox execute, fetch) keep working.
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/.claude/plugins/cache/foo/foo/1.0.0");
  });

  it("respects adapter-specific env vars (GEMINI/VSCODE/IDEA) in the chain", () => {
    expect(resolveProjectDir({
      env: { GEMINI_PROJECT_DIR: "/g/proj" },
      cwd: "/x", pwd: undefined,
    })).toBe("/g/proj");
    expect(resolveProjectDir({
      env: { IDEA_INITIAL_DIRECTORY: "/i/proj" },
      cwd: "/x", pwd: undefined,
    })).toBe("/i/proj");
  });

  // Issue #521 Slice 1 generalized: any cascade var pointing at a plugin
  // install path is poisoned (a prior MCP boot's start.mjs auto-set) and
  // must be rejected so PWD can win.
  it("rejects a cascade env var when it points at a plugin install path", () => {
    const result = resolveProjectDir({
      env: { GEMINI_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0" },
      cwd: "/x",
      pwd: "/Users/x/realproj",
    });
    expect(result).toBe("/Users/x/realproj"); // PWD wins, poisoned var rejected
  });
});

// ─────────────────────────────────────────────────────────
// Issue #545 — `strictPlatform` algorithmic mode.
//
// Under strict mode the candidate list is built from the platform's own
// workspace env vars + UNIVERSAL escape hatch — foreign workspace vars
// (e.g. CLAUDE_PROJECT_DIR leaked into another host's MCP child env) cannot
// win, regardless of cascade order. The resolver must contain ZERO hardcoded
// platform names — the candidate set is derived from PLATFORM_ENV_VARS.
// ─────────────────────────────────────────────────────────

describe("resolveProjectDir — strictPlatform algorithmic mode (issue #545)", () => {
  it("strictPlatform=claude-code prefers CLAUDE_PROJECT_DIR over a foreign leak", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/own-claude-project",
        GEMINI_PROJECT_DIR: "/leak/from/gemini-host",
      },
      cwd: "/some/cwd",
      pwd: undefined,
      strictPlatform: "claude-code",
    });
    expect(result).toBe("/Users/x/own-claude-project");
  });

  it("strictPlatform=codex (no workspace var) falls through CONTEXT_MODE_PROJECT_DIR > pwd > cwd", () => {
    const result = resolveProjectDir({
      env: {
        // Foreign workspace vars leaked everywhere — none must win.
        CLAUDE_PROJECT_DIR: "/leak/cc",
        GEMINI_PROJECT_DIR: "/leak/gemini",
        VSCODE_CWD: "/leak/vscode",
        IDEA_INITIAL_DIRECTORY: "/leak/idea",
        // Universal escape hatch.
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/escape",
      },
      cwd: "/some/cwd",
      pwd: undefined,
      strictPlatform: "codex",
    });
    expect(result).toBe("/Users/x/escape");
  });

  it("non-strict mode preserves the EXACT legacy candidate order (semver lock)", () => {
    // The fork-pruned literal order from src/util/project-dir.ts:
    //   CLAUDE_PROJECT_DIR > GEMINI_PROJECT_DIR > VSCODE_CWD
    //   > IDEA_INITIAL_DIRECTORY > CONTEXT_MODE_PROJECT_DIR
    const env = {
      CLAUDE_PROJECT_DIR: "/p1",
      GEMINI_PROJECT_DIR: "/p2",
      VSCODE_CWD: "/p3",
      IDEA_INITIAL_DIRECTORY: "/p4",
      CONTEXT_MODE_PROJECT_DIR: "/p5",
    };
    // First wins.
    expect(resolveProjectDir({ env, cwd: "/x", pwd: undefined })).toBe("/p1");
    // Drop CLAUDE — GEMINI wins.
    expect(resolveProjectDir({
      env: { ...env, CLAUDE_PROJECT_DIR: undefined },
      cwd: "/x", pwd: undefined,
    })).toBe("/p2");
    // Drop down to IDEA — IDEA_INITIAL_DIRECTORY wins (legacy slot 4).
    expect(resolveProjectDir({
      env: {
        IDEA_INITIAL_DIRECTORY: "/p4",
        CONTEXT_MODE_PROJECT_DIR: "/p5",
      },
      cwd: "/x", pwd: undefined,
    })).toBe("/p4");
  });
});

describe("resolveProjectDirFromTranscript", () => {
  it("returns cwd from the most-recently-modified Claude Code transcript", () => {
    const root = makeTranscriptsRoot();
    writeTranscript(root, "-Users-x-old", "old-session", "/Users/x/old-proj", new Date(Date.now() - 60_000));
    writeTranscript(root, "-Users-x-new", "new-session", "/Users/x/new-proj", new Date());

    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBe("/Users/x/new-proj");
  });

  it("returns undefined when projects dir does not exist", () => {
    const result = resolveProjectDirFromTranscript({ projectsRoot: "/nonexistent/path" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the newest transcript is older than maxAgeMs", () => {
    const root = makeTranscriptsRoot();
    const now = Date.now();
    writeTranscript(root, "-Users-x-stale", "stale-session", "/Users/x/stale-proj", new Date(now - 60_000));

    const result = resolveProjectDirFromTranscript({
      projectsRoot: root,
      maxAgeMs: 30_000,
      nowMs: now,
    });
    expect(result).toBeUndefined();
  });

  it("returns cwd when the newest transcript is within maxAgeMs", () => {
    const root = makeTranscriptsRoot();
    const now = Date.now();
    writeTranscript(root, "-Users-x-fresh", "fresh-session", "/Users/x/fresh-proj", new Date(now - 10_000));

    const result = resolveProjectDirFromTranscript({
      projectsRoot: root,
      maxAgeMs: 30_000,
      nowMs: now,
    });
    expect(result).toBe("/Users/x/fresh-proj");
  });

  it("returns undefined when no jsonl files exist", () => {
    const root = makeTranscriptsRoot();
    mkdirSync(join(root, "-Users-x-empty"), { recursive: true });
    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBeUndefined();
  });

  it("skips transcripts without a cwd field in any of their first lines", () => {
    const root = makeTranscriptsRoot();
    const dir = join(root, "-Users-x-cwd-less");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      JSON.stringify({ type: "session-meta", sessionId: "s1" }) + "\n" +
      JSON.stringify({ type: "user", text: "hi" }) + "\n",
    );
    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBeUndefined();
  });

  it("resolveProjectDir prefers transcript cwd over PWD when env is empty and cwd is plugin path", () => {
    const root = makeTranscriptsRoot();
    writeTranscript(root, "-Users-x-real", "active-session", "/Users/x/real-proj");

    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // plugin path → rejected
      pwd: "/Users/x", // home dir, not a real project
      transcriptsRoot: root,
    });
    expect(result).toBe("/Users/x/real-proj");
  });

  it("resolveProjectDir falls back to PWD when transcript yields nothing", () => {
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: "/Users/x/proj",
      transcriptsRoot: "/nonexistent/transcripts",
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("resolveProjectDir falls back to PWD when transcript is stale", () => {
    const root = makeTranscriptsRoot();
    const now = Date.now();
    writeTranscript(root, "-Users-x-stale", "stale-session", "/Users/x/stale-proj", new Date(now - 60_000));

    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x",
      pwd: "/Users/x",
      transcriptsRoot: root,
      transcriptMaxAgeMs: 30_000,
      nowMs: now,
    });
    expect(result).toBe("/Users/x");
  });

  it("compiled ESM resolver runs under Node without CommonJS require", () => {
    const output = runCompiledResolver(process.execPath, [
      "--input-type=module",
      "-e",
      compiledResolverScript(),
    ]);

    expect(output).toBe("/Users/x/fallback");
  });

  it.runIf(bunAvailable)("compiled ESM resolver runs under Bun without CommonJS require", () => {
    const output = runCompiledResolver("bun", ["-e", compiledResolverScript()]);

    expect(output).toBe("/Users/x/fallback");
  });
});
