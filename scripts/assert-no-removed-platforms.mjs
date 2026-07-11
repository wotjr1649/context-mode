#!/usr/bin/env node
/**
 * assert-no-removed-platforms — permanent residue net for the 16 removed
 * platform identifiers (hard fork: Claude Code and Codex only).
 *
 * Two-tier scope (phase-3 Task 10 ruling):
 *
 *   GATED (hard-fail, TOTAL RESIDUE must be 0):
 *     src/, hooks/, scripts/, tests/, configs/, .claude-plugin/,
 *     .codex-plugin/, package.json, web/**\/*.mjs — everywhere residue can
 *     route code, resurrect an adapter, or steer kept-platform behavior.
 *
 *   DEFERRED (counted and printed, NOT gated):
 *     README.md, CONTRIBUTING.md, .github/, docs/, web html/marketing,
 *     .claude/skills/, and every other tracked text surface outside the
 *     gated set. The deferred tier carries known upstream-era platform
 *     mentions in product copy. Rewriting outward-facing copy is a
 *     user-voiced decision, recorded as an open item in the phase ledger —
 *     not silently skipped.
 *
 * Excluded entirely (not scanned):
 *   - binaries (grepping PNG bytes for "pi"/"zed" is noise, not mentions)
 *   - *.bundle.mjs (stale by design until the phase-3 rebuild task)
 *   - docs/superpowers/, .superpowers/, refs/ (records of this work)
 *   - this script (it must name the needles to search for them)
 *
 * Needle passes per id: literal, camelCase, snake_case — case-insensitive,
 * word-boundary'd with (?<![A-Za-z0-9-]) / (?![A-Za-z0-9-]). Note the
 * trailing boundary excludes hyphen-continuations BY DESIGN: `kimi-k2` (a
 * model name in Codex catalog comments) and `pi-package` are not matches.
 *
 * Allowlist policy: an entry silences a hit ONLY with a written reason.
 * Entries are (file, needle[, linePattern]) — linePattern pins the exact
 * line class so new residue in the same file still fails the gate.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ids = ["gemini-cli", "opencode", "kilo", "openclaw", "vscode-copilot", "jetbrains-copilot",
  "copilot-cli", "cursor", "antigravity", "antigravity-cli", "kiro", "pi", "omp", "kimi", "zed", "qwen-code"];
const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const snake = (id) => id.replace(/-/g, "_");

// ── Scope ──────────────────────────────────────────────────────────────────
const EXCLUDE = /^(docs\/superpowers\/|\.superpowers\/|refs\/|scripts\/assert-no-removed-platforms\.mjs$)|\.bundle\.mjs$|\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot)$/i;
const GATED = [
  /^src\//, /^hooks\//, /^scripts\//, /^tests\//, /^configs\//,
  /^\.claude-plugin\//, /^\.codex-plugin\//, /^package\.json$/, /^web\/.*\.mjs$/,
];
// Gated-prefix files demoted to the deferred tier by the Task 10 ruling.
const DEFER_OVERRIDE = new Set([
  // Captured page-content fixture (external content, not platform plumbing).
  "tests/fixtures/playwright-snapshot.txt",
]);

// ── Allowlist (reason required — never a bare "checked") ──────────────────
const ALLOW = [
  // The fail-fast denylist for removed clients IS the feature: clientInfo
  // names must be recognized to raise UnsupportedClientError instead of
  // silently degrading a removed client to claude-code.
  { file: "src/adapters/client-map.ts", needle: /.*/, reason: "REMOVED_CLIENT_NAMES fail-fast denylist — the literals are the guard" },

  // English word "cursor" as the JSONL/DB high-water-mark concept
  // (usage_cursor column, extract cursors) — unrelated to the Cursor IDE.
  { file: "src/adapters/codex/usage.ts", needle: /^cursor$/, reason: "JSONL high-water-mark cursor concept" },
  { file: "src/session/db.ts", needle: /^cursor$/, reason: "usage_cursor column + accessors (DB cursor concept)" },
  { file: "hooks/stop.mjs", needle: /^cursor$/, reason: "usage-cursor variable (DB cursor concept)" },
  { file: "hooks/codex/stop.mjs", needle: /^cursor$/, reason: "usage-cursor variable (DB cursor concept)" },
  { file: "tests/adapters/codex-usage.test.ts", needle: /^cursor$/, reason: "tests of the JSONL cursor concept" },
  { file: "tests/session/extract-transcript-usage-since.test.ts", needle: /^cursor$/, reason: "tests of the transcript cursor concept" },
  { file: "tests/session/session-db.test.ts", needle: /^cursor$/, reason: "tests of the usage_cursor accessors" },

  // src/session/extract.ts carries BOTH the transcript-cursor concept and
  // the cross-agent rule/memory FILE classification (.cursor/…, KIRO.md):
  // extract classifies repo files a kept session reads — content capture,
  // not platform routing. Same reason covers the classifier's pins below.
  { file: "src/session/extract.ts", needle: /^cursor$/, reason: "transcript cursor + .cursor/ rule/memory file classification" },
  { file: "src/session/extract.ts", needle: /^kiro$/, reason: "KIRO.md rule-file basename classification (content capture)" },
  { file: "tests/session/extract-rule-detection.test.ts", needle: /^(kiro|cursor)$/, reason: "pins for the rule/memory file classifier" },

  // "Cursor Pro" is a generic $20/mo price anchor in the marketing renderer
  // (renderCostExample), emitted for EVERY session alongside "Claude Max" —
  // traced in Task 10: no platform gate anywhere near it (LIVE#2 verdict).
  { file: "src/session/analytics.ts", needle: /^cursor$/, reason: "Cursor Pro public list price anchor — renders for kept platforms" },
  { file: "tests/session/format-cost.test.ts", needle: /^cursor$/, reason: "pins the Cursor Pro price-anchor line (live feature)" },

  // Coordinator-pinned root resolution contract: `main` and exports["."]
  // resolve require("context-mode") to the same historical build path.
  // Load-bearing resolver surface; a stale path segment, not routing.
  { file: "package.json", needle: /^opencode$/, linePattern: /"(main|\.)":\s*"\.\/build\/adapters\/opencode\/plugin\.js"/, reason: "root resolution contract pinned by Task 10 ruling (main + exports['.'])" },

  // Anti-hijack / removal pins: stale upstream-era dotdirs and ids must not
  // steer kept platforms. The literals ARE the regression fixture.
  { file: "tests/adapters/detect.test.ts", needle: /^cursor$/, reason: "removal pin — getAdapter('cursor') must reject (F51 class)" },
  { file: "tests/adapters/detect-ambiguity-matrix.test.ts", needle: /^(cursor|kiro|pi|omp)$/, reason: "stale-dotdir anti-hijack matrix (real dirs on real machines)" },
  { file: "tests/adapters/detect-config-dir.test.ts", needle: /^cursor$/, reason: "stale ~/.cursor anti-hijack pins" },
  { file: "tests/adapters/detect-claude-code-in-vscode.test.ts", needle: /^vscode-copilot$/, reason: "#539 pins — asserts detection is NOT vscode-copilot" },
  { file: "tests/integration/project-dir-strict.test.ts", needle: /^(opencode|pi|cursor|omp)$/, reason: "adversarial leak-env fixture — kept platforms must reject lingering upstream-era vars" },

  // Test-env hygiene + negative source pins: the scrub regex clears
  // removed-era env vars so tests stay hermetic on machines where they
  // linger; not.toContain pins assert the vars never reappear in src.
  { file: "tests/core/server.test.ts", needle: /.*/, linePattern: /\(CLAUDE\|CODEX\|GEMINI\|VSCODE\|CURSOR\|OPENCODE\|KILO\|KIRO\|PI\|OMP\|ZED\|QWEN\|KIMI\|ANTIGRAVITY\|OPENCLAW\|COPILOT\)_/, reason: "env-scrub regex — test hermeticity against lingering upstream-era vars" },
  { file: "tests/core/server.test.ts", needle: /.*/, linePattern: /not\.toContain\("(OPENCODE_PROJECT_DIR|PI_PROJECT_DIR|CURSOR_CWD|OPENCLAW_HOME)"\)/, reason: "negative pins — removed cascade vars must never reappear" },
  { file: "tests/core/deny-policy.test.ts", needle: /.*/, linePattern: /not\.toContain\("(OPENCODE_PROJECT_DIR|PI_PROJECT_DIR)"\)/, reason: "negative pins — deny policy must not reference removed vars" },

  // Captured external content (a real GitHub API response fixture).
  { file: "tests/fixtures/github-issues.json", needle: /^pi$/, reason: "captured GitHub issue JSON — external content fixture" },
];

function allowed(file, needle, line) {
  return ALLOW.some((a) =>
    a.file === file && a.needle.test(needle) && (!a.linePattern || a.linePattern.test(line)));
}

// ── Scan ───────────────────────────────────────────────────────────────────
const tracked = execSync("git ls-files", { encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !EXCLUDE.test(f));

let total = 0;
const deferred = new Map();
for (const f of tracked) {
  let t;
  try { t = readFileSync(f, "utf8"); } catch { continue; }
  const gated = GATED.some((re) => re.test(f)) && !DEFER_OVERRIDE.has(f);
  const lines = t.split("\n");
  for (const id of ids) {
    for (const needle of new Set([id, camel(id), snake(id)])) {
      const re = new RegExp(`(?<![A-Za-z0-9-])${needle}(?![A-Za-z0-9-])`, "i");
      const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
      if (!hits.length) continue;
      if (!gated) {
        deferred.set(f, (deferred.get(f) ?? 0) + hits.length);
        continue;
      }
      const live = hits.filter(([, l]) => !allowed(f, needle, l));
      if (live.length) {
        total += live.length;
        console.log(`${f}:${live.map((h) => h[0]).join(",")}  [${needle}]`);
      }
    }
  }
}

if (deferred.size) {
  console.log("\nDEFERRED (not gated) — upstream-era mentions in product copy, awaiting a user decision:");
  for (const [f, n] of [...deferred.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${f}`);
  }
}
console.log("\nTOTAL RESIDUE:", total);
process.exit(total === 0 ? 0 : 1);
