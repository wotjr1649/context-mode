/**
 * doctor()'s summary must report what doctor actually found.
 *
 * Inherited upstream bug (af03f710, packages/core/src/cli.ts):
 *
 *   p.outro(
 *     available.length >= 4
 *       ? color.green("Diagnostics complete!")
 *       : color.yellow("Some checks need attention — see above for details"),
 *   );
 *
 * `available` is the list of detected language runtimes (11 possible), not a
 * check result. Deriving the verdict from it lies in both directions:
 *
 *   - false alarm: a box with javascript + typescript + shell (3 runtimes, no
 *     Python) ends yellow "Some checks need attention" while every check above
 *     it printed PASS. doctor's own coverage check calls >= 2 informational,
 *     so the summary contradicts the line it just printed.
 *
 *   - false all-clear: the hook-config FAIL, adapter health-check FAIL and
 *     hook-script-missing FAIL branches printed red FAIL but never incremented
 *     criticalFails. On a box with 4+ runtimes doctor closed green, exit 0,
 *     with a hook script missing.
 *
 * The invariant: every FAIL/WARN doctor prints reaches a counter, and the
 * summary branches on those counters alone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI_SRC = readFileSync(
  resolve(import.meta.dirname, "../../src/cli.ts"),
  "utf-8",
);

// Pull just the doctor() function body so we don't match unrelated
// occurrences in upgrade(), setup() etc.
function getDoctorBody(): string {
  const start = CLI_SRC.indexOf("async function doctor");
  if (start === -1) throw new Error("doctor() function not found");
  const after = CLI_SRC.indexOf("\nasync function ", start + 10);
  const altAfter = CLI_SRC.indexOf("\nfunction ", start + 10);
  const end = [after, altAfter].filter((i) => i > -1).sort((a, b) => a - b)[0] ?? CLI_SRC.length;
  return CLI_SRC.slice(start, end);
}

function getSummaryBlock(): string {
  const body = getDoctorBody();
  const i = body.indexOf("// Summary");
  if (i === -1) throw new Error("doctor() summary block not found");
  return body.slice(i);
}

// The two counting helpers are the one legitimate p.log.error / p.log.warn
// call site in doctor(). Drop them, and nothing else may print a result.
function getDoctorBodyWithoutHelpers(): string {
  return getDoctorBody()
    .replace(/const fail\s*=[\s\S]*?\};/, "")
    .replace(/const warn\s*=[\s\S]*?\};/, "");
}

describe("doctor() — the summary reports what the checks found", () => {
  it("does not derive the verdict from how many language runtimes are installed", () => {
    // Runtime coverage is reported as info (anything >= 2 is fine) and says
    // nothing about whether a check passed.
    expect(getSummaryBlock()).not.toMatch(/available/);
  });

  it("branches the verdict on the fail and warn tallies", () => {
    const summary = getSummaryBlock();
    expect(summary).toMatch(/criticalFails/);
    expect(summary).toMatch(/warnings/);
  });

  it("tallies every failure it prints — no bare p.log.error inside doctor()", () => {
    expect(getDoctorBodyWithoutHelpers()).not.toMatch(/p\.log\.error\(/);
  });

  it("tallies every warning it prints — no bare p.log.warn inside doctor()", () => {
    expect(getDoctorBodyWithoutHelpers()).not.toMatch(/p\.log\.warn\(/);
  });

  it("counts inside the logging helpers, so a new check cannot skip the tally", () => {
    const body = getDoctorBody();
    expect(body).toMatch(/const fail\s*=[\s\S]{0,120}criticalFails\+\+/);
    expect(body).toMatch(/const warn\s*=[\s\S]{0,120}warnings\+\+/);
  });
});
