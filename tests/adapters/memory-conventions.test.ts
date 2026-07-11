import "../setup-home";
import { fakeHome } from "../setup-home";
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Adapters that honor XDG_CONFIG_HOME / APPDATA read the env var BEFORE
// falling back to homedir(). GitHub Actions Ubuntu can have these set to the
// runner's real home and bypass the homedir mock — anchor them under fakeHome
// so adapters stay sandboxed regardless of host env.
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
process.env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(fakeHome, "AppData", "Local");

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";

/**
 * Slice 3 — per-adapter memory/config conventions.
 *
 * Each adapter declares its own configDir, instructionFiles, memoryDir.
 * These are consumed by:
 *   - searchAutoMemory()  (auto-memory file scan)
 *   - ctx_search timeline (configDir for prior session lookup)
 *   - extract.ts isRule  (instruction file detection)
 */

describe("Adapter memory conventions", () => {
  describe("CodexAdapter", () => {
    const a = new CodexAdapter();
    it("getConfigDir is ~/.codex", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".codex"));
    });
    it("getInstructionFiles is ['AGENTS.md', 'AGENTS.override.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    });
    it("getMemoryDir is ~/.codex/memories (plural)", () => {
      expect(a.getMemoryDir()).toBe(join(homedir(), ".codex", "memories"));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Cross-adapter contract — getConfigDir() ALWAYS returns absolute
  //
  // Catches the leaky-seam bug where some upstream-era adapters returned
  // project-relative segments and others
  // returned absolute paths. Every consumer (server.ts, auto-memory.ts)
  // can now treat the return uniformly without isAbsolute() guards.
  // ──────────────────────────────────────────────────────────────────
  describe("HookAdapter.getConfigDir contract", () => {
    const projectDirForContract = join(fakeHome, "fixture-project");

    const allAdapters: Array<{ name: string; instance: { getConfigDir: (p?: string) => string } }> = [
      { name: "ClaudeCodeAdapter", instance: new ClaudeCodeAdapter() },
      { name: "CodexAdapter", instance: new CodexAdapter() },
    ];

    it.each(allAdapters)(
      "$name.getConfigDir(projectDir) returns an absolute path",
      ({ instance }) => {
        const dir = instance.getConfigDir(projectDirForContract);
        expect(typeof dir).toBe("string");
        expect(dir.length).toBeGreaterThan(0);
        expect(isAbsolute(dir)).toBe(true);
      },
    );

    it.each(allAdapters)(
      "$name.getConfigDir() (no args) still returns an absolute path",
      ({ instance }) => {
        const dir = instance.getConfigDir();
        expect(typeof dir).toBe("string");
        expect(dir.length).toBeGreaterThan(0);
        expect(isAbsolute(dir)).toBe(true);
      },
    );
  });
});
