#!/usr/bin/env node
/**
 * Phase-2 cutover gate for the context-mode hard fork.
 *
 * Run AFTER the cutover and AFTER restarting Claude Code:
 *   node docs/superpowers/verify-cutover.mjs
 *
 * Checks 1, 2, 3, 4 and 6 of the spec's six. Check 5 (PreToolUse hook actually
 * fires) cannot be done from a script — the agent must call WebFetch once and
 * observe the redirect. This script prints that reminder.
 *
 * Exit code 0 = every scripted check passed. Non-zero = do not proceed to phase 3.
 *
 * Spec: docs/superpowers/specs/2026-07-10-context-mode-fork-foundation-design.md §5.3
 */
import { readFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const NEW_KEY = "context-mode@context-mode-js";
const OLD_KEY = "context-mode@context-mode";
const NEW_MARKETPLACE = "context-mode-js";
const OLD_MARKETPLACE = "context-mode";

function claudeConfigDir() {
  const e = process.env.CLAUDE_CONFIG_DIR;
  if (e && e.trim() !== "") {
    return e.startsWith("~") ? resolve(homedir(), e.replace(/^~[/\\]?/, "")) : resolve(e);
  }
  return resolve(homedir(), ".claude");
}

const cfg = claudeConfigDir();
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

// ── registry ────────────────────────────────────────────────────────────────
let reg;
try {
  reg = JSON.parse(readFileSync(resolve(cfg, "plugins", "installed_plugins.json"), "utf8"));
} catch (err) {
  console.error(`FATAL  installed_plugins.json 을 읽지 못했다: ${err.message}`);
  console.error(`       경로: ${resolve(cfg, "plugins", "installed_plugins.json")}`);
  process.exit(2);
}

const entry = ((reg.plugins || {})[NEW_KEY] || [])[0];
const oldEntry = (reg.plugins || {})[OLD_KEY];

check(
  "1. installed_plugins.json 에 새 키가 있고 version === 1.0.0",
  !!entry && entry.version === "1.0.0",
  entry ? `version=${entry.version}` : `키 '${NEW_KEY}' 없음`,
);

// ── realpath (junction 우회 방지) ────────────────────────────────────────────
let real = null;
if (entry && typeof entry.installPath === "string") {
  try { real = realpathSync(entry.installPath); } catch { real = entry.installPath; }
}
check(
  "2. installPath(realpath) 가 cache/context-mode-js/context-mode/1.0.0",
  !!real && /context-mode-js[\\/]context-mode[\\/]1\.0\.0$/.test(real),
  real || "installPath 없음",
);

// ── fork 패치가 그 트리에 실제로 있는가 ──────────────────────────────────────
let runHookOk = false;
let codexHookOk = false;
if (real) {
  try { runHookOk = /process\.exit\(0\)/.test(readFileSync(join(real, "hooks", "run-hook.mjs"), "utf8")); } catch {}
  try { codexHookOk = readFileSync(join(real, "hooks", "codex", "pretooluse.mjs"), "utf8").includes("flushAndExit"); } catch {}
}
check("3a. 그 트리의 hooks/run-hook.mjs 에 명시적 process.exit(0)", runHookOk);
check("3b. 그 트리의 hooks/codex/pretooluse.mjs 에 flushAndExit", codexHookOk);

// ── 4. 실행 중 프로세스가 어느 트리를 가리키는가 ─────────────────────────────
// Claude Code 는 MCP 서버를 포워드슬래시 경로로 띄운다. 백슬래시 전용 정규식은
// 항상 NO-MATCH 를 내 모든 프로세스를 "캐시 밖"으로 오판하고 거짓 통과한다.
const TREE_RE = /cache[\\/](context-mode[^\\/]*)[\\/]context-mode[\\/]([\d.]+)/i;
let procs = null;
if (process.platform === "win32") {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000 },
    );
    const parsed = JSON.parse(out);
    procs = [];
    for (const p of (Array.isArray(parsed) ? parsed : [parsed])) {
      if (p.ProcessId === process.pid) continue;
      if (typeof p.CommandLine !== "string") continue;
      const m = p.CommandLine.match(TREE_RE);
      if (m) procs.push({ pid: p.ProcessId, tree: `${m[1]}/${m[2]}` });
    }
  } catch (err) {
    procs = null;
  }
}

if (procs === null) {
  check("4. 실행 중 MCP 프로세스가 context-mode-js/1.0.0 만 가리킴", false,
        process.platform === "win32" ? "프로세스 조회 실패" : "Windows 전용 검사 — 수동 확인 필요");
} else {
  const wrong = procs.filter((p) => p.tree !== `${NEW_MARKETPLACE}/1.0.0`);
  check("4. 실행 중 MCP 프로세스가 context-mode-js/1.0.0 만 가리킴",
        procs.length > 0 && wrong.length === 0,
        procs.length ? procs.map((p) => `${p.pid}:${p.tree}`).join("  ") : "캐시 안 프로세스 0개 — MCP 서버가 안 떴다");
}

// ── 6. 옛 등록물이 남아 있지 않은가 ──────────────────────────────────────────
let settings = {};
try { settings = JSON.parse(readFileSync(resolve(cfg, "settings.json"), "utf8")); } catch {}
const ep = settings.enabledPlugins || {};
const mp = settings.extraKnownMarketplaces || {};

check("6a. installed_plugins.json 의 옛 항목 제거됨", !oldEntry);
check("6b. settings.enabledPlugins 의 새 키 === true", ep[NEW_KEY] === true, `값=${JSON.stringify(ep[NEW_KEY])}`);
check("6c. settings.enabledPlugins 의 옛 키가 활성 아님", ep[OLD_KEY] !== true, `값=${JSON.stringify(ep[OLD_KEY])}`);
check("6d. extraKnownMarketplaces 에 context-mode-js 만 등록",
      !!mp[NEW_MARKETPLACE] && !mp[OLD_MARKETPLACE],
      `js=${!!mp[NEW_MARKETPLACE]} old=${!!mp[OLD_MARKETPLACE]}`);

// ── 출력 ────────────────────────────────────────────────────────────────────
console.log(`CLAUDE_CONFIG_DIR : ${cfg}`);
console.log(`installPath(real) : ${real || "(없음)"}`);
console.log("");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n        └─ ${r.detail}` : ""}`);
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`스크립트 판정: ${results.length - failed.length}/${results.length} 통과`);
console.log("");
console.log("판정 5 (스크립트로 불가): PreToolUse 훅이 실제로 발동하는가.");
console.log("  에이전트가 WebFetch 를 한 번 호출해 ctx_fetch_and_index 로의 리다이렉트(deny)를 관측해야 한다.");
console.log("  리다이렉트 없이 그냥 fetch 되면 훅이 안 돈 것이다 = 실패.");

if (failed.length > 0) {
  console.log("");
  console.log("실패했다. 단계 3 으로 진행하지 마라. 롤백은 plan 의 Task 5 Step 11.");
  process.exit(1);
}
console.log("");
console.log("스크립트 판정 전부 통과. 판정 5 를 확인한 뒤에만 단계 2 완료로 선언하라.");
