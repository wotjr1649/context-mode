/**
 * package.json entry-point policy.
 *
 * Phase 3 deleted every third-party editor adapter (opencode, cursor, zed,
 * ...), yet `main` and `exports["."]` still pointed at
 * `./build/adapters/opencode/plugin.js`. `private: true` kept the broken
 * entry off npm, but `require("context-mode")` / `import "context-mode"`
 * resolved to a file that no longer exists. Pin both entry points off any
 * deleted-adapter build path so the defect cannot silently return.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

// Adapters removed in phase 3; no package entry point may resolve into any of
// their build directories.
const DELETED_ADAPTER =
  /adapters\/(opencode|pi|omp|openclaw|cursor|kimi|kiro|zed|gemini-cli|qwen-code|antigravity|jetbrains-copilot|copilot-cli|vscode-copilot|kilo)\//;

describe("package.json entry points", () => {
  it("main does not point at a deleted adapter", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.main).not.toMatch(DELETED_ADAPTER);
  });

  it('exports["."] does not point at a deleted adapter', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.exports?.["."]).not.toMatch(DELETED_ADAPTER);
  });
});
