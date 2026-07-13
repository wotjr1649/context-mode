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
  /context-mode-platform/,               // SEPARATE external companion project (the hosted Insight analytics
                                         // platform) — not this plugin's identity. Renaming it would misname
                                         // someone else's repo in the comments/log prefix that cite it.
  // Task 10a. Both entries below are FILE-SCOPED on purpose: the gate tests each
  // regex against the whole `path:lineno:content` line, so these cannot leak out
  // and false-clean a real target in another file.
  /tests[/\\]core[/\\]cli-fork-origin\.test\.ts:/,
  //   isForkOrigin's REJECT fixtures. A reject-assertion must literally contain the
  //   token it rejects: `github.com/wotjr1649/context-mode.git` (+ attacker/ and
  //   host-spoof variants) must stay OLD-identity. Renaming them to `…/ctxscribe.git`
  //   would turn the fixture into the REAL fork origin and invert `.toBe(false)`.
  //   The accept-cases in the same file already assert the new `wotjr1649/ctxscribe`.
  /tests[/\\]hooks[/\\]cache-heal-version-segment\.test\.ts:.*context-mode["/\\, ]+context-mode/,
  //   ANTI-SPOOFING fixtures: the DOUBLED upstream cache shape `context-mode/context-mode`
  //   (and its `pluginRootFor("context-mode", "context-mode")` anchor form). These pin that
  //   the fork still heals — and never rewrites — an un-renamed upstream cache tree. Scoped to
  //   the doubled shape, so a lone `context-mode` in that same file is still caught.
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
