import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteShellSnapshots } from "../../hooks/cache-heal-utils.mjs";

describe("rewriteShellSnapshots — trust anchor derived from pluginRoot (F52)", () => {
  let dir: string;
  let snapshots: string;

  // Real pluginRoot shape: …/cache/<marketplace>/<plugin>/<version>.
  // Omitting the version segment makes the depth guard no-op and the test
  // pass vacuously (false green).
  const pluginRootFor = (marketplace: string, plugin = "ctxscribe") =>
    `/home/u/.claude/plugins/cache/${marketplace}/${plugin}/1.0.0`;

  const writeSnapshot = (name: string, body: string) => {
    const p = join(snapshots, name);
    writeFileSync(p, body, "utf-8");
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snap-"));
    snapshots = join(dir, "shell-snapshots");
    mkdirSync(snapshots, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rewrites a stale version under the fork's wotjr1649/ctxscribe/", () => {
    const snap = writeSnapshot(
      "snapshot-bash-1.sh",
      'export PATH="/home/u/.claude/plugins/cache/wotjr1649/ctxscribe/0.9.9/bin:$PATH"\n',
    );
    rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: pluginRootFor("wotjr1649"),
    });
    expect(readFileSync(snap, "utf-8")).toContain("cache/wotjr1649/ctxscribe/1.0.0/bin");
  });

  it("still rewrites the un-renamed upstream layout when that is the anchor", () => {
    const snap = writeSnapshot(
      "snapshot-bash-2.sh",
      'export PATH="/home/u/.claude/plugins/cache/context-mode/context-mode/0.9.9/bin:$PATH"\n',
    );
    rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: pluginRootFor("context-mode", "context-mode"),
    });
    expect(readFileSync(snap, "utf-8")).toContain("cache/context-mode/context-mode/1.0.0/bin");
  });

  // Discriminating test. The fork's names are asymmetric
  // (wotjr1649 ≠ ctxscribe); slicing marketplace/plugin in the
  // inverted order makes this test fail.
  it("never touches another owner's directory, even under the fork anchor", () => {
    const original =
      'export PATH="/home/u/.claude/plugins/cache/evil-owner/context-mode/0.9.9/bin:/usr/bin"\n';
    const snap = writeSnapshot("snapshot-bash-spoof.sh", original);
    rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: pluginRootFor("wotjr1649"),
    });
    expect(readFileSync(snap, "utf-8")).toBe(original);
  });

  // Cases 4 and 5 use **upstream-layout content** on purpose. With fork-layout
  // content the old code would no-op anyway, so the assertion would pass
  // vacuously — zero discriminating power. With upstream content the old code
  // rewrites without consulting the anchor (FAIL); the new code hits the
  // guard and no-ops (PASS).
  it("no-ops when pluginRoot is absent — refuses to heal a tree it cannot name", () => {
    const original =
      'export PATH="/home/u/.claude/plugins/cache/context-mode/context-mode/0.9.9/bin"\n';
    const snap = writeSnapshot("snapshot-bash-noanchor.sh", original);
    const result = rewriteShellSnapshots({ snapshotsDir: snapshots, currentVersion: "1.0.0" });
    expect(result.rewritten).toEqual([]);
    expect(readFileSync(snap, "utf-8")).toBe(original);
  });

  // Depth trap: handing the cache PARENT (a draft-era leftover) must silently
  // no-op — pin that. For `…/cache/context-mode/context-mode`,
  // parts[-4] === "plugins", so the guard rejects it.
  it("no-ops when handed the cache parent instead of the versioned pluginRoot", () => {
    const original =
      'export PATH="/home/u/.claude/plugins/cache/context-mode/context-mode/0.9.9/bin"\n';
    const snap = writeSnapshot("snapshot-bash-depth.sh", original);
    const result = rewriteShellSnapshots({
      snapshotsDir: snapshots,
      currentVersion: "1.0.0",
      pluginRoot: "/home/u/.claude/plugins/cache/context-mode/context-mode",
    });
    expect(result.rewritten).toEqual([]);
    expect(readFileSync(snap, "utf-8")).toBe(original);
  });
});
