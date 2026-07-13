import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const isCI = !!process.env.CI;

/**
 * Global config-dir containment (test-isolation safety net).
 *
 * Adapter code resolves its config dir from env FIRST and only falls back to
 * `homedir()`:
 *   - `src/util/claude-config.ts::resolveClaudeConfigDir` → $CLAUDE_CONFIG_DIR
 *   - `src/adapters/codex/paths.ts`                       → $CODEX_HOME
 *   - `hooks/session-helpers.mjs::resolveConfigDir`, `start.mjs`  → both
 *
 * Neither var is normally set on a dev machine, so both resolved to the
 * developer's REAL ~/.claude and ~/.codex. Only ~10% of suites opt into
 * `tests/setup-home.ts` (which redirects HOME); every other suite — and, more
 * damagingly, every subprocess it spawns (start.mjs, hooks) — wrote session
 * state, healed hooks and rewrote settings.json in the user's live config dirs.
 *
 * Pinning both vars at config-load time makes containment the DEFAULT: a suite
 * now has to opt OUT to reach the real home, rather than opt IN to avoid it.
 * Suites that need a per-suite home still override this (setup-home.ts and
 * `withIsolatedEnv()` both re-point these two vars at their own fake home).
 *
 * Regression-guarded by `tests/test-isolation.test.ts` — delete this block and
 * that suite fails loudly.
 */
const testConfigRoot = mkdtempSync(join(tmpdir(), "ctxscribe-test-cfg-"));
const claudeConfigDir = join(testConfigRoot, ".claude");
const codexHome = join(testConfigRoot, ".codex");
mkdirSync(claudeConfigDir, { recursive: true });
mkdirSync(codexHome, { recursive: true });

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CODEX_HOME: codexHome,
    },
    testTimeout: 30_000,
    // afterAll cleanup loops over many better-sqlite3 handles on Windows
    // and can exceed vitest's default 10s hookTimeout under fork contention
    // (e.g. tests/session/session-pipeline.test.ts cleans every DB it
    // created). Match testTimeout so the cleanup window matches the work
    // window — same envelope better-sqlite3 already needs for tests.
    hookTimeout: 30_000,
    // Native addons (better-sqlite3) can segfault in worker_threads during
    // process cleanup. Use forks on all platforms for stable isolation.
    pool: "forks",
    // Cap parallel workers to prevent fork exhaustion (#258).
    // Tests that spawnSync + better-sqlite3 cause worker SIGKILL under
    // unlimited parallelism. Benchmarked: 3 workers = 2.8x speedup with
    // near-zero crashes (vs unlimited = 3.7x but 6-7 worker kills/run).
    maxWorkers: isCI ? 2 : 3,
    // Hook subprocess tests (spawnSync + better-sqlite3 native addon) can
    // fail intermittently under parallel load on CI.  Retry once to absorb
    // transient resource-contention failures without masking real regressions.
    // Only enable retry on CI to avoid slowing down local dev.
    retry: isCI ? 2 : 0,
    // Force exit after tests complete — prevents CI failure from open handles
    // (better-sqlite3 native addon cleanup races with fork worker teardown).
    // Without this, Ubuntu CI consistently fails with "Worker exited unexpectedly"
    // even though all tests pass.
    teardownTimeout: isCI ? 15_000 : 5_000,
  },
});
