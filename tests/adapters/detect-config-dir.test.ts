/**
 * Behavioral tests for the medium-confidence config-directory branch of
 * detectPlatform() and the env-var priority chain.
 *
 * The adjacent detect.test.ts covers env vars, clientInfo, and the
 * CONTEXT_MODE_PLATFORM override — but the `~/.<platform>` /
 * `~/.config/<platform>` existsSync checks are not exercised there. These
 * tests mock `node:fs` to force each branch deterministically and lock the
 * priority ordering. Post-fork only claude-code and codex remain detectable;
 * the removed-client rows also assert that stale ~/.<removed>/ dirs left on
 * disk never hijack a kept-client detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

// Imports after vi.mock so the mock is in place before detect.ts resolves fs.
import * as fs from "node:fs";
import { detectPlatform, PLATFORM_ENV_VARS } from "../../src/adapters/detect.js";

const existsSyncMock = vi.mocked(fs.existsSync);

// Derived from detect.ts's source-of-truth list so renames can't drift.
const ALL_PLATFORM_ENV_VARS = [
  ...[...PLATFORM_ENV_VARS.values()].flatMap((vars) => vars.map((v) => v.name)),
  "CONTEXT_MODE_PLATFORM",
];

describe("detectPlatform — config directory branches", () => {
  const home = homedir();
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  const forceDir = (target: string) => {
    existsSyncMock.mockImplementation(((p: unknown) => p === target) as typeof fs.existsSync);
  };

  it.each<[string, string]>([
    [".claude", "claude-code"],
    [".codex", "codex"],
  ])("detects %s → %s at medium confidence", (dir, expected) => {
    forceDir(resolve(home, dir));
    const signal = detectPlatform();
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("medium");
    expect(signal.reason).toContain(dir);
  });

  it("falls back to claude-code low-confidence when no dirs exist", () => {
    existsSyncMock.mockReturnValue(false);
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("low");
    expect(signal.reason).toContain("No platform detected");
  });

  it("prefers ~/.claude over ~/.gemini when both dirs exist", () => {
    existsSyncMock.mockImplementation((
      ((p: unknown) =>
        p === resolve(home, ".claude") || p === resolve(home, ".gemini")) as typeof fs.existsSync
    ));
    expect(detectPlatform().platform).toBe("claude-code");
  });

  it("env var wins over a matching config dir", () => {
    forceDir(resolve(home, ".claude"));
    process.env.CODEX_CI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  it("CONTEXT_MODE_PLATFORM override wins over a matching config dir", () => {
    forceDir(resolve(home, ".claude"));
    process.env.CONTEXT_MODE_PLATFORM = "codex";
    expect(detectPlatform().platform).toBe("codex");
  });

  // A stale removed-client ~/.cursor/ left on disk must NOT hijack a
  // kept-client's config-dir detection. The forceDir helper mocks existsSync
  // to return true for ONE target only; here we mark BOTH the kept dir and
  // ~/.cursor/ as existing and assert the kept client still wins.
  const bothDirsExist = (agent: string) => {
    existsSyncMock.mockImplementation(
      ((p: unknown) =>
        p === resolve(home, agent) || p === resolve(home, ".cursor")) as typeof fs.existsSync,
    );
  };

  it.each<[string, string]>([
    [".claude", "claude-code"],
    [".codex", "codex"],
  ])("kept dir %s beats a stale ~/.cursor/ when both exist", (agent, expected) => {
    bothDirsExist(agent);
    const signal = detectPlatform();
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("medium");
  });

  // Regression guard (detection-ordering review): a BARE ~/.copilot/ directory
  // (GitHub Copilot CLI co-installed on the same machine) must NOT outrank
  // ~/.claude. Protects existing Claude Code users from stale-dir hijack.
  it("bare ~/.copilot/ (no context-mode config) does NOT outrank ~/.claude", () => {
    existsSyncMock.mockImplementation(
      ((p: unknown) =>
        p === resolve(home, ".copilot") ||
        p === resolve(home, ".claude")) as typeof fs.existsSync,
    );
    expect(detectPlatform().platform).toBe("claude-code");
  });
});

describe("detectPlatform — env var priority chain", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    existsSyncMock.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  // claude-code is listed before codex in PLATFORM_ENV_VARS, so its signal
  // wins when both are present.
  it("CLAUDE beats CODEX when both envs are set (registry order)", () => {
    process.env.CLAUDE_PROJECT_DIR = "/p";
    process.env.CODEX_CI = "1";
    expect(detectPlatform().platform).toBe("claude-code");
  });
});
