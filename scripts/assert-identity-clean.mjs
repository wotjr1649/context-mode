// scripts/assert-identity-clean.mjs
// Fails if any FUNCTIONAL context-mode / context-mode-js identity token remains
// outside the spec §4b whitelist. The rename's completeness guarantee.
//
// NOTE: the grep is CASE-SENSITIVE and the pattern is LOWERCASE, so CONTEXT_MODE_*
// env-var names (UPPERCASE) are NEVER matched — no env whitelist is needed, and NONE
// must be added. A line-level CONTEXT_MODE_ whitelist would false-clean real targets
// that co-occur with an env var, e.g. a line like
//   if (process.env.CONTEXT_MODE_DEBUG) log("context-mode: booting")
// where the env NAME is legitimate but the lowercase brand token beside it is not.
// This case-sensitivity is what lets PATTERN safely cover the UNDERSCORE family too
// (`context_mode`) without swallowing every CONTEXT_MODE_* env reference.
import { execFileSync } from "node:child_process";

// Both separators: `context-mode` (brand/pkg/repo) AND `context_mode` (symbol/tag/
// identifier form). The underscore family was structurally invisible while this was
// hyphen-only — that blind spot hid a globalThis registry key and two prompt tags.
const PATTERN = "context[-_]mode(-js)?";

const SCAN = [
  "src", "hooks", "scripts", "configs", "bin", "skills",
  ".claude-plugin", ".codex-plugin", ".agents",
  "tests", "start.mjs", "package.json",
  ".mcp.json.example", ".mcp.json.codex.example",
  "docs",
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
  /tests[/\\]core[/\\]cli-fork-origin\.test\.ts:.*isForkOrigin\(.*\)\)\.toBe\(false\)/,
  //   isForkOrigin's REJECT fixtures. A reject-assertion must literally contain the
  //   token it rejects: `github.com/wotjr1649/context-mode.git` (+ attacker/ and
  //   host-spoof variants) must stay OLD-identity. Renaming them to `…/ctxscribe.git`
  //   would turn the fixture into the REAL fork origin and invert `.toBe(false)`.
  //   The accept-cases in the same file already assert the new `wotjr1649/ctxscribe`.
  //   SHAPE-SCOPED, not just file-scoped (the 3 siblings below all constrain shape):
  //   it matches ONLY the `isForkOrigin(…)).toBe(false)` reject-assertion form, which
  //   is exactly the 9 token-bearing lines in that file. A stray identity token on any
  //   OTHER line there — an import, a comment, a describe title, or (the real hazard)
  //   an `isForkOrigin(…old-token…)).toBe(true)` ACCEPT case — is still caught.
  /tests[/\\]hooks[/\\]cache-heal-version-segment\.test\.ts:.*context-mode["/\\, ]+context-mode/,
  //   ANTI-SPOOFING fixtures: the DOUBLED upstream cache shape `context-mode/context-mode`
  //   (and its `pluginRootFor("context-mode", "context-mode")` anchor form). These pin that
  //   the fork still heals — and never rewrites — an un-renamed upstream cache tree. Scoped to
  //   the doubled shape, so a lone `context-mode` in that same file is still caught.
  /tests[/\\]codex[/\\]marketplace-layout\.test\.ts:.*plugins["/\\, ]+context-mode/,
  //   HISTORICAL ARTIFACT name (same class as context-mode-cache-heal above). The regression
  //   guard keeps the old Windows-hostile `plugins/context-mode` symlink shim out of the tree.
  //   The shim predates the rename, so only the OLD name can ever come back (via a revert or an
  //   upstream port); a guard pointed solely at `plugins/ctxscribe` would watch a path that has
  //   never existed here and could never fail. Scoped to file + the `plugins…context-mode` shape,
  //   so a lone `context-mode` elsewhere in that file is still caught.
  /tests[/\\]live-benchmark-v04\.ts:.*\/Users\/mksglu\//,
  //   FOREIGN PATH (same class as context-mode-platform): the UPSTREAM AUTHOR's local checkout,
  //   `/Users/mksglu/Server/Mert/context-mode-claude-code-plugin/context-mode`, hard-coded in a
  //   manual (non-vitest) benchmark script. Renaming someone else's machine path would invent a
  //   directory that exists on nobody's disk. Scoped to file + the `/Users/mksglu/` home shape.
  // Task 10b. The entry below is an EXTERNAL reference — a third-party name this fork
  // does not own — exactly the class of the context-mode-platform entry above.
  // (The former upstream product-domain EXTERNAL DOMAIN exemption left with
  //  ctx_insight: no runtime source may point at that domain anymore, and
  //  assert-no-upstream-mksglu now carries it as a hard needle.)
  /github\.com\/anthropic-experimental\/context-mode/,
  //   EXTERNAL REPO (src/store-directory.ts:12) — an issue URL on Anthropic's
  //   `anthropic-experimental/context-mode` repo, cited as the provenance of the store-dir
  //   behaviour. Same class as the upstream-attribution entry at the top of this list:
  //   renaming it would misname a THIRD PARTY's repository and break the link. Scoped to the
  //   full org+repo path, so a lone `context-mode` in that same file is still caught.
  // ── Entries below were surfaced by widening PATTERN to the underscore family and by
  //    adding `docs` to SCAN. Each is a FIXED / HISTORICAL name, not a brand token.
  /src[/\\]db-base\.ts:.*Symbol\.for\("__context_mode_live_dbs_v3__"\)/,
  //   UNLISTED INVARIANT — a globalThis registry key, NOT a brand token. During
  //   /ctx-upgrade an OLD bundle and the NEW one can be live in the SAME process, and
  //   this SHARED `Symbol.for` slot is what lets the single process-exit hook close
  //   EVERY live SQLite handle. A `ctxscribe`-flavoured name is a DIFFERENT slot, so
  //   each bundle would register its own set and close only its own DBs — splitting the
  //   registry and leaking handles across the upgrade boundary (precisely the failure
  //   the symbol's own `_v3_` bump comment describes). It survived the rename only
  //   because this gate used to grep hyphens; the widened PATTERN makes it visible, so
  //   it is pinned here ON PURPOSE. See the DO-NOT-RENAME comment at the site and spec
  //   §4b. Scoped to file + the exact `Symbol.for("…")` call, so a lone `context_mode`
  //   anywhere else in db-base.ts is still caught.
  /docs[/\\]platform-support\.md:.*(plugins[/\\]context-mode|context-mode@context-mode)/,
  //   HISTORICAL ARTIFACTS in the Codex caveats section (same class as the
  //   marketplace-layout.test.ts entry above, which pins the very same shim). The doc
  //   explains why current releases use a relative git source, and to do that it must
  //   name the pre-rename shim path `plugins/context-mode` and the pre-rename install
  //   key `context-mode@context-mode` that failed on Windows. Renaming them to
  //   `plugins/ctxscribe` / `ctxscribe@wotjr1649` would assert that the CURRENT names
  //   caused a bug they never caused — and would name a path that has never existed.
  //   The paragraph is explicitly labelled historical and points at the live install
  //   command. Scoped to file + those two shapes: every other identity token in that
  //   file (it is LIVE install documentation) is still caught.
];
// Whole files that are pure attribution / generated / prior-phase history — never scanned.
//   docs/superpowers/ = prior-phase plans, specs and handoffs (incl. THIS rename's own
//   spec+plan, which must quote the OLD identity to describe the migration) and the
//   superseded phase-2 verify-cutover.mjs. docs/adr/ = accepted decision records: an ADR
//   is an immutable historical statement of what was decided WHEN, so rewriting its
//   identity tokens would falsify the record. Everything else under docs/ IS scanned —
//   that is how docs/platform-support.md (live install docs still pointing at upstream's
//   npm package) stayed green through a build that never opened the directory.
const SKIP_FILE = /(UPSTREAM-CREDITS\.md|\.bundle\.mjs$|assert-identity-clean\.mjs$|bun\.lock$|^docs[/\\](superpowers|adr)[/\\])/;

let raw = "";
try {
  raw = execFileSync("git", ["grep", "-n", "-I", "-E", PATTERN, "--", ...SCAN],
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
