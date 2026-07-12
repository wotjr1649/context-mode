// scripts/assert-identity-clean.mjs
// Fails if any FUNCTIONAL context-mode / context-mode-js identity token remains
// outside the spec §4b whitelist. The rename's completeness guarantee.
//
// NOTE: the grep is CASE-SENSITIVE for "context-mode" (lowercase-hyphen), so
// CONTEXT_MODE_* env-var names (uppercase-underscore) are NEVER matched — no env
// whitelist is needed, and NONE must be added (a line-level CONTEXT_MODE_ whitelist
// would false-clean real targets that co-occur with an env var, e.g.
// routing.mjs `const CONTEXT_MODE_SUBSTRING = "context-mode"`).
import { execFileSync } from "node:child_process";

const SCAN = [
  "src", "hooks", "scripts", "configs", "bin", "skills",
  ".claude-plugin", ".codex-plugin", ".agents",
  "tests", "start.mjs", "package.json",
  ".mcp.json.example", ".mcp.json.codex.example",
];

// Lines that legitimately contain the lowercase token and MUST be kept (spec §4b).
const WHITELIST = [
  /mksglu\\?\/context-mode/i,               // upstream attribution + D9 needle (D9's own NEEDLES regex literal renders this escaped: mksglu\/context-mode)
  /registry\\?\.npmjs\\?\.org\\?\/context-mode/i, // upstream npm needle (ditto, escaped form in D9's NEEDLES)
  /context-mode-ops/,                    // credits skill name
  /(?<![A-Za-z0-9_])\.context-mode\b/,   // legacy home dot-dir ~/.context-mode (NOT the data-dir "context-mode/"; lookbehind excludes dotted keys like mcp_servers.context-mode)
  /context-mode-cache-heal/,             // N1: start.mjs legitimately retains the OLD hook name to clean it up
];
// Whole files that are pure attribution / generated — never scanned.
const SKIP_FILE = /(UPSTREAM-CREDITS\.md|\.bundle\.mjs$|assert-identity-clean\.mjs$|bun\.lock$)/;

let raw = "";
try {
  raw = execFileSync("git", ["grep", "-n", "-I", "-E", "context-mode(-js)?", "--", ...SCAN],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  if (e.status === 1 && !e.stdout) { console.log("assert-identity-clean: OK (0 refs)"); process.exit(0); }
  if (!e.stdout) throw e;            // real git error (128) → surface, do NOT false-clean
  raw = e.stdout;
}

const offenders = raw.split("\n").filter(Boolean).filter((line) => {
  const path = line.slice(0, line.indexOf(":"));
  if (SKIP_FILE.test(path)) return false;
  return !WHITELIST.some((re) => re.test(line));
});

if (offenders.length) {
  console.error(`assert-identity-clean: FAIL — ${offenders.length} functional identity ref(s) remain:`);
  console.error(offenders.slice(0, 200).join("\n"));
  if (offenders.length > 200) console.error(`… and ${offenders.length - 200} more`);
  process.exit(1);
}
console.log("assert-identity-clean: OK (0 functional refs)");
