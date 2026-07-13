// Verify a /plugin update actually reinstalled at the expected version — the
// empirical test of I1 (the version string is the reinstall key).
//
// The verdict is grounded in the DEPLOYED CODE, not the registry path string.
// Guards against a FALSE PASS (the worst outcome — the user ships stale code
// believing it deployed):
//   1. Containment: each installPath must resolve to a version directory
//      DIRECTLY under the plugin cache dir (<cfg>/plugins/cache/wotjr1649/
//      ctxscribe/<version>). Lexical resolve() defeats "../.." traversal and
//      any path outside the cache; the CLI reader additionally realpath()s to
//      defeat a junction/symlink whose target escapes the cache. So an empty /
//      relative / repo-root / traversal installPath can never make the reader
//      fall back to some other package.json (e.g. the repo's own, read when the
//      tool is run from the repo per the runbook).
//   2. Both manifests: the root package.json AND .claude-plugin/plugin.json must
//      be present and agree; a half install where they diverge is not a deploy.
//      Distinct registry entries must also agree on one version.
//
// Pure functions for tests; the version reader and cacheDir are injected
// (fail-closed defaults) and the CLI wrapper supplies the real values.
import { resolve, relative } from "node:path";

const PLUGIN_KEY = "ctxscribe@wotjr1649";

/**
 * True iff installPath resolves to a version directory DIRECTLY under cacheDir
 * (cacheDir/<version>) — no traversal, no escape, not cacheDir itself.
 * @param {string} cacheDir - absolute plugin cache dir (…/wotjr1649/ctxscribe)
 * @param {string} installPath
 * @returns {boolean}
 */
export function isVersionDirUnderCache(cacheDir, installPath) {
  if (typeof cacheDir !== "string" || !cacheDir) return false;
  if (typeof installPath !== "string" || !installPath) return false;
  const rel = relative(resolve(cacheDir), resolve(installPath));
  return rel.length > 0 && !rel.startsWith("..") && !/[/\\]/.test(rel);
}

/**
 * @param {any} registry - parsed installed_plugins.json
 * @param {string} expectedVersion - the version the deploy should have landed
 * @param {(installPath: string) => { pkg: string | null, manifest: string | null }} [readDeployedVersions]
 *   - reads the deployed tree's root package.json + .claude-plugin/plugin.json
 *     versions; fail-closed default returns both null
 * @param {string} [cacheDir] - absolute plugin cache dir; entries whose
 *   installPath is not a version dir directly under it are rejected
 * @returns {{ ok: boolean, actual: string | null, reason: string }}
 */
export function verifyDeploy(registry, expectedVersion, readDeployedVersions = () => ({ pkg: null, manifest: null }), cacheDir = "") {
  const entries = registry?.plugins?.[PLUGIN_KEY];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, actual: null, reason: `plugin key ${PLUGIN_KEY} absent from installed_plugins.json` };
  }
  // Only entries whose installPath is a version dir directly under the cache
  // count. Rejects "", ".", relative paths, the repo root, "../.." traversal,
  // and any absolute path outside the cache — none may be read as the deploy.
  const valid = entries.filter((e) => e && isVersionDirUnderCache(cacheDir, e.installPath));
  if (valid.length === 0) {
    return { ok: false, actual: null, reason: "no entry has an installPath directly under the plugin cache dir" };
  }
  // Each valid entry must report a consistent, readable version across BOTH
  // manifests; distinct entries must agree on one version.
  const versions = new Set();
  for (const e of valid) {
    const { pkg, manifest } = readDeployedVersions(e.installPath);
    if (pkg == null) {
      return { ok: false, actual: null, reason: `cannot read deployed package.json under ${e.installPath} (deploy incomplete or broken)` };
    }
    if (manifest == null) {
      return { ok: false, actual: null, reason: `cannot read deployed .claude-plugin/plugin.json under ${e.installPath}` };
    }
    if (pkg !== manifest) {
      return { ok: false, actual: pkg, reason: `half install at ${e.installPath}: package.json ${pkg} vs .claude-plugin/plugin.json ${manifest}` };
    }
    versions.add(pkg);
  }
  if (versions.size > 1) {
    return { ok: false, actual: null, reason: `ambiguous: entries report different versions [${[...versions].sort().join(", ")}]` };
  }
  const deployed = [...versions][0];
  return {
    ok: deployed === expectedVersion,
    actual: deployed,
    reason: deployed === expectedVersion
      ? `deployed tree reports ${expectedVersion} (package.json + plugin.json agree)`
      : `deployed tree reports ${deployed}, expected ${expectedVersion}`,
  };
}

// CLI: node scripts/verify-deploy.mjs <expectedVersion>
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { readFileSync, realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const expected = process.argv[2];
  if (!expected || typeof expected !== "string") {
    console.error("usage: node scripts/verify-deploy.mjs <expectedVersion>");
    process.exit(2);
  }
  const cfg = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR.replace(/^~[/\\]?/, homedir() + "/"))
    : resolve(homedir(), ".claude");
  const cacheDir = resolve(cfg, "plugins", "cache", "wotjr1649", "ctxscribe");
  let registry;
  try {
    registry = JSON.parse(readFileSync(resolve(cfg, "plugins", "installed_plugins.json"), "utf8"));
  } catch (e) {
    console.error(`FATAL: cannot read installed_plugins.json: ${e.message}`);
    process.exit(2);
  }
  const readVersion = (p) => {
    try { return JSON.parse(readFileSync(p, "utf8")).version ?? null; } catch { return null; }
  };
  // Ground-truth reader: realpath the candidate + cache dir so a junction/symlink
  // that lexically looks in-cache but resolves elsewhere is rejected; only then
  // read the two manifests.
  const readDeployedVersions = (installPath) => {
    try {
      const realCache = realpathSync(cacheDir);
      const real = realpathSync(installPath);
      if (!isVersionDirUnderCache(realCache, real)) return { pkg: null, manifest: null };
      return {
        pkg: readVersion(join(real, "package.json")),
        manifest: readVersion(join(real, ".claude-plugin", "plugin.json")),
      };
    } catch {
      return { pkg: null, manifest: null };
    }
  };
  const r = verifyDeploy(registry, expected, readDeployedVersions, cacheDir);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
