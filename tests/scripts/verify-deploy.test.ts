import { describe, it, expect } from "vitest";
import { verifyDeploy } from "../../scripts/verify-deploy.mjs";

const CACHE = "/h/.claude/plugins/cache/context-mode-js/context-mode";
// registry with one valid cache entry at the given version dir
const reg = (installPath: string) => ({
  plugins: { "context-mode@context-mode-js": [{ version: "1.0.1", installPath }] },
});
// a reader that reports the same version from both manifests (a clean deploy)
const both = (v: string | null) => () => ({ pkg: v, manifest: v });

describe("verifyDeploy — did /plugin update actually reinstall at the new version?", () => {
  it("ok when both deployed manifests report the expected version", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", both("1.0.1"));
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });

  it("fails when the deployed tree still reports the old version (I1 refuted)", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.0`), "1.0.1", both("1.0.0"));
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
  });

  it("FALSE-PASS GUARD: a dir NAMED 1.0.1 whose code reports 1.0.0 must FAIL", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", both("1.0.0"));
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
  });

  it("B1 GUARD: an empty installPath is rejected and the reader is never consulted", () => {
    // Even a reader that WOULD report the expected version (as the CWD read did)
    // cannot flip the verdict — the empty path is not a valid cache path.
    const r = verifyDeploy(
      { plugins: { "context-mode@context-mode-js": [{ installPath: "" }] } },
      "1.0.1",
      both("1.0.1"),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no entry has a valid/);
  });

  it("B1 GUARD: a relative or repo-root installPath is rejected", () => {
    for (const p of [".", "C:\\Users\\me\\Documents\\ClaudeCode\\context-mode", "./context-mode"]) {
      const r = verifyDeploy(
        { plugins: { "context-mode@context-mode-js": [{ installPath: p }] } },
        "1.0.1",
        both("1.0.1"),
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no entry has a valid/);
    }
  });

  it("B2 GUARD: a half install (package.json 1.0.1, plugin.json 1.0.0) must FAIL", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", () => ({ pkg: "1.0.1", manifest: "1.0.0" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/half install/);
  });

  it("fails when a deployed manifest is unreadable (empty/broken dir)", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", () => ({ pkg: null, manifest: null }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot read deployed package\.json/);
  });

  it("I1: multiple entries that AGREE on the version PASS (multi-entry is not fatal)", () => {
    const registry = {
      plugins: {
        "context-mode@context-mode-js": [
          { installPath: `${CACHE}/1.0.1` },
          { scope: "project", installPath: `${CACHE}/1.0.1` },
        ],
      },
    };
    const r = verifyDeploy(registry, "1.0.1", both("1.0.1"));
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });

  it("I1: multiple entries that DISAGREE are ambiguous → FAIL", () => {
    const registry = {
      plugins: {
        "context-mode@context-mode-js": [
          { installPath: `${CACHE}/1.0.0` },
          { installPath: `${CACHE}/1.0.1` },
        ],
      },
    };
    // reader reports each entry's own dir version
    const r = verifyDeploy(registry, "1.0.1", (p: string) => {
      const v = p.includes("1.0.0") ? "1.0.0" : "1.0.1";
      return { pkg: v, manifest: v };
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ambiguous/);
  });

  it("fails when the plugin key is absent", () => {
    const r = verifyDeploy({ plugins: {} }, "1.0.1", both("1.0.1"));
    expect(r.ok).toBe(false);
    expect(r.actual).toBeNull();
  });

  it("does not misfire on a home path that itself contains a 'cache' segment", () => {
    const r = verifyDeploy(
      reg("/root/cache/x/.claude/plugins/cache/context-mode-js/context-mode/1.0.1"),
      "1.0.1",
      both("1.0.1"),
    );
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });
});
