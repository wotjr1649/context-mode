import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCodexCwdSidecar,
  pruneCodexCwdSidecars,
  SIDECAR_DIR,
} from "../../hooks/codex-cwd-sidecar.mjs";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});
function makeHome(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-codex-side-"));
  cleanup.push(d);
  return d;
}

describe("writeCodexCwdSidecar", () => {
  it("writes {cwd, sessionId, ppid, ts} keyed by sessionId and creates the dir", () => {
    const home = makeHome();
    writeCodexCwdSidecar({ codexHome: home, sessionId: "abc-123", cwd: "/project/x", ppid: 4242 });
    const file = join(home, SIDECAR_DIR, "abc-123.json");
    expect(existsSync(file)).toBe(true);
    const obj = JSON.parse(readFileSync(file, "utf-8"));
    expect(obj.cwd).toBe("/project/x");
    expect(obj.sessionId).toBe("abc-123");
    expect(obj.ppid).toBe(4242);
    expect(typeof obj.ts).toBe("number");
  });

  it("leaves no .tmp file behind (atomic rename)", () => {
    const home = makeHome();
    writeCodexCwdSidecar({ codexHome: home, sessionId: "s", cwd: "/p", ppid: 1 });
    const files = readdirSync(join(home, SIDECAR_DIR));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain("s.json");
  });

  it("sanitizes an unsafe sessionId into a safe filename", () => {
    const home = makeHome();
    writeCodexCwdSidecar({ codexHome: home, sessionId: "a/b:c*d", cwd: "/p", ppid: 1 });
    expect(readdirSync(join(home, SIDECAR_DIR))).toEqual(["a_b_c_d.json"]);
  });

  it("skips writing when cwd is empty", () => {
    const home = makeHome();
    writeCodexCwdSidecar({ codexHome: home, sessionId: "s", cwd: "", ppid: 1 });
    expect(existsSync(join(home, SIDECAR_DIR))).toBe(false);
  });

  it("skips writing when cwd is a plugin install path", () => {
    const home = makeHome();
    writeCodexCwdSidecar({
      codexHome: home,
      sessionId: "s",
      cwd: "/Users/x/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.1",
      ppid: 1,
    });
    expect(existsSync(join(home, SIDECAR_DIR))).toBe(false);
  });

  it("overwrites the same session's sidecar in place (one file per session)", () => {
    const home = makeHome();
    writeCodexCwdSidecar({ codexHome: home, sessionId: "s", cwd: "/p1", ppid: 1 });
    writeCodexCwdSidecar({ codexHome: home, sessionId: "s", cwd: "/p2", ppid: 1 });
    expect(readdirSync(join(home, SIDECAR_DIR))).toEqual(["s.json"]);
    expect(
      JSON.parse(readFileSync(join(home, SIDECAR_DIR, "s.json"), "utf-8")).cwd,
    ).toBe("/p2");
  });
});

describe("pruneCodexCwdSidecars", () => {
  it("removes sidecars older than maxAgeMs, keeps fresh ones", () => {
    const home = makeHome();
    const dir = join(home, SIDECAR_DIR);
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "old.json");
    writeFileSync(old, "{}");
    const fresh = join(dir, "fresh.json");
    writeFileSync(fresh, "{}");
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 3600_000);
    const aMinuteAgo = new Date(now - 60_000);
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    utimesSync(fresh, aMinuteAgo, aMinuteAgo);
    pruneCodexCwdSidecars({ codexHome: home, maxAgeMs: 7 * 24 * 3600_000, now });
    const files = readdirSync(dir);
    expect(files).toContain("fresh.json");
    expect(files).not.toContain("old.json");
  });

  it("does not throw when the sidecar dir is absent", () => {
    const home = makeHome();
    expect(() => pruneCodexCwdSidecars({ codexHome: home })).not.toThrow();
  });
});
