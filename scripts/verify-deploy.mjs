// Verify a /plugin update actually reinstalled at the expected version —
// the empirical test of I1 (the version string is the reinstall key).
//
// The verdict is grounded in the DEPLOYED CODE, not the registry path string:
// a version bump only counts if the tree at installPath actually reports the
// new version in its own package.json. Trusting the path string alone is unsafe
// in this fork — start.mjs's forward-heal rewrites installPath to the highest-
// semver DIRECTORY NAME in the cache parent, so a stale or empty `1.0.1/` dir
// would make a name-only check report PASS on old code. A false PASS is the
// worst outcome (the user ships stale code believing it deployed), so the reader
// below reads the deployed package.json and the default is fail-closed.
//
// Pure function for tests; the version reader is injected and the CLI wrapper
// supplies the real filesystem reader.
const PLUGIN_KEY = "context-mode@context-mode-js";

/**
 * @param {any} registry - parsed installed_plugins.json
 * @param {string} expectedVersion - the version the deploy should have landed
 * @param {(installPath: string) => (string | null)} [readDeployedVersion] - reads
 *   the deployed tree's package.json version; fail-closed default returns null
 * @returns {{ ok: boolean, actual: string | null, reason: string }}
 */
export function verifyDeploy(registry, expectedVersion, readDeployedVersion = () => null) {
  const entries = registry?.plugins?.[PLUGIN_KEY];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, actual: null, reason: `plugin key ${PLUGIN_KEY} absent from installed_plugins.json` };
  }
  if (entries.length !== 1) {
    // Ambiguous: which entry is the active install? Refuse to guess (reading the
    // wrong entry could produce a false PASS or false FAIL) rather than pick [0].
    return { ok: false, actual: null, reason: `ambiguous: ${entries.length} entries for ${PLUGIN_KEY}` };
  }
  const installPath = entries[0]?.installPath;
  if (typeof installPath !== "string") {
    return { ok: false, actual: null, reason: "installPath missing from the active entry" };
  }
  // Diagnostic only — the version segment of the fork's own path shape
  // (…/context-mode-js/context-mode/<version>/…). Anchored to the marketplace +
  // plugin segments so an earlier "cache" segment in the home path can't misfire.
  const m = installPath.match(/context-mode-js[/\\]context-mode[/\\]([^/\\]+)/);
  const pathVersion = m ? m[1] : null;
  // Ground truth: what version does the DEPLOYED tree actually report?
  const deployed = readDeployedVersion(installPath);
  if (deployed == null) {
    return {
      ok: false,
      actual: pathVersion,
      reason: `cannot read deployed package.json under ${installPath} (deploy incomplete or broken)`,
    };
  }
  const ok = deployed === expectedVersion;
  const drift = pathVersion && pathVersion !== deployed ? ` (path segment says ${pathVersion})` : "";
  return {
    ok,
    actual: deployed,
    reason: ok
      ? `deployed tree reports ${expectedVersion}${drift}`
      : `deployed tree reports ${deployed}, expected ${expectedVersion}${drift}`,
  };
}

// CLI: node scripts/verify-deploy.mjs <expectedVersion>
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
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
  // Ground-truth reader: the deployed tree's own package.json version.
  const readDeployedVersion = (installPath) => {
    try {
      return JSON.parse(readFileSync(join(installPath, "package.json"), "utf8")).version ?? null;
    } catch {
      return null;
    }
  };
  const r = verifyDeploy(registry, expected, readDeployedVersion);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
