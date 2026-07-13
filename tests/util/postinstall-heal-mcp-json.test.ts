/**
 * sweepStaleMcpJson — plugin-key → cache-path mapping (F54).
 *
 * The install-time `.mcp.json` sweep (Issue #609) runs from start.mjs on every
 * MCP boot and from cli.ts at upgrade time — see start-mjs-self-heal.test.ts.
 * postinstall.mjs used to carry a redundant copy, but it sat behind the inert
 * `isGlobalInstall() && PLUGIN_KEY` guard; Task 9 removed that dead block. What
 * remains to pin here is the pure-function contract of the shared helper:
 * sweepStaleMcpJson must map a two-segment `plugin@marketplace` key to
 * `<cacheRoot>/<marketplace>/<plugin>/` and reject traversal / malformed keys.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepStaleMcpJson } from "../../scripts/heal-installed-plugins.mjs";

// ─────────────────────────────────────────────────────────────────────────
// F54 — sweepStaleMcpJson's pluginKey->path mapping was inverted. It only
// worked pre-rename because upstream's marketplace and plugin names were
// identical, which made the inversion invisible. Post-rename (marketplace
// "wotjr1649", plugin "ctxscribe") the mapping built `<cacheRoot>/<plugin>/<marketplace>`
// instead of the real `<cacheRoot>/<marketplace>/<plugin>` layout, so the
// sweep always reported skipped:"no-plugin-dir" and never removed anything.
// ─────────────────────────────────────────────────────────────────────────

describe("sweepStaleMcpJson — plugin-key mapping (F54)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sweep-rename-"));
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("sweeps .mcp.json when marketplace name differs from plugin name", () => {
    const versionDir = join(root, "wotjr1649", "ctxscribe", "1.0.0");
    mkdirSync(versionDir, { recursive: true });
    const stale = join(versionDir, ".mcp.json");
    writeFileSync(stale, "{}", "utf-8");

    const result = sweepStaleMcpJson({
      pluginCacheRoot: root,
      pluginKey: "ctxscribe@wotjr1649",
    });

    expect(result.skipped).toBeUndefined();
    expect(result.removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
  });

  it("rejects a traversal segment that normalizes back inside the cache root", () => {
    const result = sweepStaleMcpJson({ pluginCacheRoot: root, pluginKey: "../victim@wotjr1649" });
    expect(result.skipped).toBe("bad-plugin-key");
    expect(result.removed).toEqual([]);
  });

  it("rejects a key with more than two segments", () => {
    expect(sweepStaleMcpJson({ pluginCacheRoot: root, pluginKey: "a@b@c" }).skipped).toBe("bad-plugin-key");
  });

  it("rejects a bare '..' segment", () => {
    expect(sweepStaleMcpJson({ pluginCacheRoot: root, pluginKey: "ctxscribe@.." }).skipped)
      .toBe("bad-plugin-key");
  });
});
