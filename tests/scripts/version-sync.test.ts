/**
 * version-sync tests — guards the cross-manifest version invariant.
 *
 * The npm `version` lifecycle calls `scripts/version-sync.mjs` to copy
 * `package.json:version` into every shipped manifest. When a new plugin
 * surface is added, it MUST be added to BOTH:
 *
 *   1. `scripts/version-sync.mjs` → `targets[]` (so the value gets written)
 *   2. `package.json` → `scripts.version` `git add` list (so it is staged
 *      by the npm `version` hook into the release commit)
 *
 * If either is missing, the manifest will drift on every release.
 *
 * The end-to-end suite below runs `scripts/version-sync.mjs` as a subprocess
 * against a scratch copy of the shipped manifests and asserts every one lands
 * at the package.json version and the script exits 0.
 */

import { describe, it, expect } from "vitest";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
// Single source of truth — the same array the script iterates at release time.
import { TARGETS } from "../../scripts/version-sync.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT_SRC = readFileSync(resolve(REPO_ROOT, "scripts/version-sync.mjs"), "utf8");
const PKG_JSON = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: { version: string };
};

// SHIPPED = the TARGETS that exist on disk. Post-fork TARGETS lists only the
// surviving (claude-code / codex) manifests, so this normally equals TARGETS;
// the existsSync filter stays as a defensive guard so a not-yet-created future
// target degrades gracefully rather than hard-failing these read-based suites.
const SHIPPED = TARGETS.filter((t) => existsSync(resolve(REPO_ROOT, t)));

describe("scripts/version-sync.mjs targets", () => {
  it("includes .codex-plugin/plugin.json", () => {
    expect(SCRIPT_SRC).toContain('".codex-plugin/plugin.json"');
  });

  it("does NOT include .codex-plugin/marketplace.json (Codex never reads that path)", () => {
    // Codex CLI's MARKETPLACE_MANIFEST_RELATIVE_PATHS constant
    // (refs/platforms/codex/codex-rs/core-plugins/src/marketplace.rs:21)
    // lists only `.agents/plugins/marketplace.json` and `.claude-plugin/
    // marketplace.json`. Shipping `.codex-plugin/marketplace.json` is dead
    // weight and historically misled contributors into editing the wrong
    // file. The actual Codex marketplace at `.agents/plugins/marketplace.json`
    // has no top-level `version` field per the Codex serde schema
    // (marketplace.rs:694-700 — only `name`, `interface`, `plugins[]`), so
    // version-sync doesn't need to touch it.
    expect(SCRIPT_SRC).not.toContain('"\.codex-plugin/marketplace.json"');
  });
});

describe("package.json `version` script `git add` list", () => {
  it("includes .codex-plugin/plugin.json", () => {
    expect(PKG_JSON.scripts.version).toContain(".codex-plugin/plugin.json");
  });

  it("does NOT include .codex-plugin/marketplace.json (file is removed — Codex never reads it)", () => {
    expect(PKG_JSON.scripts.version).not.toContain(".codex-plugin/marketplace.json");
  });
});

describe("version-sync TARGETS is the single source of truth (#768)", () => {
  it("exports a non-empty TARGETS array", () => {
    expect(Array.isArray(TARGETS)).toBe(true);
    expect(TARGETS.length).toBeGreaterThan(0);
  });

  it("stages EVERY shipped target in the npm `version` lifecycle `git add` list", () => {
    // If version-sync rewrites a manifest but the `version` hook never stages
    // it, the change is dropped from the release commit and the manifest drifts
    // on the next bump.
    const gitAdd = PKG_JSON.scripts.version;
    const missing = SHIPPED.filter((t) => !gitAdd.includes(t));
    expect(missing, `shipped targets missing from package.json \`version\` git add list: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps EVERY shipped target in lockstep with package.json version", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const drifted: string[] = [];
    for (const manifest of SHIPPED) {
      const content = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), "utf8")) as {
        version?: string;
        metadata?: { version?: string };
        plugins?: Array<{ version?: string }>;
      };
      const reported =
        content.version ?? content.metadata?.version ?? content.plugins?.[0]?.version;
      if (reported !== pkg.version) drifted.push(`${manifest} (${String(reported)})`);
    }
    expect(drifted, `manifests not at v${pkg.version}: ${drifted.join(", ")}`).toEqual([]);
  });
});

describe("shipped manifests are in lockstep with package.json", () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  for (const manifest of SHIPPED) {
    it(`${manifest} matches package.json version`, () => {
      const content = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), "utf8")) as {
        version?: string;
        metadata?: { version?: string };
        plugins?: Array<{ version?: string }>;
      };
      const reported = content.version ?? content.metadata?.version ?? content.plugins?.[0]?.version;
      expect(reported, `${manifest} has no recognizable version field`).toBeDefined();
      expect(reported).toBe(pkg.version);
    });
  }
});

describe("version-sync end-to-end", () => {
  it("rewrites every shipped manifest to the package.json version and exits 0", () => {
    // Copy the shipped manifests into a scratch tree, run version-sync there
    // against a synthetic package.json, and assert every version-carrying
    // field ends up at the fresh version and the script exits 0. Derived from
    // SHIPPED so a manifest added to a new directory is covered automatically.
    const scratch = mkdtempSync(join(tmpdir(), "version-sync-test-"));
    try {
      const dirs = new Set<string>(["scripts"]);
      for (const t of SHIPPED) {
        const dir = t.split("/").slice(0, -1).join("/");
        if (dir) dirs.add(dir);
      }
      for (const d of dirs) mkdirSync(join(scratch, d), { recursive: true });

      // Copy the actual manifests (drives a real, not synthetic, assertion).
      for (const m of SHIPPED) {
        cpSync(resolve(REPO_ROOT, m), join(scratch, m));
      }
      cpSync(
        resolve(REPO_ROOT, "scripts/version-sync.mjs"),
        join(scratch, "scripts/version-sync.mjs"),
      );

      // Synthetic package.json with a fresh version we can detect.
      const TEST_VERSION = "9.9.9-test";
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ name: "ctxscribe", version: TEST_VERSION }, null, 2),
      );

      const result = spawnSync(process.execPath, ["scripts/version-sync.mjs"], {
        cwd: scratch,
        encoding: "utf8",
      });
      expect(result.status, `version-sync exited non-zero:\n${result.stderr}`).toBe(0);

      for (const m of SHIPPED) {
        const content = JSON.parse(readFileSync(join(scratch, m), "utf8"));
        const checks: Array<{ path: string; value: unknown }> = [];
        if (content.version !== undefined) checks.push({ path: "version", value: content.version });
        if (content.metadata?.version !== undefined) {
          checks.push({ path: "metadata.version", value: content.metadata.version });
        }
        if (Array.isArray(content.plugins)) {
          for (let i = 0; i < content.plugins.length; i++) {
            const p = content.plugins[i] as { version?: string };
            if (p.version !== undefined) {
              checks.push({ path: `plugins[${i}].version`, value: p.version });
            }
          }
        }
        for (const c of checks) {
          expect(c.value, `${m}.${c.path} should be ${TEST_VERSION}`).toBe(TEST_VERSION);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
