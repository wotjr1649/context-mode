// Verify a /plugin update actually reinstalled at the expected version —
// the empirical test of I1 (the version string is the reinstall key).
//
// The verdict is grounded in the DEPLOYED CODE, not the registry path string:
// a version bump only counts if the tree at installPath actually reports the
// new version. Two hardenings against a FALSE PASS (the worst outcome — the
// user ships stale code believing it deployed):
//   1. installPath must be a real plugin-cache path (…/context-mode-js/
//      context-mode/<version>/…). An empty / relative / repo-root installPath
//      is rejected, so the reader can never fall back to the CWD's package.json
//      (which, run from the repo per the runbook, would falsely report the
//      just-bumped version).
//   2. BOTH deployed manifests the plugin system trusts — the root package.json
//      AND .claude-plugin/plugin.json — must be present and agree; a half
//      install where they diverge is not a real deploy. Distinct registry
//      entries must also agree on one version.
//
// Pure function for tests; the version reader is injected (fail-closed default)
// and the CLI wrapper supplies the real filesystem reader.
const PLUGIN_KEY = "context-mode@context-mode-js";
const CACHE_ANCHOR = /context-mode-js[/\\]context-mode[/\\][^/\\]+/;

/**
 * @param {any} registry - parsed installed_plugins.json
 * @param {string} expectedVersion - the version the deploy should have landed
 * @param {(installPath: string) => { pkg: string | null, manifest: string | null }} [readDeployedVersions]
 *   - reads the deployed tree's root package.json + .claude-plugin/plugin.json
 *     versions; fail-closed default returns both null
 * @returns {{ ok: boolean, actual: string | null, reason: string }}
 */
export function verifyDeploy(registry, expectedVersion, readDeployedVersions = () => ({ pkg: null, manifest: null })) {
  const entries = registry?.plugins?.[PLUGIN_KEY];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, actual: null, reason: `plugin key ${PLUGIN_KEY} absent from installed_plugins.json` };
  }
  // Only entries whose installPath is a real plugin-cache path count. This
  // rejects "", ".", relative paths, and the repo root — none of which may be
  // read as "the deployed tree" (guards the CWD-read false PASS).
  const valid = entries.filter(
    (e) => e && typeof e.installPath === "string" && CACHE_ANCHOR.test(e.installPath),
  );
  if (valid.length === 0) {
    return { ok: false, actual: null, reason: "no entry has a valid context-mode plugin-cache installPath" };
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
  const { readFileSync } = await import("node:fs");
  const { resolve, join, isAbsolute } = await import("node:path");
  const { homedir } = await import("node:os");
  const expected = process.argv[2];
  if (!expected || typeof expected !== "string") {
    console.error("usage: node scripts/verify-deploy.mjs <expectedVersion>");
    process.exit(2);
  }
  const cfg = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR.replace(/^~[/\\]?/, homedir() + "/"))
    : resolve(homedir(), ".claude");
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
  // Ground-truth reader: only read from an ABSOLUTE installPath, so a stray
  // relative path can never resolve against the CWD.
  const readDeployedVersions = (installPath) => {
    if (!installPath || !isAbsolute(installPath)) return { pkg: null, manifest: null };
    return {
      pkg: readVersion(join(installPath, "package.json")),
      manifest: readVersion(join(installPath, ".claude-plugin", "plugin.json")),
    };
  };
  const r = verifyDeploy(registry, expected, readDeployedVersions);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
