import { describe, it, expect } from "vitest";
import { verifyDeploy, isVersionDirUnderCache } from "../../scripts/verify-deploy.mjs";

const CACHE = "/h/.claude/plugins/cache/wotjr1649/ctxscribe";
const reg = (installPath: string) => ({
  plugins: { "ctxscribe@wotjr1649": [{ installPath }] },
});
// a reader that reports the same version from both manifests (a clean deploy)
const both = (v: string | null) => () => ({ pkg: v, manifest: v });

describe("isVersionDirUnderCache — containment against the real cache dir", () => {
  it("accepts a version dir directly under the cache", () => {
    expect(isVersionDirUnderCache(CACHE, `${CACHE}/1.0.1`)).toBe(true);
  });
  it("rejects traversal, escape, empty, relative, the cache dir itself, and too-deep", () => {
    expect(isVersionDirUnderCache(CACHE, `${CACHE}/1.0.1/../../..`)).toBe(false); // Codex traversal repro
    expect(isVersionDirUnderCache(CACHE, "C:\\evil\\wotjr1649\\context-mode\\1.0.1")).toBe(false);
    expect(isVersionDirUnderCache(CACHE, "")).toBe(false);
    expect(isVersionDirUnderCache(CACHE, ".")).toBe(false);
    expect(isVersionDirUnderCache(CACHE, CACHE)).toBe(false); // cache dir itself is not a version dir
    expect(isVersionDirUnderCache(CACHE, `${CACHE}/1.0.1/sub`)).toBe(false); // too deep
    expect(isVersionDirUnderCache("", `${CACHE}/1.0.1`)).toBe(false); // no cacheDir -> fail-closed
  });
});

describe("verifyDeploy — did /plugin update actually reinstall at the new version?", () => {
  it("ok when both deployed manifests report the expected version", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", both("1.0.1"), CACHE);
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });

  it("fails when the deployed tree still reports the old version (I1 refuted)", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.0`), "1.0.1", both("1.0.0"), CACHE);
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
  });

  it("FALSE-PASS GUARD: a dir NAMED 1.0.1 whose code reports 1.0.0 must FAIL", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", both("1.0.0"), CACHE);
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
  });

  it("BLOCKER GUARD (traversal): a '..' installPath escaping the cache is rejected; reader never trusted", () => {
    // Codex repro: <cache>/1.0.1/../../.. resolves out of the cache. Even a reader
    // that WOULD report the expected version cannot flip the verdict.
    const r = verifyDeploy(reg(`${CACHE}/1.0.1/../../..`), "1.0.1", both("1.0.1"), CACHE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no entry has an installPath directly under/);
  });

  it("B1 GUARD: empty / relative / repo-root / non-cache installPath is rejected", () => {
    for (const p of ["", ".", "C:\\Users\\me\\Documents\\ClaudeCode\\context-mode", "C:\\evil\\wotjr1649\\context-mode\\1.0.1"]) {
      const r = verifyDeploy(reg(p), "1.0.1", both("1.0.1"), CACHE);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no entry has an installPath directly under/);
    }
  });

  it("B2 GUARD: a half install (package.json 1.0.1, plugin.json 1.0.0) must FAIL", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", () => ({ pkg: "1.0.1", manifest: "1.0.0" }), CACHE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/half install/);
  });

  it("fails when a deployed manifest is unreadable (empty/broken dir)", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", () => ({ pkg: null, manifest: null }), CACHE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot read deployed package\.json/);
  });

  it("I1: multiple entries that AGREE pass; that DISAGREE are ambiguous", () => {
    const agree = {
      plugins: { "ctxscribe@wotjr1649": [{ installPath: `${CACHE}/1.0.1` }, { installPath: `${CACHE}/1.0.1` }] },
    };
    expect(verifyDeploy(agree, "1.0.1", both("1.0.1"), CACHE).ok).toBe(true);

    const disagree = {
      plugins: { "ctxscribe@wotjr1649": [{ installPath: `${CACHE}/1.0.0` }, { installPath: `${CACHE}/1.0.1` }] },
    };
    const r = verifyDeploy(disagree, "1.0.1", (p: string) => {
      const v = p.includes("1.0.0") ? "1.0.0" : "1.0.1";
      return { pkg: v, manifest: v };
    }, CACHE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ambiguous/);
  });

  it("fails when the plugin key is absent", () => {
    const r = verifyDeploy({ plugins: {} }, "1.0.1", both("1.0.1"), CACHE);
    expect(r.ok).toBe(false);
    expect(r.actual).toBeNull();
  });
});
