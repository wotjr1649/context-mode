/**
 * N1 — start.mjs Layer 4 stale-hook MIGRATION (old identity → ctxscribe).
 *
 * The cache-heal hook was renamed:
 *   OLD: <config>/hooks/context-mode-cache-heal.{mjs,sh}
 *   NEW: <config>/hooks/ctxscribe-cache-heal.mjs
 *
 * Every EXISTING user boots with the old artifacts on disk and an old-named
 * SessionStart entry in settings.json. Without the migration they end up with
 * BOTH hooks registered — double-firing the cache heal and mutating the user's
 * settings.json on every session. Layer 4 therefore:
 *
 *   1. unlinks the stale `context-mode-cache-heal.sh` AND `.mjs`
 *   2. PRUNES any SessionStart matcher whose command mentions the OLD name
 *   3. registers the NEW hook when it isn't registered yet
 *   4. writes settings.json back when EITHER (2) or (3) happened — the
 *      `changed` flag. Gating the write on `!alreadyRegistered` alone would
 *      orphan the old entry forever; case 3 below is the regression trap.
 *
 * NOTE: the literal "context-mode-cache-heal" throughout this file is
 * INTENTIONALLY the OLD identity — it is the thing being cleaned up, and it is
 * whitelisted in scripts/assert-identity-clean.mjs.
 *
 * ── Harness ──────────────────────────────────────────────────────────────
 * Sibling tests exercise start.mjs two ways: start-mjs-self-heal.test.ts does
 * static analysis of the source text, and start-mjs-no-poison.test.ts runs a
 * hand-written REPLICA of the env bootstrap in a subprocess. Neither would fail
 * if the migration logic itself regressed, so this suite does the stronger
 * thing: it slices the REAL Layer 4 block out of start.mjs and executes it
 * verbatim in a subprocess against a temp CLAUDE_CONFIG_DIR, then asserts the
 * real filesystem + settings.json effects.
 *
 * We cannot simply spawn `node start.mjs`: the file tail imports
 * server.bundle.mjs (boots the MCP stdio server), pulls in ensure-deps, and
 * spawns detached npm installs. Layer 4 runs early and is self-contained, so we
 * lift exactly that block. The ONLY edit to the sliced source is the relative
 * `./hooks/cache-heal-utils.mjs` import specifier (the harness module lives in
 * a tmpdir, so a relative specifier would not resolve). Every marker lookup
 * throws loudly if start.mjs drifts, so the harness can never go stale-and-green.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const startSrc = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");

/** OLD identity — the thing the migration removes. */
const OLD = "context-mode-cache-heal";
/** NEW identity — the hook Layer 4 deploys and registers. */
const NEW = "ctxscribe-cache-heal";

// ── Harness: lift the real Layer 4 block out of start.mjs ──────────────────

const LAYER4_START = "// ── Self-heal Layer 4:";
const LAYER4_END = "// ── Self-heal Layer 5:";
const UTILS_SPEC = '"./hooks/cache-heal-utils.mjs"';

function buildHarnessSource(): string {
  const s = startSrc.indexOf(LAYER4_START);
  const e = startSrc.indexOf(LAYER4_END);
  if (s < 0 || e <= s) {
    throw new Error(
      `harness is stale: start.mjs no longer delimits Layer 4 with "${LAYER4_START}" … "${LAYER4_END}"`,
    );
  }
  let layer4 = startSrc.slice(s, e);

  if (!layer4.includes(UTILS_SPEC)) {
    throw new Error(
      "harness is stale: start.mjs Layer 4 no longer imports ./hooks/cache-heal-utils.mjs",
    );
  }
  // The one and only rewrite: make the relative specifier absolute so the
  // harness resolves it from a tmpdir. All migration logic runs verbatim.
  const utilsUrl = pathToFileURL(
    resolve(ROOT, "hooks", "cache-heal-utils.mjs"),
  ).href;
  layer4 = layer4.replace(UTILS_SPEC, JSON.stringify(utilsUrl));

  // Layer 4's only module-level dependency from start.mjs itself.
  const fnStart = startSrc.indexOf("function resolveClaudeConfigDir()");
  if (fnStart < 0) {
    throw new Error("harness is stale: start.mjs has no resolveClaudeConfigDir()");
  }
  const fnEnd = startSrc.indexOf("\n}", fnStart);
  if (fnEnd < 0) {
    throw new Error("harness is stale: resolveClaudeConfigDir() body is not closed at column 0");
  }
  const resolveConfigDir = startSrc.slice(fnStart, fnEnd + 2);

  return [
    'import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    'import { homedir } from "node:os";',
    resolveConfigDir,
    // PLUGIN_KEY is only interpolated into the deployed heal-script template and
    // has no bearing on the migration. Use start.mjs's own non-cache fallback.
    'const PLUGIN_KEY = "ctxscribe@wotjr1649";',
    layer4,
  ].join("\n\n");
}

const harnessDir = mkdtempSync(join(tmpdir(), "ctx-layer4-harness-"));
const harnessPath = join(harnessDir, "layer4.mjs");
writeFileSync(harnessPath, buildHarnessSource(), "utf-8");

/** Run the real Layer 4 block with CLAUDE_CONFIG_DIR pointed at `cfg`. */
function runLayer4(cfg: string): void {
  execFileSync(process.execPath, [harnessPath], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: cfg,
      // Belt-and-braces: nothing may escape into the real home even if a future
      // refactor reaches for homedir() instead of the env var.
      HOME: cfg,
      USERPROFILE: cfg,
    },
    encoding: "utf8",
    stdio: "pipe",
  });
}

// ── settings.json helpers ──────────────────────────────────────────────────

interface HookCmd {
  type?: string;
  command?: string;
}
interface Matcher {
  matcher?: string;
  hooks?: HookCmd[];
}
interface Settings {
  hooks?: { SessionStart?: Matcher[] };
  [k: string]: unknown;
}

const settingsPath = (cfg: string) => join(cfg, "settings.json");
const healScriptPath = (cfg: string) => join(cfg, "hooks", `${NEW}.mjs`);

const readSettings = (cfg: string): Settings =>
  JSON.parse(readFileSync(settingsPath(cfg), "utf-8")) as Settings;

const writeSettings = (cfg: string, s: Settings): void =>
  writeFileSync(settingsPath(cfg), JSON.stringify(s, null, 2) + "\n", "utf-8");

const sessionStart = (cfg: string): Matcher[] =>
  readSettings(cfg).hooks?.SessionStart ?? [];

const commands = (cfg: string): string[] =>
  sessionStart(cfg).flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ""));

const withName = (cfg: string, name: string): string[] =>
  commands(cfg).filter((c) => c.includes(name));

/** A lingering SessionStart entry from the pre-rename plugin. */
const oldEntry = (cfg: string): Matcher => ({
  hooks: [
    {
      type: "command",
      command: `"${process.execPath}" "${join(cfg, "hooks", `${OLD}.mjs`)}"`,
    },
  ],
});

/**
 * Boot once against an empty settings.json so Layer 4 registers the NEW hook
 * itself, and hand back the exact command string it wrote. Using the code's own
 * output as the fixture beats re-deriving buildHookCommand() here: it is
 * guaranteed to be the real shape AND non-stale (its node path exists), so
 * selfHealCacheHealHook() stays a no-op and cannot muddy the assertions.
 */
function primeRegistration(cfg: string): string {
  writeSettings(cfg, {});
  runLayer4(cfg);
  const cmds = withName(cfg, NEW);
  expect(cmds, "prime: Layer 4 must register the new hook into an empty settings.json").toHaveLength(1);
  return cmds[0];
}

const newEntry = (command: string): Matcher => ({
  hooks: [{ type: "command", command }],
});

/** Pin settings.json's mtime far in the past; any write moves it. */
const PAST = new Date("2020-01-01T00:00:00Z");
function pinMtime(cfg: string): number {
  utimesSync(settingsPath(cfg), PAST, PAST);
  return statSync(settingsPath(cfg)).mtimeMs;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("start.mjs Layer 4 — N1 stale cache-heal migration", () => {
  let cfg: string;

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "ctx-cfg-"));
    mkdirSync(join(cfg, "hooks"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(cfg, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("unlinks the stale old-identity heal hooks (.mjs and .sh) on boot", () => {
    const staleMjs = join(cfg, "hooks", `${OLD}.mjs`);
    const staleSh = join(cfg, "hooks", `${OLD}.sh`);
    writeFileSync(staleMjs, "// stale old-identity heal hook\n", "utf-8");
    writeFileSync(staleSh, "#!/bin/sh\n# stale old-identity heal hook\n", "utf-8");
    writeSettings(cfg, {});

    runLayer4(cfg);

    expect(
      existsSync(staleMjs),
      "the renamed-away context-mode-cache-heal.mjs must be unlinked, else it stays registered and double-fires",
    ).toBe(false);
    expect(
      existsSync(staleSh),
      "the pre-existing context-mode-cache-heal.sh cleanup must survive the rename",
    ).toBe(false);
    // Liveness: the block really ran (it deploys the new hook).
    expect(existsSync(healScriptPath(cfg))).toBe(true);
  });

  it("prunes an old-identity SessionStart entry and registers the new hook", () => {
    writeSettings(cfg, { hooks: { SessionStart: [oldEntry(cfg)] } });

    runLayer4(cfg);

    expect(
      withName(cfg, OLD),
      "the old-identity SessionStart entry must be pruned",
    ).toEqual([]);
    expect(
      withName(cfg, NEW),
      "the new hook must be registered exactly once",
    ).toHaveLength(1);
  });

  it("prunes the stale entry AND writes settings.json back when the new hook is ALREADY registered", () => {
    // The regression trap. If a refactor ever gates the settings write on
    // `!alreadyRegistered` instead of the `changed` flag, the prune is computed
    // but never persisted — and the orphaned old entry survives every boot,
    // leaving BOTH hooks registered forever.
    const newCmd = primeRegistration(cfg);
    writeSettings(cfg, {
      hooks: { SessionStart: [oldEntry(cfg), newEntry(newCmd)] },
    });
    const before = pinMtime(cfg);

    runLayer4(cfg);

    expect(
      withName(cfg, OLD),
      "the orphaned old-identity entry must be pruned even though the new hook is already registered",
    ).toEqual([]);
    expect(withName(cfg, NEW), "the new hook must not be duplicated").toHaveLength(1);
    expect(
      statSync(settingsPath(cfg)).mtimeMs,
      "settings.json must be written back when the prune alone changed it (the `changed` flag)",
    ).not.toBe(before);
  });

  it("prune keeps the new hook's own entry and every unrelated SessionStart hook", () => {
    const newCmd = primeRegistration(cfg);
    const unrelatedA: Matcher = {
      matcher: "startup",
      hooks: [{ type: "command", command: "echo unrelated-a" }],
    };
    const unrelatedB: Matcher = {
      hooks: [{ type: "command", command: "node /some/other/plugin-hook.mjs" }],
    };
    writeSettings(cfg, {
      hooks: {
        SessionStart: [unrelatedA, oldEntry(cfg), newEntry(newCmd), unrelatedB],
      },
    });

    runLayer4(cfg);

    // A prune keyed on "cache-heal" instead of the OLD name would nuke the new
    // hook's own entry (and then re-add it, churning settings.json every boot).
    expect(withName(cfg, OLD)).toEqual([]);
    expect(withName(cfg, NEW), "the prune must not remove the new hook's own entry").toHaveLength(1);
    expect(sessionStart(cfg)).toContainEqual(unrelatedA);
    expect(sessionStart(cfg)).toContainEqual(unrelatedB);
    // Survivors keep their original relative order.
    expect(commands(cfg)).toEqual([
      "echo unrelated-a",
      newCmd,
      "node /some/other/plugin-hook.mjs",
    ]);
  });

  it("steady state (new hook registered, nothing stale) does not touch settings.json", () => {
    primeRegistration(cfg);
    const raw = readFileSync(settingsPath(cfg), "utf-8");
    const before = pinMtime(cfg);
    // Liveness probe: delete the deployed heal script so a real boot MUST
    // rewrite it. Without this, a harness that silently no-op'd (Layer 4 wraps
    // everything in try/catch — a broken import would be swallowed) would pass
    // this "nothing was written" test vacuously.
    rmSync(healScriptPath(cfg));

    runLayer4(cfg);

    expect(
      existsSync(healScriptPath(cfg)),
      "liveness: Layer 4 must have re-deployed the heal script",
    ).toBe(true);
    expect(
      statSync(settingsPath(cfg)).mtimeMs,
      "a steady-state boot must not rewrite settings.json",
    ).toBe(before);
    expect(readFileSync(settingsPath(cfg), "utf-8")).toBe(raw);
  });
});
