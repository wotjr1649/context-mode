/**
 * v1.0.3 default hook-registration contract.
 *
 * Pins the hook-minimization decisions so a single-file edit (or a well-meaning
 * revert) cannot silently re-arm them:
 *   - deps-heal.mjs / orphan-reaper.mjs are no longer registered on SessionStart
 *     (no package delete/install or whole-machine process scan on a normal start).
 *   - Codex no longer registers UserPromptSubmit at all (AGENTS.md contract),
 *     while Claude Code keeps it (raw capture is gated inside the hook).
 * See src/adapters/codex/index.ts generateHookConfig for the generated-config
 * counterpart (tests/adapters/codex.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

type HookEntry = { hooks?: Array<{ command?: string }> };
type Manifest = { hooks?: Record<string, HookEntry[]> };

function readManifest(rel: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf-8")) as Manifest;
}

function allCommands(m: Manifest): string[] {
  const cmds: string[] = [];
  for (const groups of Object.values(m.hooks ?? {})) {
    for (const group of groups) {
      for (const h of group.hooks ?? []) {
        if (typeof h.command === "string") cmds.push(h.command);
      }
    }
  }
  return cmds;
}

function eventCommands(m: Manifest, event: string): string[] {
  const cmds: string[] = [];
  for (const group of m.hooks?.[event] ?? []) {
    for (const h of group.hooks ?? []) {
      if (typeof h.command === "string") cmds.push(h.command);
    }
  }
  return cmds;
}

describe("default hook registration (v1.0.3 minimization)", () => {
  it("Claude SessionStart drops deps-heal + orphan-reaper but keeps the core hook", () => {
    const m = readManifest("hooks/hooks.json");
    const start = eventCommands(m, "SessionStart");
    expect(start.some((c) => c.includes("deps-heal.mjs"))).toBe(false);
    expect(start.some((c) => c.includes("orphan-reaper.mjs"))).toBe(false);
    expect(start.some((c) => c.includes("sessionstart.mjs"))).toBe(true);
  });

  it("Claude keeps the core hooks + UserPromptSubmit; no reaper survives anywhere", () => {
    const m = readManifest("hooks/hooks.json");
    for (const evt of ["PreToolUse", "PostToolUse", "PreCompact", "SessionStart", "Stop", "UserPromptSubmit"]) {
      expect(m.hooks).toHaveProperty(evt);
    }
    const cmds = allCommands(m);
    expect(cmds.some((c) => c.includes("deps-heal.mjs"))).toBe(false);
    expect(cmds.some((c) => c.includes("orphan-reaper.mjs"))).toBe(false);
  });

  it("Codex plugin manifest registers neither the reapers nor UserPromptSubmit (#8)", () => {
    const m = readManifest(".codex-plugin/hooks.json");
    expect(m.hooks).not.toHaveProperty("UserPromptSubmit");
    for (const evt of ["PreToolUse", "PostToolUse", "PreCompact", "SessionStart", "Stop"]) {
      expect(m.hooks).toHaveProperty(evt);
    }
    const cmds = allCommands(m);
    expect(cmds.some((c) => c.includes("deps-heal.mjs"))).toBe(false);
    expect(cmds.some((c) => c.includes("orphan-reaper.mjs"))).toBe(false);
    expect(cmds.some((c) => c.includes("userpromptsubmit"))).toBe(false);
  });

  it("Codex human template (configs/codex/hooks.json) matches: no UserPromptSubmit", () => {
    const m = readManifest("configs/codex/hooks.json");
    expect(m.hooks).not.toHaveProperty("UserPromptSubmit");
    const cmds = allCommands(m);
    expect(cmds.some((c) => c.includes("userpromptsubmit"))).toBe(false);
  });
});
