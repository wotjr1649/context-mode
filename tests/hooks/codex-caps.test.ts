/**
 * codex-caps — PreToolUse "updatedInput" rewrite version gate.
 *
 * Pins the runtime floor at codex-cli 0.131.0, the first release that shipped
 * PreToolUse updatedInput rewrites (openai/codex#20527, merged 2026-05-12,
 * released in rust-v0.131.0 2026-05-18). Below the floor ctxscribe must fail
 * closed (report unsupported) so a redirect is denied rather than silently
 * passed through to a build that ignores the rewrite and runs the original.
 *
 * The gate had zero test coverage before this file (v1.0.5 review finding F5).
 * Each codexSupportsUpdatedInput case gets a unique cachePath so the module's
 * 1h-TTL result cache can't leak one case's verdict into the next.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import {
  codexSupportsUpdatedInput,
  defaultCachePath,
  MIN_REWRITE_VERSION,
  parseCodexVersion,
  versionGte,
} from "../../hooks/core/codex-caps.mjs";

const FIXED_NOW = () => 1_700_000_000_000;
const tempRoots: string[] = [];
/** A never-yet-written cache file, so every probe re-detects from runVersion. */
const freshCachePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxscribe-caps-"));
  tempRoots.push(dir);
  return join(dir, "caps.json");
};
/** A cache file pre-seeded with `entry`, as an older build would have left it. */
const seededCachePath = (entry: unknown): string => {
  const p = freshCachePath();
  writeFileSync(p, JSON.stringify(entry));
  return p;
};

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const supports = (versionLine: string): boolean =>
  codexSupportsUpdatedInput({
    runVersion: () => versionLine,
    now: FIXED_NOW,
    cachePath: freshCachePath(),
  });

describe("parseCodexVersion", () => {
  test("parses a codex-cli version banner", () => {
    expect(parseCodexVersion("codex-cli 0.131.0")).toEqual([0, 131, 0]);
  });
  test("parses a bare major.minor.patch", () => {
    expect(parseCodexVersion("0.130.99")).toEqual([0, 130, 99]);
  });
  test("returns null when no version is present", () => {
    expect(parseCodexVersion("codex-cli unknown")).toBeNull();
  });
});

describe("versionGte", () => {
  test("equal versions compare as >=", () => {
    expect(versionGte([0, 131, 0], [0, 131, 0])).toBe(true);
  });
  test("a lower minor is not >=", () => {
    expect(versionGte([0, 130, 99], [0, 131, 0])).toBe(false);
  });
});

describe("codexSupportsUpdatedInput — rewrite floor is codex-cli 0.131.0", () => {
  test("0.131.0 (first build with updatedInput) is supported", () => {
    expect(supports("codex-cli 0.131.0")).toBe(true);
  });
  test("0.130.99 (just below the floor) fails closed", () => {
    expect(supports("codex-cli 0.130.99")).toBe(false);
  });
  test("a current build (0.144.4) is supported", () => {
    expect(supports("codex-cli 0.144.4")).toBe(true);
  });
  test("no codex on PATH (probe throws) fails closed", () => {
    expect(
      codexSupportsUpdatedInput({
        runVersion: () => {
          throw new Error("ENOENT");
        },
        now: FIXED_NOW,
        cachePath: freshCachePath(),
      }),
    ).toBe(false);
  });
});

describe("codexSupportsUpdatedInput — cache invalidation across a floor change", () => {
  test("a stale pre-upgrade verdict never masks a now-supported version", () => {
    // An older build (floor 0.141) cached supported:false for a codex-cli
    // 0.135 user; after the floor drops to 0.131 that stale, un-tagged entry
    // must not be reused — otherwise the fix's target cohort keeps getting
    // denied for up to the cache TTL after upgrading.
    const cachePath = seededCachePath({ at: FIXED_NOW(), supported: false });
    expect(
      codexSupportsUpdatedInput({
        runVersion: () => "codex-cli 0.135.0",
        now: FIXED_NOW,
        cachePath,
      }),
    ).toBe(true);
  });

  test("a fresh verdict tagged with the current gate is reused without re-probing", () => {
    const cachePath = seededCachePath({
      at: FIXED_NOW(),
      supported: true,
      gate: MIN_REWRITE_VERSION.join("."),
    });
    expect(
      codexSupportsUpdatedInput({
        runVersion: () => {
          throw new Error("probe must not run on a cache hit");
        },
        now: FIXED_NOW,
        cachePath,
      }),
    ).toBe(true);
  });

  test("the default cache file is namespaced by the gate version so builds with different floors do not share it", () => {
    expect(defaultCachePath()).toContain(MIN_REWRITE_VERSION.join("."));
  });
});
