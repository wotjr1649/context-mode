import { describe, it, expect } from "vitest";
import { verifyDeploy } from "../../scripts/verify-deploy.mjs";

const reg = (installPath: string) => ({
  plugins: { "context-mode@context-mode-js": [{ version: "1.0.1", installPath }] },
});

describe("verifyDeploy — did /plugin update actually reinstall at the new version?", () => {
  it("ok when the active installPath's version segment matches expected", () => {
    const r = verifyDeploy(reg("/h/.claude/plugins/cache/context-mode-js/context-mode/1.0.1"), "1.0.1");
    expect(r.ok).toBe(true);
    expect(r.actual).toBe("1.0.1");
  });
  it("fails when the tree still points at the old version (I1 refuted)", () => {
    const r = verifyDeploy(reg("/h/.claude/plugins/cache/context-mode-js/context-mode/1.0.0"), "1.0.1");
    expect(r.ok).toBe(false);
    expect(r.actual).toBe("1.0.0");
  });
  it("fails when the plugin key is absent", () => {
    const r = verifyDeploy({ plugins: {} }, "1.0.1");
    expect(r.ok).toBe(false);
    expect(r.actual).toBeNull();
  });
});
