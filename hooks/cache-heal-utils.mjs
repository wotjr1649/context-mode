// cache-heal-utils.mjs — fixes Brew-node-upgrade stale path bug
//
// Problem: start.mjs writes process.execPath into ~/.claude/settings.json
// when registering the cache-heal hook. On Brew, process.execPath returns
// the *versioned* Cellar snapshot:
//
//   /opt/homebrew/Cellar/node/25.9.0_2/bin/node
//
// When Brew upgrades Node, that path disappears and Claude fails to spawn
// the hook ("session start" error). The stable symlink is:
//
//   /opt/homebrew/bin/node
//
// Fix is two layered:
//   A) New installs on Unix: write hook script with `#!/usr/bin/env node`
//      shebang + chmod +x, register hook command as the bare script path.
//      `env` resolves node from PATH at runtime — survives any Node upgrade.
//      Windows keeps the explicit-execPath form (no shebang support).
//   B) Self-heal: every MCP boot, scan ~/.claude/settings.json for an
//      existing cache-heal hook command whose leading node path no longer
//      exists. If stale, rewrite using pattern (A).
//
// This module is pure (no global state) and side-effect free except for
// the explicit selfHealCacheHealHook() entry point that touches disk.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Convert any path string to forward slashes (matches normalize-hooks style,
 * keeps round-trips on Windows safe).
 */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Extract the leading executable path from a hook command string IF it
 * looks like a node binary. Returns null when the command is shebang-style
 * (bare script path) or when the leading executable isn't node.
 *
 * Accepted shapes:
 *   '"/abs/path/to/node" "/abs/path/script.mjs"'
 *   '/abs/path/to/node "/abs/path/script.mjs"' (unquoted node)
 *
 * Returns null for:
 *   '"/abs/path/script.mjs"'                    (shebang form)
 *   '"/usr/bin/python3" "/abs/path/script.py"'  (not node)
 */
export function extractNodePath(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  // Match: optional quote, capture path until matching quote or whitespace.
  let leading;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end === -1) return null;
    leading = trimmed.slice(1, end);
  } else {
    const end = trimmed.search(/\s/);
    leading = end === -1 ? trimmed : trimmed.slice(0, end);
  }

  if (!leading) return null;

  // Only treat as a node path if the basename is a node binary.
  // Match: "node", "node.exe" (case-insensitive on Windows-style names).
  const base = leading.split(/[\\/]/).pop() ?? "";
  if (!/^node(\.exe)?$/i.test(base)) return null;

  return leading;
}

/**
 * True when the hook command's leading node path no longer exists on disk.
 * Returns false for shebang-style commands (no node prefix to validate).
 */
export function isStaleNodePath(cmd) {
  const nodePath = extractNodePath(cmd);
  if (!nodePath) return false;
  try {
    return !existsSync(nodePath);
  } catch {
    return false;
  }
}

/**
 * Build a cross-platform hook command for the cache-heal script.
 *
 * On Unix (anything except win32):
 *   - Returns just the script path (double-quoted), e.g. '"/path/to/script.mjs"'
 *   - Caller MUST ensure the script has `#!/usr/bin/env node` shebang and
 *     chmod 0o755.
 *   - `env` resolves node from PATH at runtime → survives Brew/asdf/nvm
 *     upgrades.
 *
 * On Windows:
 *   - Returns '"<nodePath>" "<scriptPath>"' (forward slashes, both quoted).
 *   - Windows has no shebang support; we must invoke node explicitly.
 */
export function buildHookCommand({ scriptPath, platform, nodePath }) {
  if (!scriptPath || typeof scriptPath !== "string") {
    throw new TypeError("buildHookCommand: scriptPath is required");
  }
  const safeScript = fwd(scriptPath);
  if (platform === "win32") {
    if (!nodePath || typeof nodePath !== "string") {
      throw new TypeError(
        "buildHookCommand: nodePath is required on win32",
      );
    }
    const safeNode = fwd(nodePath);
    return `"${safeNode}" "${safeScript}"`;
  }
  return `"${safeScript}"`;
}

/**
 * Self-heal step for ~/.claude/settings.json.
 *
 * - Looks at SessionStart hooks for any registered cache-heal hook.
 * - If its command has a stale node path (Brew upgrade scenario),
 *   rewrites the command using buildHookCommand() — Unix gets shebang
 *   form, Windows gets explicit nodePath form.
 * - No-op when:
 *     * settings.json doesn't exist
 *     * no cache-heal hook is registered
 *     * the hook command is already valid (path exists or shebang form)
 * - On Unix, also re-asserts the script's shebang + chmod +x so a healed
 *   command actually works.
 *
 * Returns: one of "noop" | "healed" | "missing-settings" — useful for
 * tests and telemetry.
 *
 * Best-effort — all I/O is wrapped; never throws.
 */
export function selfHealCacheHealHook({
  settingsPath,
  scriptPath,
  platform,
  nodePath,
}) {
  if (!settingsPath || !existsSync(settingsPath)) return "missing-settings";

  let raw;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    return "noop";
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "noop";
  }

  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return "noop";
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart
    : null;
  if (!sessionStart) return "noop";

  let healed = false;
  for (const matcher of sessionStart) {
    const inner = matcher?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h?.command !== "string") continue;
      if (!h.command.includes("ctxscribe-cache-heal")) continue;
      if (!isStaleNodePath(h.command)) continue;

      // Stale → rewrite.
      h.command = buildHookCommand({ scriptPath, platform, nodePath });
      healed = true;
    }
  }

  if (!healed) return "noop";

  // Unix: re-assert shebang + chmod so the bare-script command works.
  if (platform !== "win32" && scriptPath && existsSync(scriptPath)) {
    try {
      ensureShebangAndExecBit(scriptPath);
    } catch {
      /* best effort */
    }
  }

  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(parsed, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    return "noop";
  }
  return "healed";
}

/**
 * Issue #710 — heal Claude Code's per-session shell snapshots.
 *
 * Claude Code writes a per-session snapshot at boot:
 *   ~/.claude/shell-snapshots/snapshot-<shell>-<ts>-<rand>.sh
 * Every Bash tool call `source`s that snapshot to reproduce the user env
 * (refs/platforms/claude-code/src/utils/bash/ShellSnapshot.ts:269-336;
 * sourced before every Bash tool call at bashProvider.ts:166). The snapshot
 * bakes an `export PATH='…'` line containing the active ctxscribe
 * `bin/` for the then-current cache version, e.g.
 *   …/.claude/plugins/cache/wotjr1649/ctxscribe/1.0.146/bin
 *
 * /ctx-upgrade installs the new version and deletes the old cache dir
 * mid-session, but it never touches the snapshot — so every subsequent
 * Bash tool call fails with "Plugin directory does not exist: …/1.0.146"
 * until the session restarts.
 *
 * This helper rewrites the version segment of every ctxscribe PATH
 * entry in every snapshot under `snapshotsDir` to `currentVersion`.
 * Anchored on the `cache/<marketplace>/<plugin>/` prefix derived from
 * `pluginRoot` (the tree we actually installed into), so sibling plugins
 * (`pm-skills/pm-toolkit`, `claude-adhd/claude-adhd`, …) and shape-spoofing
 * entries (`evil-owner/ctxscribe/1.0.146`) are untouched. Upstream got the
 * same property by hard-coding its own marketplace/plugin pair as a literal,
 * but that breaks under this fork's `wotjr1649/ctxscribe/` rename; a wildcard
 * would drop it (evil-owner and wotjr1649 are the same shape). No
 * `pluginRoot`, or the wrong depth → no-op (F52).
 *
 * Layered like cache-heal-utils' brew-node fix:
 *   Layer 1 — /ctx-upgrade calls this after install (cli.ts) so the
 *             session that just upgraded sees the new bin on the next
 *             Bash call.
 *   Layer 2 — SessionStart hook calls this on every boot so a session
 *             that started before /ctx-upgrade ran still self-heals.
 *
 * Write contract:
 *   - Atomic: write to `<file>.tmp-<pid>-<ts>` then rename. Snapshots
 *     are `source`d concurrently; a half-written file would crash the
 *     bash subprocess mid-call.
 *   - Idempotent: a snapshot already on `currentVersion` is not
 *     re-written (mtime preserved). A snapshot with no ctxscribe
 *     entry is not re-written.
 *   - Best-effort: every I/O is wrapped; never throws. Telemetry shape
 *     is `{ rewritten: string[] }` for caller logging.
 *   - Cross-platform: handles both unix (`/Users/x/.claude/…`),
 *     Cygwin/Git Bash (`/c/Users/x/.claude/…`), and Windows native
 *     (`C:\Users\x\.claude\…`) path variants. ShellSnapshot.ts
 *     writes paths using whatever shell wrote them, so all three
 *     shapes can appear depending on the user's shell environment.
 */
export function rewriteShellSnapshots({ snapshotsDir, currentVersion, pluginRoot }) {
  const out = { rewritten: [] };
  if (
    !snapshotsDir || typeof snapshotsDir !== "string" ||
    !currentVersion || typeof currentVersion !== "string" ||
    !pluginRoot || typeof pluginRoot !== "string"
  ) {
    return out;
  }
  let entries;
  try {
    if (!existsSync(snapshotsDir)) return out;
    entries = readdirSync(snapshotsDir);
  } catch {
    return out;
  }

  // Trust anchor. pluginRoot is `…/cache/<marketplace>/<plugin>/<version>`.
  // The segments read off the anchor in the SAME order they appear — there is
  // no inversion step, which sidesteps the F42/F54 bug class entirely.
  // Upstream got the same property by hard-coding its own marketplace/plugin
  // pair as a literal, but that breaks under a marketplace rename. Opening the
  // match to a wildcard would also match `cache/evil-owner/ctxscribe/` and re-point dead
  // PATH entries at an attacker directory — pinned by the anti-spoofing test at
  // shell-snapshot-heal.test.ts:270.
  const parts = pluginRoot.split(/[/\\]/).filter(Boolean);
  const marketplace = parts[parts.length - 3];
  const plugin = parts[parts.length - 2];
  if (!marketplace || !plugin || parts[parts.length - 4] !== "cache") return out;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // $1 — `cache/<marketplace>/<plugin>/`  $2 — version  $3 — separator + `bin`
  const versionSegmentRe = new RegExp(
    `(cache[/\\\\]${esc(marketplace)}[/\\\\]${esc(plugin)}[/\\\\])([^/\\\\]+)([/\\\\]bin)`,
    "g",
  );

  for (const name of entries) {
    if (!name.endsWith(".sh")) continue;
    const file = join(snapshotsDir, name);
    let content;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      content = readFileSync(file, "utf-8");
    } catch {
      // Binary, unreadable, or vanished — skip.
      continue;
    }

    let touched = false;
    const next = content.replace(
      versionSegmentRe,
      (whole, prefix, version, suffix) => {
        if (version === currentVersion) return whole;
        touched = true;
        return `${prefix}${currentVersion}${suffix}`;
      },
    );
    if (!touched) continue;

    // Atomic rename — never write directly to `file` because the
    // snapshot may be sourced by a concurrent Bash subprocess.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, next, "utf-8");
      renameSync(tmp, file);
      out.rewritten.push(file);
    } catch {
      // Best-effort cleanup of the tmp file; never throw.
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }

  return out;
}

/**
 * Issue #710 Layer 2 — self-heal entry point for SessionStart.
 *
 * Resolves the snapshots directory + current version from the live
 * environment (or accepts explicit overrides for tests) and delegates to
 * `rewriteShellSnapshots`. Wrap-and-swallow; never throws.
 *
 * `pluginRoot` (`…/cache/<marketplace>/<plugin>/<version>`) is the trust
 * anchor: `rewriteShellSnapshots` derives the `cache/<marketplace>/<plugin>/`
 * prefix from it and only rewrites PATH entries under that exact tree.
 * Passed straight through — never `resolve(pluginRoot, "..")`; the wrong
 * depth trips the guard and silently no-ops (which is exactly the dead-heal
 * state F52 fixes).
 */
export function selfHealShellSnapshots({ snapshotsDir, pluginRoot, currentVersion }) {
  return rewriteShellSnapshots({ snapshotsDir, currentVersion, pluginRoot });
}

/**
 * Ensure a script starts with `#!/usr/bin/env node` and has 0o755 mode.
 * Idempotent — leaves correctly-shebanged scripts unchanged.
 */
export function ensureShebangAndExecBit(scriptPath) {
  if (!scriptPath || !existsSync(scriptPath)) return;
  try {
    const content = readFileSync(scriptPath, "utf-8");
    if (!content.startsWith("#!")) {
      writeFileSync(scriptPath, `#!/usr/bin/env node\n${content}`, "utf-8");
    }
    // statSync().mode lower 9 bits = perms.
    const mode = statSync(scriptPath).mode & 0o777;
    if (mode !== 0o755) {
      chmodSync(scriptPath, 0o755);
    }
  } catch {
    /* best effort */
  }
}
