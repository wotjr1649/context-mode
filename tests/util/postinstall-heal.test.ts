/**
 * scripts/postinstall.mjs — installed_plugins.json self-heal contract.
 *
 * v1.0.114 hotfix for users broken by v1.0.113's `/ctx-upgrade`. Their
 * Claude Code plugin loader rejects context-mode → MCP gone → they
 * can't run `/ctx-upgrade` to recover. The escape hatch is `npm install
 * -g context-mode@1.0.114` whose postinstall MUST repair their registry.
 *
 * These integration tests spawn `node scripts/postinstall.mjs` in a
 * subprocess with isolated HOME and assert end-to-end behavior:
 *   - Heals when run as a true `npm install -g` (npm_config_global=true).
 *   - Skips silently when run as a contributor's local `npm install`.
 *   - One-line stderr summary; no walls of text, no scary noise.
 *   - No-op when registry already healthy.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const REPO_POSTINSTALL = resolve(REPO_ROOT, "scripts", "postinstall.mjs");
const REPO_HEAL_IP = resolve(REPO_ROOT, "scripts", "heal-installed-plugins.mjs");
const REPO_HEAL_SQLITE3 = resolve(REPO_ROOT, "scripts", "heal-better-sqlite3.mjs");
const KEY = "context-mode@context-mode";

/**
 * Simulate an `npm install -g` package layout: copy postinstall + its
 * sibling helper modules into a tmpdir that has NO `.git` ancestor. The
 * `isGlobalInstall()` heuristic in postinstall.mjs walks up looking for
 * `.git` and skips heal if found — exactly what we want during contributor
 * `npm install` runs but exactly what we have to *bypass* in vitest, since
 * the test always lives inside a git checkout.
 *
 * The staged root MUST also shape as `plugins/cache/<marketplace>/<plugin>/
 * <version>` — postinstall.mjs now derives its registry key from pkgRoot via
 * derivePluginKey() (Task 3b) instead of a hardcoded literal, and refuses to
 * heal (by design) when pkgRoot isn't inside a plugin cache. A real `npm
 * install -g` from the npm registry can't happen for this "private": true
 * fork; the realistic case this fixture stands in for is "deps-heal" — npm
 * reinstalling INSIDE an already-installed plugin cache directory. Using the
 * literal marketplace/plugin segment "context-mode" (upstream layout) keeps
 * the derived key equal to the `KEY` constant below — no other change needed.
 *
 * Pass layout "npm-global" to stage the true `npm install -g` shape instead
 * (outside any plugins/cache) — used by the Task 3b null→skip contract pin.
 */
function stagePostinstallPackage(layout: "cache" | "npm-global" = "cache"): {
  scriptPath: string;
  packageDir: string;
} {
  const base = mkdtempSync(join(tmpdir(), "ctx-postinstall-global-root-"));
  cleanups.push(base);
  // Keep the fake package several levels below tmpdir. isGlobalInstall() only
  // scans four ancestors; this prevents ambient markers like /tmp/.git from
  // making the staged global-install fixture look like a contributor checkout.
  const root = layout === "npm-global"
    ? join(base, "npm", "lib", "node_modules", "context-mode")
    : join(base, "plugins", "cache", "context-mode", "context-mode", "1.0.0");
  const scriptsDir = join(root, "scripts");
  const hooksDir = join(root, "hooks");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(REPO_POSTINSTALL, join(scriptsDir, "postinstall.mjs"));
  copyFileSync(REPO_HEAL_IP, join(scriptsDir, "heal-installed-plugins.mjs"));
  copyFileSync(REPO_HEAL_SQLITE3, join(scriptsDir, "heal-better-sqlite3.mjs"));
  // postinstall imports ../hooks/normalize-hooks.mjs — provide a no-op stub
  // so the import does not crash. Real postinstall wraps the import in
  // try/catch so even a missing file is fine, but copying a stub keeps the
  // test focused on the heal contract, not on Windows hook normalization.
  writeFileSync(
    join(hooksDir, "normalize-hooks.mjs"),
    "export function normalizeHooksOnStartup() {}\n",
  );
  return { scriptPath: join(scriptsDir, "postinstall.mjs"), packageDir: root };
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop();
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

function makeTmp(prefix = "ctx-postinstall-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

interface FakeHome {
  home: string;
  registryPath: string;
  cacheDir: string;
}

/**
 * Lay out a fake HOME with `~/.claude/plugins/installed_plugins.json`
 * + a context-mode cache dir whose plugin.json declares `cacheVersion`.
 */
function buildFakeHome(opts: {
  entryVersion: string;
  cacheVersion: string;
  enabledPlugins?: unknown;
}): FakeHome {
  const home = makeTmp("ctx-postinstall-home-");
  const pluginsRoot = resolve(home, ".claude", "plugins");
  const cacheDir = resolve(pluginsRoot, "cache", "context-mode", "context-mode", opts.cacheVersion);
  mkdirSync(resolve(cacheDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    resolve(cacheDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "context-mode", version: opts.cacheVersion }, null, 2),
  );
  const registry: Record<string, unknown> = {
    version: 2,
    plugins: {
      [KEY]: [
        {
          scope: "user",
          installPath: cacheDir,
          version: opts.entryVersion,
          installedAt: "2025-01-01T00:00:00.000Z",
          lastUpdated: "2025-01-01T00:00:00.000Z",
        },
      ],
    },
  };
  if (opts.enabledPlugins !== undefined) registry.enabledPlugins = opts.enabledPlugins;
  const registryPath = resolve(pluginsRoot, "installed_plugins.json");
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return { home, registryPath, cacheDir };
}

/**
 * Spawn a staged copy of postinstall (in a no-`.git` package layout) with
 * isolated HOME and chosen `npm_config_global` value. Returns
 * { stdout, stderr, status }.
 */
function runPostinstall(opts: {
  home: string;
  global: boolean;
  layout?: "cache" | "npm-global";
}): { stdout: string; stderr: string; status: number | null } {
  const staged = stagePostinstallPackage(opts.layout);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: opts.home,
    USERPROFILE: opts.home,
  };
  if (opts.global) env.npm_config_global = "true";
  const r = spawnSync(process.execPath, [staged.scriptPath], {
    cwd: staged.packageDir,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 — non-global install must NOT mutate registry
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — non-global install (contributor `npm install`)", () => {
  it("does NOT heal installed_plugins.json when npm_config_global is unset", { timeout: 90_000 }, () => {
    const fake = buildFakeHome({
      entryVersion: "1.0.99",      // poisoned
      cacheVersion: "1.0.113",     // would be healed if we ran
      enabledPlugins: {},
    });

    const before = readFileSync(fake.registryPath, "utf-8");
    const r = runPostinstall({ home: fake.home, global: false });
    // Best-effort posture — postinstall must never crash.
    expect(r.status === 0 || r.status === null).toBe(true);

    // Registry MUST be untouched.
    expect(readFileSync(fake.registryPath, "utf-8")).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 6b — Task 3b null→skip contract pin (re-armed in Task 9's fix round).
//
// A TRUE npm-global layout (`…/npm/lib/node_modules/context-mode`, outside
// any plugins/cache tree) makes derivePluginKey(pkgRoot) return null, and
// postinstall MUST then skip every PLUGIN_KEY-gated action — never fall back
// to the hardcoded upstream key.
//
// Observable: Task 9 deleted the dead registry/settings heal block, so the
// ONLY live PLUGIN_KEY consumer left in postinstall.mjs is the
// "Self-heal Layer 3: Backward symlink" block ("── 0."): for a registry entry whose installPath
// is dangling (non-existent, under the cache root) it creates a
// symlink/junction at that path. The fixture below plants exactly such an
// entry under the upstream-literal key. If someone reintroduces
// `derivePluginKey(pkgRoot) ?? "context-mode@context-mode"`, the block
// enters, symlinks the dangling installPath, and the existsSync tripwire
// below fails. (Mutation-verified — see the Task 9 fix-round report.)
//
// The byte-identity checks are a secondary invariant: no postinstall code
// path may write installed_plugins.json or settings.json at all.
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — Task 3b: npm-global layout (outside plugin cache) skips all heals", () => {
  // 90s budget — same rationale as siblings: section 3 (heal-better-sqlite3)
  // runs live in this subprocess and can take 20-30s on cold CI runners.
  it("does not symlink a dangling installPath; registry and settings.json stay byte-identical", { timeout: 90_000 }, () => {
    const fake = buildFakeHome({
      entryVersion: "1.0.99",
      cacheVersion: "1.0.113",
      enabledPlugins: {},
    });
    // Dangling installPath under the cache root: satisfies every backward-
    // symlink (Layer 3) precondition except the PLUGIN_KEY gate itself — the key matches the
    // upstream literal, the path does not exist, and it sits inside
    // <home>/.claude/plugins/cache so the traversal guard
    // (`resolve(rp).startsWith(cacheRoot + sep)`) would not skip it.
    const danglingPath = resolve(
      fake.home, ".claude", "plugins", "cache", "context-mode", "context-mode", "9.9.9-dangling",
    );
    const registry = JSON.parse(readFileSync(fake.registryPath, "utf-8")) as {
      plugins: Record<string, Array<Record<string, unknown>>>;
    };
    registry.plugins[KEY].push({
      scope: "user",
      installPath: danglingPath,
      version: "9.9.9-dangling",
      installedAt: "2025-01-01T00:00:00.000Z",
      lastUpdated: "2025-01-01T00:00:00.000Z",
    });
    writeFileSync(fake.registryPath, JSON.stringify(registry, null, 2) + "\n");

    const settingsPath = resolve(fake.home, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }, null, 2) + "\n");

    const registryBefore = readFileSync(fake.registryPath, "utf-8");
    const settingsBefore = readFileSync(settingsPath, "utf-8");

    const r = runPostinstall({ home: fake.home, global: true, layout: "npm-global" });
    expect(r.status === 0 || r.status === null).toBe(true);

    // Armed tripwire: a non-null (fallback) PLUGIN_KEY would have entered
    // the backward-symlink block (Self-heal Layer 3) and created a
    // symlink/junction at the dangling installPath.
    expect(existsSync(danglingPath)).toBe(false);

    // Secondary invariant: nothing in postinstall writes these files.
    expect(readFileSync(fake.registryPath, "utf-8")).toBe(registryBefore);
    expect(readFileSync(settingsPath, "utf-8")).toBe(settingsBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 7b — running from an /ctx-upgrade tmpdir staging path MUST NOT
// normalize hooks.json. /ctx-upgrade clones the repo to
// `<tmpdir>/context-mode-upgrade-<epoch>/` and runs `npm install` there
// before `cpSync`-ing into the real pluginRoot. If postinstall normalized
// hooks.json here, the absolute tmpdir paths would get baked in and then
// copied to the real plugin dir — every subsequent hook fire would fail
// with MODULE_NOT_FOUND once the tmpdir is cleaned up.
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — /ctx-upgrade tmpdir staging guard", () => {
  it("does NOT mutate hooks.json when pkgRoot matches context-mode-upgrade-<digits>", { timeout: 90_000 }, () => {
    // Lay out a package dir with the exact name shape /ctx-upgrade uses.
    const parent = makeTmp("ctx-postinstall-tmproot-");
    const packageDir = join(parent, `context-mode-upgrade-${Date.now()}`);
    const scriptsDir = join(packageDir, "scripts");
    const hooksDir = join(packageDir, "hooks");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(REPO_POSTINSTALL, join(scriptsDir, "postinstall.mjs"));
    copyFileSync(REPO_HEAL_IP, join(scriptsDir, "heal-installed-plugins.mjs"));
    copyFileSync(REPO_HEAL_SQLITE3, join(scriptsDir, "heal-better-sqlite3.mjs"));
    // Use the REAL normalize-hooks.mjs so we can detect a (buggy) mutation.
    copyFileSync(
      resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs"),
      join(hooksDir, "normalize-hooks.mjs"),
    );

    // Plant a hooks.json with the placeholder + bare `node`. If postinstall
    // failed to guard, the literal `${CLAUDE_PLUGIN_ROOT}` would be replaced
    // by the tmpdir packageDir path.
    const hooksJsonPath = join(hooksDir, "hooks.json");
    const placeholderHooks =
      `{\n  "hooks": {\n    "SessionStart": [{\n      "matcher": "",\n      "hooks": [{\n        "type": "command",\n        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs\\""\n      }]\n    }]\n  }\n}\n`;
    writeFileSync(hooksJsonPath, placeholderHooks, "utf-8");

    const home = makeTmp("ctx-postinstall-home-tmproot-");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
    };
    const r = spawnSync(process.execPath, [join(scriptsDir, "postinstall.mjs")], {
      cwd: packageDir,
      env,
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(r.status === 0 || r.status === null).toBe(true);

    // Placeholder MUST survive — the guard prevented mutation. Equivalently:
    // tmpdir absolute paths MUST NOT appear in the file.
    const after = readFileSync(hooksJsonPath, "utf-8");
    expect(after).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(after).not.toContain(packageDir.replace(/\\/g, "/"));
    expect(after).not.toContain(packageDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 7c — /ctx-upgrade post-cpSync re-normalize against the REAL plugin
// dir (issue #528 gap-fill).
//
// The postinstall guard above prevents tmpdir paths from being baked DURING
// `npm install` inside the tmpdir. But for the upgrade flow to actually work
// on Windows we ALSO need cli.ts to call normalizeHooksOnStartup AGAINST THE
// REAL plugin dir after the in-place cpSync. Without this:
//   - postinstall correctly skips → hooks.json keeps placeholders → ok
//   - cpSync from tmpdir copies the (now unhealed) placeholder file to real
//     plugin dir → ok
//   - But for Windows users on the FIRST hook fire after upgrade,
//     normalize-hooks.mjs's MCP-boot-time pass hasn't run yet, so the
//     placeholder is still literal `${CLAUDE_PLUGIN_ROOT}` — Claude Code's
//     hook runner cannot resolve it and the hook crashes.
// The cli.ts post-cpSync call closes this window so the FIRST hook fire
// after `/ctx-upgrade` works without waiting for the next MCP boot.
// ─────────────────────────────────────────────────────────────────────────

describe("normalize-hooks — /ctx-upgrade post-cpSync sequence (issue #528)", () => {
  it("rewrites placeholders to the REAL pluginRoot, not the tmpdir", async () => {
    const realPluginRoot = makeTmp("ctx-real-plugin-root-");
    const realHooksDir = join(realPluginRoot, "hooks");
    mkdirSync(realHooksDir, { recursive: true });
    copyFileSync(
      resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs"),
      join(realHooksDir, "normalize-hooks.mjs"),
    );
    // Plant a clean placeholder hooks.json — this is what cpSync from the
    // tmpdir (with the postinstall guard active) deposits into the real
    // plugin dir.
    const hooksJsonPath = join(realHooksDir, "hooks.json");
    writeFileSync(
      hooksJsonPath,
      `{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs\\""
      }]
    }]
  }
}
`,
      "utf-8",
    );

    // Drive normalizeHooksOnStartup as cli.ts does — but force platform:"win32"
    // so the Windows-only rewrite path fires on the macOS/Linux CI runner.
    const realNormalize = resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs");
    const { normalizeHooksOnStartup } = await import(realNormalize);
    normalizeHooksOnStartup({
      pluginRoot: realPluginRoot,
      nodePath: "/usr/local/bin/node",
      platform: "win32",
    });

    const after = readFileSync(hooksJsonPath, "utf-8");
    // The REAL plugin dir path MUST be baked in.
    const realFwd = realPluginRoot.replace(/\\/g, "/");
    expect(after).toContain(realFwd);
    // Placeholder must be gone — the rewrite happened.
    expect(after).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    // No tmpdir-shaped poison sneaked in via the wrong pluginRoot.
    expect(after).not.toMatch(/[/\\]context-mode-upgrade-\d+[/\\]/);
  });

  it("self-heals a legacy-poisoned hooks.json by cpSync-overwrite then renormalize", async () => {
    // Two roots: simulate the cli.ts upgrade scenario where the tmpdir
    // staging area has a CLEAN placeholder hooks.json (postinstall guard
    // worked) and the real plugin dir has a POISONED hooks.json from an
    // older buggy upgrade.
    const tmpStageRoot = makeTmp("ctx-tmpdir-stage-");
    const tmpHooksDir = join(tmpStageRoot, "hooks");
    mkdirSync(tmpHooksDir, { recursive: true });
    const tmpHooksJson = join(tmpHooksDir, "hooks.json");
    writeFileSync(
      tmpHooksJson,
      `{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs\\""
      }]
    }]
  }
}
`,
      "utf-8",
    );

    const realPluginRoot = makeTmp("ctx-real-plugin-root-poisoned-");
    const realHooksDir = join(realPluginRoot, "hooks");
    mkdirSync(realHooksDir, { recursive: true });
    copyFileSync(
      resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs"),
      join(realHooksDir, "normalize-hooks.mjs"),
    );
    // Plant a LEGACY-POISONED hooks.json — left over from a v1.0.112-1.0.120
    // upgrade where postinstall's tmpdir normalize baked an old epoch path.
    const poisonedTmp = join(
      tmpdir(),
      "context-mode-upgrade-1700000000000",
    );
    const poisonedFwd = poisonedTmp.replace(/\\/g, "/");
    const hooksJsonPath = join(realHooksDir, "hooks.json");
    writeFileSync(
      hooksJsonPath,
      `{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "\\"/usr/local/bin/node\\" \\"${poisonedFwd}/hooks/sessionstart.mjs\\""
      }]
    }]
  }
}
`,
      "utf-8",
    );

    // Step 1: cpSync the clean placeholder file from tmpdir → real plugin
    // dir (this is exactly what cli.ts upgrade() does after npm install).
    copyFileSync(tmpHooksJson, hooksJsonPath);

    // After cpSync, the poisoned content is gone — replaced by the
    // placeholder version. Verify the intermediate state.
    const afterCp = readFileSync(hooksJsonPath, "utf-8");
    expect(afterCp).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(afterCp).not.toContain(poisonedFwd);

    // Step 2: normalize against the REAL pluginRoot — this is the cli.ts
    // post-cpSync call that PR #528 adds.
    const realNormalize = resolve(REPO_ROOT, "hooks", "normalize-hooks.mjs");
    const { normalizeHooksOnStartup } = await import(realNormalize);
    normalizeHooksOnStartup({
      pluginRoot: realPluginRoot,
      nodePath: "/usr/local/bin/node",
      platform: "win32",
    });

    const after = readFileSync(hooksJsonPath, "utf-8");
    // Real plugin dir path MUST be baked in.
    const realFwd = realPluginRoot.replace(/\\/g, "/");
    expect(after).toContain(realFwd);
    // Legacy poison MUST NOT survive — both the literal epoch path and
    // the generic tmpdir-upgrade shape.
    expect(after).not.toContain(poisonedFwd);
    expect(after).not.toMatch(/[/\\]context-mode-upgrade-1700000000000[/\\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 9 — Issue #564 — Linux SIGSEGV class hard-fail
//
// Six prior fixes (#228, #331, #461, #540, #551, #556) silently assumed
// Node >= 22.5 on Linux. Reporter #564 hit the SIGSEGV from V8's
// madvise(MADV_DONTNEED) corrupting better-sqlite3 .got.plt on Linux + Node 20.
//
// Contract for v1.0.132:
//   1. `package.json` declares `engines.node >= 22.5.0` (cosmetic in npm but
//      load-bearing for pnpm/yarn and tooling).
//   2. `scripts/postinstall.mjs` HARD-FAILS (process.exit(1)) on
//      Linux + Node < 22.5 + no Bun. Architect rejected "warn nicely" — the
//      contract IS Node >= 22.5 on Linux; make it real.
//
// Static-analysis tests (same pattern as cli.test.ts:289, :820) — spawning
// a fake older Node is not portable, but asserting the gate exists in source
// catches the regression at PR time.
// ─────────────────────────────────────────────────────────────────────────

describe("postinstall — Issue #564 Linux SIGSEGV hard-fail (engines.node + Node-version gate)", () => {
  it("package.json declares engines.node >= 22.5.0", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
    // Field must exist
    expect(pkg.engines).toBeDefined();
    expect(typeof pkg.engines.node).toBe("string");
    // Must enforce the 22.5 floor used by hasModernSqlite() in src/db-base.ts.
    // Looser ranges (>=18, >=20) would bless the SIGSEGV-prone versions.
    expect(pkg.engines.node).toMatch(/>=\s*22\.5/);
    // Sanity: Node 20.x must NOT satisfy the declared range.
    // We don't pull semver from npm; assert no `||` clause widens to 20.x.
    expect(pkg.engines.node).not.toMatch(/>=\s*1[0-9]\b/);
    expect(pkg.engines.node).not.toMatch(/>=\s*20\b/);
    expect(pkg.engines.node).not.toMatch(/>=\s*21\b/);
  });

  it("postinstall.mjs hard-fails on Linux + Node < 22.5 + no Bun (process.exit(1))", () => {
    const src = readFileSync(REPO_POSTINSTALL, "utf-8");
    // The gate must reference Linux explicitly.
    expect(src).toMatch(/process\.platform\s*===\s*["']linux["']/);
    // The gate must reference the 22.5 Node-version floor (via either an
    // inline major/minor compare or by importing hasModernSqlite).
    const has225InlineGate =
      /process\.versions\.node/.test(src) && /22(?:\.5|[^0-9])/.test(src);
    const importsModernSqliteHelper =
      /hasModernSqlite/.test(src);
    expect(has225InlineGate || importsModernSqliteHelper).toBe(true);
    // The gate must allow Bun through (Linux + Bun is fine because bun:sqlite
    // sidesteps better-sqlite3 entirely).
    expect(src).toMatch(/globalThis\.Bun|process\.versions\.bun|typeof\s+Bun/);
    // The gate must HARD-FAIL — `process.exit(1)` is the architect contract.
    // A bare `process.stderr.write` warning would be a soft-warn regression.
    const sigsegvBlock = src.slice(
      Math.max(
        0,
        Math.min(
          ...["#564", "nodejs/node#62515", "SIGSEGV", "22.5"]
            .map((needle) => {
              const i = src.indexOf(needle);
              return i === -1 ? Infinity : i;
            }),
        ) - 200,
      ),
      src.length,
    );
    expect(sigsegvBlock).toMatch(/process\.exit\(\s*1\s*\)/);
    // Remediation must point users at Node 22.5+ OR Bun, and reference #564
    // so the GitHub thread is discoverable.
    expect(src).toMatch(/22\.5|22\.13/);
    expect(src).toMatch(/#564|issues\/564/);
  });
});
