import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

let getToolName: (platform: string, bareTool: string) => string;
let createToolNamer: (platform: string) => (bareTool: string) => string;
let KNOWN_PLATFORMS: string[];
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
) => {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
} | null;
let resetGuidanceThrottle: () => void;
let createExternalMcpGuidance: (t: (tool: string) => string) => string;
let ROUTING_BLOCK: string;
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;
let BASH_GUIDANCE: string;
let EXTERNAL_MCP_GUIDANCE: string;

beforeAll(async () => {
  const naming = await import("../../hooks/core/tool-naming.mjs");
  getToolName = naming.getToolName;
  createToolNamer = naming.createToolNamer;
  KNOWN_PLATFORMS = naming.KNOWN_PLATFORMS;

  const routing = await import("../../hooks/core/routing.mjs");
  routePreToolUse = routing.routePreToolUse;
  resetGuidanceThrottle = routing.resetGuidanceThrottle;

  const block = await import("../../hooks/routing-block.mjs");
  createExternalMcpGuidance = block.createExternalMcpGuidance;
  ROUTING_BLOCK = block.ROUTING_BLOCK;
  READ_GUIDANCE = block.READ_GUIDANCE;
  GREP_GUIDANCE = block.GREP_GUIDANCE;
  BASH_GUIDANCE = block.BASH_GUIDANCE;
  EXTERNAL_MCP_GUIDANCE = block.EXTERNAL_MCP_GUIDANCE;
});

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `ctxscribe-mcp-ready-${process.pid}`);

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch {}
});

// ═══════════════════════════════════════════════════════════════════
// Tool Naming — getToolName and createToolNamer
// ═══════════════════════════════════════════════════════════════════

describe("getToolName", () => {
  it("returns correct name for claude-code", () => {
    expect(getToolName("claude-code", "ctx_fetch_and_index")).toBe(
      "mcp__plugin_ctxscribe_mcp__ctx_fetch_and_index",
    );
  });

  it("returns bare name for codex", () => {
    expect(getToolName("codex", "ctx_execute")).toBe("ctx_execute");
  });

  it("falls back to claude-code for unknown platforms", () => {
    expect(getToolName("unknown-platform", "ctx_search")).toBe(
      "mcp__plugin_ctxscribe_mcp__ctx_search",
    );
  });
});

describe("createToolNamer", () => {
  it("returns a function that produces correct names", () => {
    const t = createToolNamer("claude-code");
    expect(t("ctx_execute")).toBe("mcp__plugin_ctxscribe_mcp__ctx_execute");
    expect(t("ctx_search")).toBe("mcp__plugin_ctxscribe_mcp__ctx_search");
  });
});

describe("KNOWN_PLATFORMS", () => {
  it("contains exactly the supported platforms (claude-code, codex)", () => {
    expect(KNOWN_PLATFORMS).toContain("claude-code");
    expect(KNOWN_PLATFORMS).toContain("codex");
    expect(KNOWN_PLATFORMS.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Routing Block Factory Functions
// ═══════════════════════════════════════════════════════════════════

describe("createExternalMcpGuidance (#529)", () => {
  it("mentions the routing intent so the model knows what to do", () => {
    const t = createToolNamer("claude-code");
    const guidance = createExternalMcpGuidance(t);
    // Identifies the situation
    expect(guidance).toContain("External MCP tools");
    // Points to the right tools — losing any of these defeats the guidance
    expect(guidance).toMatch(/ctx_execute/);
    expect(guidance).toMatch(/ctx_fetch_and_index/);
    expect(guidance).toMatch(/ctx_search/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Backward Compat — Static Exports
// ═══════════════════════════════════════════════════════════════════

describe("backward compat static exports", () => {
  it("ROUTING_BLOCK uses claude-code naming", () => {
    expect(ROUTING_BLOCK).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_batch_execute",
    );
    expect(ROUTING_BLOCK).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_search",
    );
  });

  it("READ_GUIDANCE uses claude-code naming", () => {
    expect(READ_GUIDANCE).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_execute_file",
    );
  });

  it("GREP_GUIDANCE uses claude-code naming", () => {
    expect(GREP_GUIDANCE).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_execute",
    );
  });

  it("BASH_GUIDANCE uses claude-code naming", () => {
    expect(BASH_GUIDANCE).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_batch_execute",
    );
  });

  it("EXTERNAL_MCP_GUIDANCE uses claude-code naming and matches the factory (#529)", () => {
    expect(EXTERNAL_MCP_GUIDANCE).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_execute",
    );
    expect(EXTERNAL_MCP_GUIDANCE).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_fetch_and_index",
    );
    expect(EXTERNAL_MCP_GUIDANCE).toContain(
      "mcp__plugin_ctxscribe_mcp__ctx_search",
    );
    // Drift guard: the static export must equal the factory output with the
    // default (claude-code) namer — they share a single template.
    const claudeCodeT = createToolNamer("claude-code");
    expect(EXTERNAL_MCP_GUIDANCE).toBe(createExternalMcpGuidance(claudeCodeT));
  });
});

// ═══════════════════════════════════════════════════════════════════
// routePreToolUse with Platform Parameter
// ═══════════════════════════════════════════════════════════════════

describe("routePreToolUse with platform parameter", () => {
  it("curl block message uses claude-code tool names when platform is omitted", () => {
    const result = routePreToolUse("Bash", { command: "curl https://example.com" }, "/tmp");
    expect(result).not.toBeNull();
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("mcp__plugin_ctxscribe_mcp__ctx_fetch_and_index");
  });

  it("Task is no longer routed — returns null (#241)", () => {
    const result = routePreToolUse("Task", {
      prompt: "Analyze the code",
    }, "/tmp", "claude-code");
    expect(result).toBeNull();
  });
});

// ─── sessionstart platform-aware tool namer ───
describe("sessionstart detectPlatformFromEnv", () => {
  let detectPlatformFromEnv: (env?: Record<string, string | undefined>) => string;

  beforeAll(async () => {
    const mod = await import("../../hooks/core/platform-detect.mjs");
    detectPlatformFromEnv = mod.detectPlatformFromEnv;
  });

  it("returns codex when CODEX_THREAD_ID is set", () => {
    expect(detectPlatformFromEnv({ CODEX_THREAD_ID: "t-1" })).toBe("codex");
  });

  it("falls back to claude-code when no env var is set", () => {
    expect(detectPlatformFromEnv({})).toBe("claude-code");
  });
});
