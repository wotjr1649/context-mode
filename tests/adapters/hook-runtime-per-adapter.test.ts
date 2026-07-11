/**
 * Per-adapter hook command emission — issue #738.
 *
 * claude-code emits JS-runtime hook spawn commands that must route through
 * `buildHookRuntimeCommand` so bun is preferred when available. codex emits a
 * CLI dispatcher command (`context-mode hook codex <event>`) that inherits the
 * CLI's runtime choice and is asserted as a non-regression below.
 *
 * Test strategy: rather than fight Vitest's module cache (which caches
 * `runtime.js` after the first import and never picks up subsequent
 * `vi.doMock("node:fs")` calls), we read the host's real runtime resolution
 * and assert the adapter emits exactly that path. This proves the adapter
 * routes through `buildHookRuntimeCommand` because the only other code path
 * (`buildNodeCommand` using `process.execPath`) would produce a different
 * binary name when bun is available on the host.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("hook command emission flows through buildHookRuntimeCommand (#738)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  test("claude-code generateHookConfig emits the resolved hook runtime path", async () => {
    const { resolveHookRuntime, resetHookRuntimeCache } = await import("../../src/runtime.js");
    resetHookRuntimeCache();
    const runtime = resolveHookRuntime();
    const { ClaudeCodeAdapter } = await import("../../src/adapters/claude-code/index.js");
    const adapter = new ClaudeCodeAdapter();
    const config = adapter.generateHookConfig("/plugin/root") as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const preCmd = config.PreToolUse[0].hooks[0].command;
    // Wire format: `"<runtimePath>" "<scriptPath>"` with forward-slashed paths.
    const expectedRuntime = runtime.path.replace(/\\/g, "/");
    expect(preCmd).toBe(`"${expectedRuntime}" "/plugin/root/hooks/pretooluse.mjs"`);
  });

  test("claude-code never emits bare 'node' (Algo-D3 invariant preserved)", async () => {
    const { resetHookRuntimeCache } = await import("../../src/runtime.js");
    resetHookRuntimeCache();
    const { ClaudeCodeAdapter } = await import("../../src/adapters/claude-code/index.js");
    const adapter = new ClaudeCodeAdapter();
    const config = adapter.generateHookConfig("/plugin/root") as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const allCommands = Object.values(config).flatMap((entries) =>
      entries.flatMap((e) => e.hooks.map((h) => h.command))
    );
    for (const cmd of allCommands) {
      // Must NOT be bare `node ...` — that would mean the helper was
      // bypassed (the bug claude-code/index.ts comment Algo-D3 prevents).
      expect(cmd).not.toMatch(/^node\s/);
      // Wire shape (always double-quoted pair).
      expect(cmd).toMatch(/^"[^"]+"\s+"[^"]+"$/);
    }
  });
});

describe("CLI-dispatcher adapters keep their dispatcher form (#738 non-regression)", () => {
  test("codex still emits 'context-mode hook codex <event>' shape", async () => {
    const { CodexAdapter } = await import("../../src/adapters/codex/index.js");
    const adapter = new CodexAdapter();
    const config = adapter.generateHookConfig("/plugin/root") as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const cmds = Object.values(config).flatMap((arr) =>
      arr.flatMap((e) => e.hooks.map((h) => h.command))
    );
    for (const cmd of cmds) {
      expect(cmd).toMatch(/^context-mode hook codex /);
    }
  });
});
