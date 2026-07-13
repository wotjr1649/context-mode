/**
 * shell-snapshot-heal — tests for the per-session Claude Code shell-snapshot
 * PATH heal (issue #710).
 *
 * Background:
 *   Claude Code writes a per-session snapshot at boot:
 *     ~/.claude/shell-snapshots/snapshot-<shell>-<ts>-<rand>.sh
 *   Every Bash tool call `source`s that snapshot to reproduce the user env.
 *   The snapshot contains `export PATH='…'` baked at session start, including
 *   any ctxscribe `bin/` for the then-current cache version. When
 *   /ctx-upgrade deletes the old version dir mid-session, the stale PATH
 *   entry causes "Plugin directory does not exist" errors on every Bash
 *   call until the session restarts.
 *
 *   Fix (mirrors cache-heal-utils precedent from PR #728):
 *     Layer 1 — /ctx-upgrade rewrites snapshots after install
 *     Layer 2 — SessionStart hook re-heals if upgrade missed any
 *
 *   Both layers go through `rewriteShellSnapshots` in cache-heal-utils.mjs.
 *   The regex anchors exclusively on the `cache/<marketplace>/<plugin>/` prefix
 *   derived from the supplied pluginRoot — sibling plugins under the same
 *   `plugins/cache/` tree must never be touched.
 *
 *   Constraints:
 *     - Atomic writes (tmp + rename) — snapshots may be `source`d concurrently.
 *     - Best-effort — never throws.
 *     - Cross-platform: handles `/c/Users/…` (Cygwin/Git Bash) AND `C:\Users\…`
 *       (native Windows) path separator variants.
 *     - Only touches the version-segment of the ctxscribe PATH entry; the
 *       rest of the PATH line is byte-identical.
 */

import { describe, test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteShellSnapshots } from "../../hooks/cache-heal-utils.mjs";

// The trust anchor: rewriteShellSnapshots derives the
// `cache/<marketplace>/<plugin>/` prefix from pluginRoot. Every snapshot
// fixture in this file uses the fork's `wotjr1649/ctxscribe/` layout, so the
// real installed-tree pluginRoot names that same anchor.
const PLUGIN_ROOT =
  "/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.151";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

function makeTmp(prefix = "ctx-shellsnap-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/** Build a fake `~/.claude/shell-snapshots` directory under a temp root. */
function makeSnapshotsDir(): string {
  const root = makeTmp();
  const snapshotsDir = join(root, "shell-snapshots");
  mkdirSync(snapshotsDir, { recursive: true });
  return snapshotsDir;
}

describe("rewriteShellSnapshots — version-segment rewrite", () => {
  test("rewrites stale unix PATH entry to current version, leaves rest untouched", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-1779542730786-abc123.sh");
    const original =
      `export PATH='/usr/local/bin:/usr/bin:/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin:/opt/homebrew/bin'\n`;
    writeFileSync(file, original, "utf-8");

    const result = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
      pluginRoot: PLUGIN_ROOT,
    });

    expect(result.rewritten).toEqual([file]);
    const after = readFileSync(file, "utf-8");
    expect(after).toBe(
      `export PATH='/usr/local/bin:/usr/bin:/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.151/bin:/opt/homebrew/bin'\n`,
    );
  });

  test("multiple sibling plugins on same PATH — only ctxscribe segment rewritten", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-1.sh");
    const original =
      `export PATH='/Users/x/.claude/plugins/cache/pm-skills/pm-toolkit/1.0.1/bin:/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin:/Users/x/.claude/plugins/cache/claude-adhd/claude-adhd/1.0.0/bin'\n`;
    writeFileSync(file, original, "utf-8");

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    const after = readFileSync(file, "utf-8");
    // ctxscribe bumped, siblings untouched
    expect(after).toContain(
      "/cache/wotjr1649/ctxscribe/1.0.151/bin",
    );
    expect(after).toContain("/cache/pm-skills/pm-toolkit/1.0.1/bin");
    expect(after).toContain("/cache/claude-adhd/claude-adhd/1.0.0/bin");
    expect(after).not.toContain("wotjr1649/ctxscribe/1.0.146");
  });

  test("snapshot without ctxscribe entry — no-op, byte-identical", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-clean.sh");
    const original =
      `export PATH='/usr/local/bin:/usr/bin:/opt/homebrew/bin'\n# some other line\nalias foo=bar\n`;
    writeFileSync(file, original, "utf-8");
    const beforeMtime = statSync(file).mtimeMs;

    const result = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
      pluginRoot: PLUGIN_ROOT,
    });

    expect(result.rewritten).toEqual([]);
    expect(readFileSync(file, "utf-8")).toBe(original);
    // mtime preserved — never wrote.
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });

  test("snapshot already on currentVersion — no-op, no write", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-current.sh");
    const original =
      `export PATH='/usr/bin:/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.151/bin'\n`;
    writeFileSync(file, original, "utf-8");
    const beforeMtime = statSync(file).mtimeMs;

    const result = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
      pluginRoot: PLUGIN_ROOT,
    });

    expect(result.rewritten).toEqual([]);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });

  test("multiple stale entries within one PATH — all bumped to current", () => {
    // Defensive — pathological case where the same plugin appears twice
    // (e.g. user manually appended PATH). Both must converge to current.
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-double.sh");
    const original =
      `export PATH='/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.140/bin:/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin'\n`;
    writeFileSync(file, original, "utf-8");

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    const after = readFileSync(file, "utf-8");
    expect(after).toBe(
      `export PATH='/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.151/bin:/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.151/bin'\n`,
    );
  });

  test("Windows native path (C:\\Users\\...) is rewritten", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-bash-win.sh");
    const original =
      `export PATH="C:\\Users\\me\\.claude\\plugins\\cache\\wotjr1649\\ctxscribe\\1.0.146\\bin;C:\\WINDOWS\\system32"\n`;
    writeFileSync(file, original, "utf-8");

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    const after = readFileSync(file, "utf-8");
    expect(after).toContain(
      "C:\\Users\\me\\.claude\\plugins\\cache\\wotjr1649\\ctxscribe\\1.0.151\\bin",
    );
    expect(after).not.toContain("wotjr1649\\ctxscribe\\1.0.146");
    expect(after).toContain("C:\\WINDOWS\\system32");
  });

  test("Cygwin / Git Bash path (/c/Users/...) is rewritten", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-bash-msys.sh");
    const original =
      `export PATH='/c/Users/me/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin:/usr/bin'\n`;
    writeFileSync(file, original, "utf-8");

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    const after = readFileSync(file, "utf-8");
    expect(after).toBe(
      `export PATH='/c/Users/me/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.151/bin:/usr/bin'\n`,
    );
  });

  test("missing snapshotsDir — no throw, returns rewritten:[]", () => {
    const root = makeTmp();
    const missingDir = join(root, "does", "not", "exist");
    let result: { rewritten: string[] } | undefined;
    expect(() => {
      result = rewriteShellSnapshots({
        snapshotsDir: missingDir,
        currentVersion: "1.0.151",
        pluginRoot: PLUGIN_ROOT,
      });
    }).not.toThrow();
    expect(result?.rewritten).toEqual([]);
  });

  test("malformed snapshot (binary garbage) — no throw, skipped", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-bash-binary.sh");
    // Binary bytes that aren't a valid PATH line.
    writeFileSync(file, Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0x00, 0x01]));

    expect(() =>
      rewriteShellSnapshots({
        snapshotsDir,
        currentVersion: "1.0.151",
        pluginRoot: PLUGIN_ROOT,
      }),
    ).not.toThrow();
  });

  test("non-.sh files in snapshotsDir are ignored", () => {
    const snapshotsDir = makeSnapshotsDir();
    const sh = join(snapshotsDir, "snapshot-zsh-1.sh");
    const other = join(snapshotsDir, "README.md");
    writeFileSync(
      sh,
      `export PATH='/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin'\n`,
      "utf-8",
    );
    writeFileSync(
      other,
      "wotjr1649/ctxscribe/1.0.146 — do not touch",
      "utf-8",
    );

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    expect(readFileSync(other, "utf-8")).toBe(
      "wotjr1649/ctxscribe/1.0.146 — do not touch",
    );
    expect(readFileSync(sh, "utf-8")).toContain(
      "wotjr1649/ctxscribe/1.0.151/bin",
    );
  });

  test("atomic write — no stray tmp file left behind after success", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-atomic.sh");
    writeFileSync(
      file,
      `export PATH='/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin'\n`,
      "utf-8",
    );

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    const remaining = readdirSync(snapshotsDir);
    // Only the original snapshot — no `.tmp-*` artefact.
    expect(remaining).toEqual([
      "snapshot-zsh-atomic.sh",
    ]);
  });

  test("never touches paths that look like ctxscribe but are scoped under another owner", () => {
    // Defensive: a malicious plugin manifest could create
    // `.../cache/evil-owner/ctxscribe/1.0.146/bin`. Even with the
    // legit anchor explicitly supplied (PLUGIN_ROOT names
    // `cache/wotjr1649/ctxscribe/`), the derived prefix must not
    // match `evil-owner/ctxscribe/...` — the entry stays byte-identical.
    // `evil-owner` and the fork's `wotjr1649` are the same shape; the
    // heal only rewrites the tree pluginRoot actually names.
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-spoof.sh");
    const original =
      `export PATH='/Users/x/.claude/plugins/cache/evil-owner/ctxscribe/1.0.146/bin:/usr/bin'\n`;
    writeFileSync(file, original, "utf-8");

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  test("snapshotsDir of zero files — no throw, returns rewritten:[]", () => {
    const snapshotsDir = makeSnapshotsDir();
    const result = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
      pluginRoot: PLUGIN_ROOT,
    });
    expect(result.rewritten).toEqual([]);
  });

  test("invalid currentVersion (empty string) — no-op, no throw", () => {
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-x.sh");
    const original =
      `export PATH='/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin'\n`;
    writeFileSync(file, original, "utf-8");

    let result: { rewritten: string[] } | undefined;
    expect(() => {
      result = rewriteShellSnapshots({ snapshotsDir, currentVersion: "", pluginRoot: PLUGIN_ROOT });
    }).not.toThrow();
    expect(result?.rewritten).toEqual([]);
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  test("file present in the dir but is itself a directory — skipped silently", () => {
    const snapshotsDir = makeSnapshotsDir();
    // Realistically Claude Code doesn't make nested dirs, but we should
    // tolerate any leftover artefact (e.g. user `mkdir`'d in there).
    const subdir = join(snapshotsDir, "snapshot-zsh-but-its-a-dir.sh");
    mkdirSync(subdir, { recursive: true });

    expect(() =>
      rewriteShellSnapshots({
        snapshotsDir,
        currentVersion: "1.0.151",
        pluginRoot: PLUGIN_ROOT,
      }),
    ).not.toThrow();
  });
});

describe("rewriteShellSnapshots — concurrent-read safety", () => {
  test("rewritten file is at the original path (atomic rename), not a sibling tmp", () => {
    // While we can't faithfully simulate `source`-in-progress in a unit
    // test, we can lock in the atomic-write contract: the target path
    // either still has the old content OR the new content — never a
    // half-written file. We verify the file lands at the original path
    // and there is no `.tmp` sidecar after the call.
    const snapshotsDir = makeSnapshotsDir();
    const file = join(snapshotsDir, "snapshot-zsh-concurrent.sh");
    const before =
      `export PATH='/Users/x/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.140/bin:/usr/bin'\n`;
    writeFileSync(file, before, "utf-8");

    rewriteShellSnapshots({ snapshotsDir, currentVersion: "1.0.151", pluginRoot: PLUGIN_ROOT });

    // Target file exists, has new content, sibling tmp does not exist.
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain(
      "wotjr1649/ctxscribe/1.0.151/bin",
    );
    const tmpSiblings = readdirSync(snapshotsDir).filter((n) =>
      n.includes(".tmp"),
    );
    expect(tmpSiblings).toEqual([]);
  });
});
