import { describe, it, expect } from "vitest";
import { isReapable, reap } from "../../hooks/orphan-reaper.mjs";

const CACHE = "C:\\Users\\me\\.claude\\plugins\\cache\\wotjr1649\\ctxscribe";

describe("orphan-reaper isReapable — cache-root prefix, not substring", () => {
  it("reaps a plugin-cache orphan under the cache root", () => {
    expect(isReapable(`node "${CACHE}\\1.0.0\\start.mjs"`, CACHE)).toBe(true);
  });
  it("does NOT reap a dev process merely running from a ctxscribe working dir", () => {
    // The repo's own directory is named ctxscribe — the old substring
    // match /ctxscribe/i would kill this. The prefix match must not.
    expect(isReapable('node C:\\Users\\me\\Documents\\ClaudeCode\\ctxscribe\\node_modules\\.bin\\vitest', CACHE)).toBe(false);
    expect(isReapable('npm run dev', CACHE)).toBe(false);
  });
  it("does NOT reap another marketplace's tree (anti-spoof)", () => {
    expect(isReapable('node C:\\Users\\me\\.claude\\plugins\\cache\\evil\\ctxscribe\\1.0.0\\start.mjs', CACHE)).toBe(false);
  });
  it("returns false for a non-string command line", () => {
    expect(isReapable(undefined, CACHE)).toBe(false);
  });
});

describe("orphan-reaper reap — injected process list, no PowerShell", () => {
  it("reaps a cache-root orphan and its descendant (dry-run), spares protected and non-cache procs", () => {
    const procs = [
      // orphan: under cache root, parent 999 not in the process list, old enough
      { ProcessId: 100, ParentProcessId: 999, CommandLine: `node "${CACHE}\\1.0.0\\start.mjs"`, AgeSec: 999 },
      // descendant of the orphan (swept regardless of its own command line)
      { ProcessId: 101, ParentProcessId: 100, CommandLine: "node child", AgeSec: 999 },
      // this hook itself: under cache root and parent-dead, but protected -> spared
      { ProcessId: 200, ParentProcessId: 1, CommandLine: `node "${CACHE}\\1.0.0\\hook.mjs"`, AgeSec: 999 },
      // a dev vitest run from a ctxscribe working dir: not under cache root -> spared
      { ProcessId: 300, ParentProcessId: 999, CommandLine: "node C:\\dev\\ctxscribe\\node_modules\\.bin\\vitest", AgeSec: 999 },
    ];
    const { killed, scanned } = reap({ dryRun: true, procs, selfPid: 200, ancestorPids: [200], cacheRoot: CACHE });
    expect(scanned).toBe(4);
    expect([...killed].sort((a, b) => a - b)).toEqual([100, 101]);
  });
});
