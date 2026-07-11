import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  detectPlatform,
  getAdapter,
  __seedClaudeCodePluginCacheMissForTests,
} from "../../src/adapters/detect.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { UnsupportedClientError } from "../../src/adapters/client-map.js";
import type { PlatformId } from "../../src/adapters/types.js";

// ─────────────────────────────────────────────────────────
// detectPlatform — env var detection
// ─────────────────────────────────────────────────────────

describe("detectPlatform", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all platform-specific env vars to get a clean slate
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    // Issue #539 follow-up: CLAUDE_CODE_ENTRYPOINT / CLAUDE_PLUGIN_ROOT are
    // exported by Claude Code itself, so any test process that runs INSIDE
    // CC will inherit them. Without this wipe, every non-claude-code env-var
    // assertion below short-circuits to "claude-code" via PLATFORM_ENV_VARS.
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_CI;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CONTEXT_MODE_PLATFORM;
    // Issue #539 slice 2: tests in this file pre-date the installed_plugins.json
    // fallback and assume env-var-only detection. Seed the plugin cache to a
    // "miss" so the fallback never triggers — explicit slice-2 coverage lives
    // in detect-claude-code-in-vscode.test.ts which exercises the real read.
    __seedClaudeCodePluginCacheMissForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ── Claude Code ────────────────────────────────────────

  it("returns claude-code when CLAUDE_PROJECT_DIR is set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });

  it("returns claude-code when CLAUDE_SESSION_ID is set", () => {
    process.env.CLAUDE_SESSION_ID = "abc-123";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });

  // ── Codex CLI ──────────────────────────────────────────

  it("returns codex when CODEX_CI is set", () => {
    process.env.CODEX_CI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  it("returns codex when CODEX_THREAD_ID is set", () => {
    process.env.CODEX_THREAD_ID = "thread-abc";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  // ── MCP clientInfo detection ─────────────────────────────

  it("unknown clientInfo falls through to env var detection", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform({ name: "some-unknown-client", version: "1.0" });
    expect(signal.platform).toBe("claude-code");
  });

  // ── Net 4: removed clients hard-fail (branch B) ──────────

  it("hard-fails on a removed client's clientInfo.name instead of degrading", () => {
    expect(() => detectPlatform({ name: "cursor-vscode" })).toThrow(UnsupportedClientError);
  });

  it("hard-fails on qwen's dynamic client name (prefix match, tsc cannot see it)", () => {
    expect(() => detectPlatform({ name: "qwen-cli-mcp-client-foo" })).toThrow(UnsupportedClientError);
  });

  it("still resolves the two supported clients by clientInfo.name", () => {
    expect(detectPlatform({ name: "claude-code" }).platform).toBe("claude-code");
    expect(detectPlatform({ name: "Codex" }).platform).toBe("codex");
  });

  it("does NOT throw on an unknown-but-not-removed client name (branch B)", () => {
    expect(() => detectPlatform({ name: "Some Future Client" })).not.toThrow();
  });

  // ── CONTEXT_MODE_PLATFORM override ──────────────────────

  it("invalid CONTEXT_MODE_PLATFORM is ignored", () => {
    process.env.CONTEXT_MODE_PLATFORM = "not-a-platform";
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
  });

  // ── Fallback ───────────────────────────────────────────

  it("returns a valid platform as default when no env vars are set", () => {
    // No env vars set — result depends on which config dirs exist on this machine.
    const signal = detectPlatform();
    expect(["claude-code", "codex", "unknown"]).toContain(signal.platform);
  });
});

// ─────────────────────────────────────────────────────────
// getAdapter — returns correct adapter for each platform
// ─────────────────────────────────────────────────────────

describe("getAdapter", () => {
  it("returns ClaudeCodeAdapter for claude-code", async () => {
    const adapter = await getAdapter("claude-code");
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns CodexAdapter for codex", async () => {
    const adapter = await getAdapter("codex");
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it("returns ClaudeCodeAdapter for unknown platform", async () => {
    const adapter = await getAdapter("unknown" as any);
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("rejects an unsupported PlatformId", async () => {
    await expect(getAdapter("cursor" as unknown as PlatformId)).rejects.toThrow(/unsupported platform/i);
  });
});

// ─────────────────────────────────────────────────────────
// Issue #545 — PLATFORM_ENV_VARS typed with workspace/identification roles.
//
// The registry must split each entry into {name, role} so resolveProjectDir
// can ALGORITHMICALLY derive ALLOW (own-platform workspace vars) and BAN
// (other platforms' workspace vars) sets.
// ─────────────────────────────────────────────────────────

describe("PLATFORM_ENV_VARS — typed registry (issue #545 algorithmic design)", () => {
  it("each entry tags name + role: 'workspace' | 'identification'", async () => {
    const { PLATFORM_ENV_VARS } = await import("../../src/adapters/detect.js");
    const claudeEntries = PLATFORM_ENV_VARS.get("claude-code");
    expect(claudeEntries).toBeDefined();
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_PROJECT_DIR", role: "workspace" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_PLUGIN_ROOT", role: "identification" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_SESSION_ID", role: "identification" });
  });

  it("getEnvVarNames(p) shim returns string[] for backwards compatibility", async () => {
    const { getEnvVarNames } = await import("../../src/adapters/detect.js");
    const names = getEnvVarNames("claude-code");
    expect(Array.isArray(names)).toBe(true);
    expect(names).toContain("CLAUDE_PROJECT_DIR");
    expect(names).toContain("CLAUDE_CODE_ENTRYPOINT");
  });

  it("workspaceEnvVarsFor(p) returns only role=workspace names in registry order", async () => {
    const { workspaceEnvVarsFor } = await import("../../src/adapters/detect.js");
    const claude = workspaceEnvVarsFor("claude-code");
    expect(claude).toEqual(["CLAUDE_PROJECT_DIR"]);
    const codex = workspaceEnvVarsFor("codex");
    // Codex has no workspace var — id-only registry rows.
    expect(codex).toEqual([]);
  });
});
