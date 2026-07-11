import { describe, it, expect } from "vitest";
import { verifyDeploy } from "../../scripts/verify-deploy.mjs";

const reg = (installPath: string) => ({
  plugins: { "context-mode@context-mode-js": [{ version: "1.0.1", installPath }] },
});
const CACHE = "/h/.claude/plugins/cache/context-mode-js/context-mode";

describe("verifyDeploy — did /plugin update actually reinstall at the new version?", () => {
  it("ok when the DEPLOYED tree reports the expected version", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", () => "1.0.1");
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });

  it("fails when the deployed tree still reports the old version (I1 refuted)", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.0`), "1.0.1", () => "1.0.0");
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
  });

  it("FALSE-PASS GUARD: a dir NAMED 1.0.1 whose code still reports 1.0.0 must FAIL", () => {
    // start.mjs forward-heal can point installPath at a stale/leftover 1.0.1 dir.
    // The path segment says 1.0.1, but the deployed package.json says 1.0.0 —
    // the verdict must follow the code, not the directory name.
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", () => "1.0.0");
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
    expect(r.reason).toMatch(/path segment says 1\.0\.1/);
  });

  it("fails when the deployed tree has no readable package.json (empty/broken dir)", () => {
    const r = verifyDeploy(reg(`${CACHE}/1.0.1`), "1.0.1", () => null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot read deployed package\.json/);
  });

  it("fails (ambiguous) when the plugin key has more than one entry", () => {
    const registry = {
      plugins: {
        "context-mode@context-mode-js": [
          { version: "1.0.0", installPath: `${CACHE}/1.0.0` },
          { version: "1.0.1", installPath: `${CACHE}/1.0.1` },
        ],
      },
    };
    const r = verifyDeploy(registry, "1.0.1", () => "1.0.1");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ambiguous/);
  });

  it("fails when the plugin key is absent", () => {
    const r = verifyDeploy({ plugins: {} }, "1.0.1", () => "1.0.1");
    expect(r.ok).toBe(false);
    expect(r.actual).toBeNull();
  });

  it("does not misfire on a home path that itself contains a 'cache' segment", () => {
    // Verdict is content-based, but the diagnostic path segment must still anchor
    // to context-mode-js/context-mode, not the first '/cache/' in the path.
    const r = verifyDeploy(
      reg("/root/cache/x/.claude/plugins/cache/context-mode-js/context-mode/1.0.1"),
      "1.0.1",
      () => "1.0.1",
    );
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });
});
