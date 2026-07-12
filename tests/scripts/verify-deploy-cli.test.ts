// CLI-wrapper integration tests for scripts/verify-deploy.mjs — the standing
// release gate for every 1.0.x. The pure functions (verifyDeploy,
// isVersionDirUnderCache) are unit-tested in verify-deploy.test.ts; here we
// SPAWN the script end to end to pin the CLI contract: exit codes 0/1/2, the
// PASS/FAIL/FATAL text on the RIGHT channel (stdout vs stderr), CLAUDE_CONFIG_DIR
// resolution, and the realpathSync junction guard (win32).
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/verify-deploy.mjs", import.meta.url));

type RunResult = { status: number | null; signal: string | null; stdout: string; stderr: string };

const created: string[] = [];
// An EMPTY fake home so the CLI's default (~/.claude) resolution finds no
// registry: any test that PASSes therefore proves CLAUDE_CONFIG_DIR was honored,
// not that the real ~/.claude coincidentally satisfied the assertion.
let fakeHome = "";
beforeAll(() => { fakeHome = mkdtempSync(join(tmpdir(), "vd-home-")); });
afterEach(() => {
  for (const d of created.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});
afterAll(() => { try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ } });

/**
 * Run the verify-deploy CLI under a scoped CLAUDE_CONFIG_DIR + empty fake home.
 * Uses spawnSync (no throw on non-zero) so exit status, signal, and both output
 * channels are checked SEPARATELY — a signal/spawn death is never silently
 * folded into a normal FAIL verdict.
 */
function run(args: string[], cfgDir: string): RunResult {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: cfgDir },
    encoding: "utf8",
    timeout: 30000,
  });
  if (r.error) throw r.error; // spawn failure or timeout kill — surface, never mask as a verdict
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// The CLI prints exactly one verdict line: `PASS  <reason>` / `FAIL  <reason>`
// (two spaces) to stdout, or `FATAL: …` / `usage: …` to stderr. Anchor on the
// channel + line start AND assert the opposite verdict is absent, so a combined
// or wrong-cause message can't pass.
function expectPass(r: RunResult, versionSubstr?: string): void {
  expect(r.signal).toBeNull();
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^PASS {2}/m);
  expect(r.stdout).not.toMatch(/^FAIL/m);
  if (versionSubstr) expect(r.stdout).toContain(versionSubstr);
}
function expectFail(r: RunResult, reasonSubstr: string): void {
  expect(r.signal).toBeNull();
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/^FAIL {2}/m);
  expect(r.stdout).not.toMatch(/^PASS/m);
  expect(r.stdout).toContain(reasonSubstr);
}
function expectFatal(r: RunResult, channelRe: RegExp): void {
  expect(r.signal).toBeNull();
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(channelRe);
  expect(r.stdout).not.toMatch(/^(PASS|FAIL)/m); // no verdict emitted on FATAL
}

interface CfgOpts {
  /** version dir name under the cache (the installPath leaf); null = create no version dir */
  installVersion?: string | null;
  /** package.json version written in the deployed tree; null = do not write package.json */
  pkgVersion?: string | null;
  /** plugin.json version; defaults to pkgVersion; null = do not write plugin.json */
  manifestVersion?: string | null;
  /** verbatim installed_plugins.json text (overrides the default single valid entry) */
  registryText?: string;
  /** do not write installed_plugins.json at all (→ FATAL exit 2) */
  noRegistry?: boolean;
}

/**
 * Build a temp CLAUDE_CONFIG_DIR with a plugins/ tree and return its path.
 * Default: one valid registry entry pointing at a <cache>/<version> dir whose
 * package.json + plugin.json both report `version`.
 */
function makeCfg(opts: CfgOpts = {}): string {
  const cfg = mkdtempSync(join(tmpdir(), "vd-cli-"));
  created.push(cfg);
  const pluginsDir = join(cfg, "plugins");
  const cacheDir = join(pluginsDir, "cache", "context-mode-js", "context-mode");
  mkdirSync(cacheDir, { recursive: true });

  const version = opts.installVersion === undefined ? "1.0.2" : opts.installVersion;
  let installPath = "";
  if (version != null) {
    const verDir = join(cacheDir, version);
    mkdirSync(join(verDir, ".claude-plugin"), { recursive: true });
    installPath = verDir;
    const pkgV = opts.pkgVersion === undefined ? version : opts.pkgVersion;
    const manV = opts.manifestVersion === undefined ? pkgV : opts.manifestVersion;
    if (pkgV != null) writeFileSync(join(verDir, "package.json"), JSON.stringify({ version: pkgV }));
    if (manV != null) writeFileSync(join(verDir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: manV }));
  }

  if (!opts.noRegistry) {
    const registryText = opts.registryText ??
      JSON.stringify({ plugins: { "context-mode@context-mode-js": [{ installPath }] } });
    writeFileSync(join(pluginsDir, "installed_plugins.json"), registryText);
  }
  return cfg;
}

describe("verify-deploy CLI — exit codes and verdict text", () => {
  it("exit 2 (usage) when no <expectedVersion> arg is given", () => {
    expectFatal(run([], makeCfg()), /^usage: /m);
  });

  it("exit 2 (FATAL) when installed_plugins.json is missing", () => {
    expectFatal(run(["1.0.2"], makeCfg({ noRegistry: true })), /^FATAL: cannot read installed_plugins\.json/m);
  });

  it("exit 2 (FATAL) when installed_plugins.json is malformed JSON", () => {
    expectFatal(run(["1.0.2"], makeCfg({ registryText: "{ this is not json" })), /^FATAL: cannot read installed_plugins\.json/m);
  });

  it("exit 0 (PASS) when both deployed manifests report the expected version", () => {
    expectPass(run(["1.0.2"], makeCfg({ installVersion: "1.0.2" })), "1.0.2");
  });

  it("exit 1 (FAIL) on version mismatch (deployed 1.0.1, expected 1.0.2)", () => {
    expectFail(run(["1.0.2"], makeCfg({ installVersion: "1.0.1" })), "expected 1.0.2");
  });

  it("exit 1 (FAIL) when the plugin key is absent from the registry", () => {
    expectFail(run(["1.0.2"], makeCfg({ registryText: JSON.stringify({ plugins: {} }) })), "absent");
  });

  it("exit 1 (FAIL) when installPath is not directly under the plugin cache dir", () => {
    const cfg = makeCfg({ installVersion: null, noRegistry: true });
    // installPath = the cfg root, which sits ABOVE the cache dir → rejected.
    writeFileSync(
      join(cfg, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "context-mode@context-mode-js": [{ installPath: cfg }] } }),
    );
    expectFail(run(["1.0.2"], cfg), "directly under the plugin cache");
  });

  it("exit 1 (FAIL) on a half install (package.json 1.0.2 vs plugin.json 1.0.1)", () => {
    expectFail(run(["1.0.2"], makeCfg({ installVersion: "1.0.2", pkgVersion: "1.0.2", manifestVersion: "1.0.1" })), "half install");
  });

  it("exit 1 (FAIL) when the deployed package.json is missing (broken/incomplete deploy)", () => {
    expectFail(run(["1.0.2"], makeCfg({ installVersion: "1.0.2", pkgVersion: null, manifestVersion: "1.0.2" })), "cannot read deployed package.json");
  });

  it("honors CLAUDE_CONFIG_DIR — a PASS proves resolution used the scoped tree, not the (empty) fake home", () => {
    // fakeHome has no plugins/ registry, so if the CLI ignored CLAUDE_CONFIG_DIR
    // this would FATAL/FAIL instead of PASS. A PASS at a version only the temp
    // tree knows about is the proof.
    expectPass(run(["9.9.9"], makeCfg({ installVersion: "9.9.9" })), "9.9.9");
  });

  it.skipIf(process.platform !== "win32")(
    "exit 1 (FAIL) — realpath guard rejects a junction whose target escapes the cache",
    () => {
      const cfg = makeCfg({ installVersion: null, noRegistry: true });
      // A real, complete deploy tree OUTSIDE the cache, reporting the expected version.
      const evil = join(cfg, "evil", "1.0.2");
      mkdirSync(join(evil, ".claude-plugin"), { recursive: true });
      writeFileSync(join(evil, "package.json"), JSON.stringify({ version: "1.0.2" }));
      writeFileSync(join(evil, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.2" }));
      // A junction that lexically sits directly under the cache but resolves to evil.
      const cacheDir = join(cfg, "plugins", "cache", "context-mode-js", "context-mode");
      const junction = join(cacheDir, "1.0.2");
      symlinkSync(evil, junction, "junction");
      writeFileSync(
        join(cfg, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "context-mode@context-mode-js": [{ installPath: junction }] } }),
      );
      // realpathSync resolves the junction out of the cache → reader returns null
      // → "cannot read deployed package.json", NOT a false PASS on the escaped tree.
      expectFail(run(["1.0.2"], cfg), "cannot read deployed package.json");
    },
  );
});
