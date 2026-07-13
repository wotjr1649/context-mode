/**
 * Regression guard: the test suite must never write to the developer's real
 * ~/.claude or ~/.codex.
 *
 * History: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` were unset on a normal dev
 * machine, so every adapter/hook/subprocess resolution fell back to
 * `homedir()/.claude` and `homedir()/.codex` — the user's LIVE config dirs. A
 * full-suite run deployed hooks, created `<config>/ctxscribe/` session dirs and
 * pruned entries out of the user's real `settings.json`. Only the ~10% of
 * suites importing `tests/setup-home.ts` were isolated; the rest silently
 * mutated the developer's environment.
 *
 * `vitest.config.ts` now pins both vars to a fresh temp dir at config-load
 * time. This suite is the tripwire for that block: it deliberately does NOT
 * import `tests/setup-home.ts`, so `node:os` is the REAL os module and
 * `homedir()` is the REAL home. That is what makes the assertions meaningful —
 * under the os mock, "not the home dir" would be trivially true and would prove
 * nothing.
 *
 * If someone deletes the `test.env` block from `vitest.config.ts`, this fails.
 */
import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

/** Case-insensitive on Windows, where env vars and paths both fold case. */
function isUnder(child: string, parent: string): boolean {
  const norm = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, "");
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + "\\") || c.startsWith(p + "/");
}

describe("test isolation: config dirs never point at the real home", () => {
  for (const [envVar, realDirName] of [
    ["CLAUDE_CONFIG_DIR", ".claude"],
    ["CODEX_HOME", ".codex"],
  ] as const) {
    describe(envVar, () => {
      it("is set (vitest.config.ts test.env block is present)", () => {
        expect(process.env[envVar], `${envVar} must be pinned by vitest.config.ts`).toBeTruthy();
      });

      it("resolves under os.tmpdir(), not the developer's home", () => {
        const value = process.env[envVar];
        expect(value).toBeTruthy();
        expect(
          isUnder(value as string, tmpdir()),
          `${envVar}=${value} must live under tmpdir()=${tmpdir()}`,
        ).toBe(true);
      });

      // NOTE: deliberately NOT asserting "outside homedir()". On Windows
      // os.tmpdir() is %LOCALAPPDATA%\Temp — i.e. UNDER the home dir — so a
      // correctly-isolated temp path would fail that check. "under tmpdir()"
      // + "!= the live config dir" is the real invariant on both platforms.
      it(`is NOT the real ~/${realDirName}`, () => {
        const value = resolve(process.env[envVar] as string);
        const realDir = resolve(homedir(), realDirName);
        expect(
          value.toLowerCase(),
          `${envVar} must not resolve to the user's live config dir`,
        ).not.toBe(realDir.toLowerCase());
      });
    });
  }
});
