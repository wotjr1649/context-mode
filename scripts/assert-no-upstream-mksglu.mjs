#!/usr/bin/env node
/**
 * assert-no-upstream-mksglu — build gate. Runtime source must never reference the
 * upstream repo (mksglu/context-mode) or the upstream npm version endpoint
 * (registry.npmjs.org/context-mode). Charter D9: no upstream-pointing paths ship.
 * Locks in the 1.0.2 clone-URL repoint + the 1.0.3 version-check removal.
 *
 * Scope: git-tracked files under src/, hooks/, scripts/ (where code runs).
 * Excludes: *.bundle.mjs (generated) and this script. docs/tests are not runtime
 * source and are out of scope.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const NEEDLES = [/mksglu\/context-mode/i, /registry\.npmjs\.org\/context-mode/i];
const INCLUDE = /^(src|hooks|scripts)\//;
const EXCLUDE = /\.bundle\.mjs$|^scripts\/assert-no-upstream-mksglu\.mjs$/;

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((f) => INCLUDE.test(f) && !EXCLUDE.test(f));

let total = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const lines = text.split("\n");
  for (const re of NEEDLES) {
    const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
    if (hits.length) {
      total += hits.length;
      console.error(`${f}:${hits.map((h) => h[0]).join(",")}  [${re.source}]`);
    }
  }
}
if (total === 0) console.log("assert-no-upstream-mksglu: OK (0 upstream refs in runtime source)");
else console.error(`\nassert-no-upstream-mksglu: FAIL — ${total} upstream ref(s) in runtime source`);
process.exit(total === 0 ? 0 : 1);
