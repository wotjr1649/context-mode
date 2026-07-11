// Verify a /plugin update actually reinstalled at the expected version —
// the empirical test of I1 (the version string is the reinstall key).
// Pure function for tests; the CLI wrapper reads installed_plugins.json.
export function verifyDeploy(registry, expectedVersion) {
  const entries = registry?.plugins?.["context-mode@context-mode-js"];
  const installPath = Array.isArray(entries) && entries[0]?.installPath;
  if (typeof installPath !== "string") {
    return { ok: false, actual: null, reason: "plugin key absent from installed_plugins.json" };
  }
  // …/cache/<marketplace>/<plugin>/<version>[/…]
  const m = installPath.match(/[/\\]cache[/\\][^/\\]+[/\\][^/\\]+[/\\]([^/\\]+)/);
  const actual = m ? m[1] : null;
  return {
    ok: actual === expectedVersion,
    actual,
    reason: actual === expectedVersion
      ? `installPath points at ${expectedVersion}`
      : `installPath points at ${actual ?? "(unparseable)"}, expected ${expectedVersion}`,
  };
}

// CLI: node scripts/verify-deploy.mjs <expectedVersion>
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const cfg = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR.replace(/^~[/\\]?/, homedir() + "/"))
    : resolve(homedir(), ".claude");
  const expected = process.argv[2];
  let registry;
  try {
    registry = JSON.parse(readFileSync(resolve(cfg, "plugins", "installed_plugins.json"), "utf8"));
  } catch (e) {
    console.error(`FATAL: cannot read installed_plugins.json: ${e.message}`);
    process.exit(2);
  }
  const r = verifyDeploy(registry, expected);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
