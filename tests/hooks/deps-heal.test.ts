import { describe, it, expect } from "vitest";
import { validateSpec, resolveModuleDir } from "../../hooks/deps-heal.mjs";
import { resolve } from "node:path";

describe("deps-heal spec validation (defect #1 — shell injection)", () => {
  it("accepts a clean package name + semver range", () => {
    expect(validateSpec("turndown", "^7.2.0")).toBe(true);
    expect(validateSpec("@mixmark-io/domino", "2.2.0")).toBe(true);
  });
  it("rejects a range carrying shell metacharacters", () => {
    expect(validateSpec("turndown", "^7 & echo pwned")).toBe(false);
    expect(validateSpec("turndown", "$(rm -rf /)")).toBe(false);
    expect(validateSpec("turndown", "7`whoami`")).toBe(false);
  });
  it("rejects newlines and tabs in a range (only a literal space is allowed)", () => {
    // A real semver range needs at most a single space (">=1 <2"); newlines
    // and tabs never occur in one. Excluding them keeps this whitelist from
    // leaning on execFileSync's newline handling on unpatched Node.
    expect(validateSpec("turndown", "7\n rm x")).toBe(false);
    expect(validateSpec("turndown", "7\ttab")).toBe(false);
    expect(validateSpec("turndown", "7\r\n x")).toBe(false);
    expect(validateSpec("turndown", ">=1 <2")).toBe(true); // legitimate space survives
  });
  it("rejects a name with shell metacharacters or traversal", () => {
    expect(validateSpec("turndown; rm x", "1.0.0")).toBe(false);
    expect(validateSpec("../../evil", "1.0.0")).toBe(false);
  });
});

describe("deps-heal module dir resolution (defect #3 — path traversal)", () => {
  const root = resolve("/tmp/fake-plugin-root");
  it("resolves a normal scoped name under node_modules", () => {
    expect(resolveModuleDir(root, "@mixmark-io/domino"))
      .toBe(resolve(root, "node_modules", "@mixmark-io", "domino"));
  });
  it("returns null when the name escapes node_modules", () => {
    expect(resolveModuleDir(root, "../../../etc")).toBeNull();
    expect(resolveModuleDir(root, "..")).toBeNull();
  });
});
