import { describe, it, expect } from "vitest";
import { validateSpec, resolveModuleDir, installInvocation, installBudgetMs } from "../../hooks/deps-heal.mjs";
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

describe("deps-heal install invocation (defect #1 — node, never a .cmd shim)", () => {
  it("invokes node (process.execPath) with npm-cli.js — not npm.cmd/npm", () => {
    const { file, args } = installInvocation(
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "turndown@^7.2.0",
      "/root",
    );
    expect(file).toBe(process.execPath); // node — going through cmd.exe is the CVE-2024-27980 vector
    expect(file).not.toMatch(/\.cmd$/i);
    expect(args[0]).toMatch(/npm-cli\.js$/); // npm's JS entry, run directly
    expect(args[1]).toBe("install");
    expect(args).toContain("turndown@^7.2.0");
    expect(args).toContain("--ignore-scripts");
    expect(args.some((a: string) => /\.cmd$/i.test(a))).toBe(false); // no .cmd anywhere in argv
  });
});

describe("deps-heal loop budget (major — one shared deadline < ~60s host budget, not per-package)", () => {
  it("gives the full remaining budget when ample time is left, shrinking across installs", () => {
    // deadline 45s out, now = base → the first install may use the whole 45s.
    expect(installBudgetMs(1_000_000 + 45_000, 1_000_000)).toBe(45_000);
    // after 20s already spent, only ~25s remains — the NEXT install is capped to
    // what's left, so N slow installs can't sum past the ~60s host kill.
    expect(installBudgetMs(1_000_000 + 45_000, 1_000_000 + 20_000)).toBe(25_000);
  });
  it("returns 0 (stop + defer to next session) once less than the min-install floor remains", () => {
    // 4s left (< 5s floor) → 0 → caller breaks BEFORE the rm, so it never deletes
    // a partial it then lacks time to reinstall.
    expect(installBudgetMs(1_000_000 + 4_000, 1_000_000)).toBe(0);
    // exactly at / past the deadline → 0.
    expect(installBudgetMs(1_000_000, 1_000_000)).toBe(0);
    expect(installBudgetMs(1_000_000, 1_000_001)).toBe(0);
  });
});
