// normalize-hooks.mjs — fixes #378
//
// Static committed files (hooks/hooks.json, .claude-plugin/plugin.json) ship
// with `${CLAUDE_PLUGIN_ROOT}` placeholder + bare `node` command. On Windows
// + Claude Code this triggers cjs/loader:1479 errors because:
//   1. bare `node` may not resolve via PATH (Git Bash, see #369)
//   2. `${CLAUDE_PLUGIN_ROOT}` resolution can hit MSYS path mangling (#372)
//   3. backslash paths get corrupted in shell quoting
//
// Our buildNodeCommand() fix handles dynamically-generated settings.json but
// not the static committed files. Solution: start.mjs detects the placeholder
// pattern on every MCP boot and rewrites with absolute paths using
// process.execPath + forward slashes. Idempotent — only rewrites when needed.
// Survives upgrades because it runs at every start.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

// Mirror of src/util/project-dir.ts isPluginInstallPath (and of the copy inside
// start.mjs) — duplicated for the same reason those two are: this file ships as
// raw JS and cannot import the TS util.
const isPluginInstallPath = (p) =>
  /[/\\]\.(claude|codex)[/\\]plugins[/\\](cache|marketplaces)[/\\]/.test(
    String(p),
  );

// #604: matches a cache path segment `wotjr1649/ctxscribe/<version>`.
// Capture group is the X.Y.Z version. Used to detect command paths frozen on a
// previous-version dir that Claude Code's native plugin manager has since
// cleaned up. `/g` so a single content blob with multiple stale references is
// fully covered. Forward-slash only — callers convert beforehand.
const CACHE_VERSION_RE =
  /wotjr1649\/ctxscribe\/([0-9]+\.[0-9]+\.[0-9]+)(?=\/)/g;

/** Convert any path string to forward slashes (MSYS-safe). */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Extract the X.Y.Z version segment from a pluginRoot under the ctxscribe
 * cache layout. Returns null when running from npm-global, a dev checkout, or
 * any layout that does not match the `<…>/wotjr1649/ctxscribe/<v>(/…)?`
 * pattern — callers must treat null as "no stale-path check is possible".
 */
function pluginRootVersion(pluginRoot) {
  if (!pluginRoot) return null;
  const m =
    /wotjr1649\/ctxscribe\/([0-9]+\.[0-9]+\.[0-9]+)(?:\/|$)/.exec(
      fwd(pluginRoot),
    );
  return m ? m[1] : null;
}

/**
 * Does `content` reference any ctxscribe cache version segment that differs
 * from `currentVersion`? Detects the #604 ratchet: already-normalized hooks.json
 * / plugin.json carrying a previous version's absolute paths forward into a
 * newer version's cache directory after Claude Code's auto-update.
 */
function hasStaleCacheVersionSegment(content, currentVersion) {
  if (!currentVersion || !content || typeof content !== "string") return false;
  const safe = fwd(content);
  CACHE_VERSION_RE.lastIndex = 0;
  let m;
  while ((m = CACHE_VERSION_RE.exec(safe)) !== null) {
    if (m[1] !== currentVersion) return true;
  }
  return false;
}

/**
 * Pure detection: does this content need to be (re-)normalized?
 *
 * Two triggers:
 *   1. Fresh content still containing the `${CLAUDE_PLUGIN_ROOT}` placeholder
 *      — the original #378 first-boot path on any host.
 *   2. (#604) Already-resolved content whose absolute paths point at a
 *      different version of the ctxscribe cache than the current
 *      `pluginRoot`. Breaks the ratchet that previously froze stale paths
 *      after Claude Code's native plugin manager copied a previous version's
 *      hooks.json forward.
 *
 * `pluginRoot` is optional for backwards compatibility with single-arg
 * callers; without it, only the placeholder check runs.
 */
export function needsHookNormalization(content, pluginRoot) {
  if (!content || typeof content !== "string") return false;
  if (content.includes(PLACEHOLDER)) return true;
  return hasStaleCacheVersionSegment(content, pluginRootVersion(pluginRoot));
}

/**
 * Rewrite hooks.json content. Replaces:
 *   - `node "${CLAUDE_PLUGIN_ROOT}/x.mjs"` →
 *     `"<execPath>" "<pluginRoot>/x.mjs"`  (forward slashes, double-quoted)
 *
 * Pure function — takes content + paths, returns new content.
 * Idempotent — leaves already-normalized content unchanged.
 */
export function normalizeHooksJson(content, nodePath, pluginRoot) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const currentVersion = pluginRootVersion(pluginRoot);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return content;

  let mutated = false;
  for (const eventName of Object.keys(hooks)) {
    const matchers = hooks[eventName];
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const inner = matcher?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (typeof h?.command !== "string") continue;

        const hasPlaceholder = h.command.includes(PLACEHOLDER);
        // #604: also rewrite when the command holds a stale absolute path under
        // a previous-version cache dir (Claude Code's auto-update ratchet).
        const hasStale = hasStaleCacheVersionSegment(h.command, currentVersion);
        if (!hasPlaceholder && !hasStale) continue;

        let next = h.command;
        if (hasPlaceholder) {
          // Replace placeholder with absolute root (forward-slash).
          next = next.replaceAll(PLACEHOLDER, safeRoot);
          // Replace bare `node ` prefix with quoted execPath. Match both
          // `node ` and `node\t` at start, with optional surrounding whitespace.
          next = next.replace(/^\s*node\s+/, `"${safeNode}" `);
        }
        if (hasStale) {
          // Re-point every `wotjr1649/ctxscribe/<old-version>/…` segment
          // to the current pluginRoot's version. Operates on the forward-slash
          // form so MSYS-mangled paths heal as well.
          next = fwd(next).replace(
            CACHE_VERSION_RE,
            `wotjr1649/ctxscribe/${currentVersion}`,
          );
        }
        h.command = next;
        mutated = true;
      }
    }
  }

  if (!mutated) return content;

  // Preserve 2-space indent (matches committed format).
  return JSON.stringify(parsed, null, 2);
}

/**
 * Rewrite plugin.json mcpServers. Replaces:
 *   - `command: "node"` → `command: "<execPath-fwd>"`
 *   - `args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"]` →
 *     `args: ["<pluginRoot-fwd>/start.mjs"]`
 *
 * Idempotent.
 */
export function normalizePluginJson(content, nodePath, pluginRoot) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const currentVersion = pluginRootVersion(pluginRoot);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object") return content;

  let mutated = false;
  for (const name of Object.keys(servers)) {
    const srv = servers[name];
    if (!srv || typeof srv !== "object") continue;

    if (Array.isArray(srv.args)) {
      const before = srv.args;
      const after = before.map((a) => {
        if (typeof a !== "string") return a;
        let next = a;
        if (next.includes(PLACEHOLDER)) {
          next = next.replaceAll(PLACEHOLDER, safeRoot);
        }
        // #604: same auto-update ratchet hits plugin.json args (see #523).
        if (hasStaleCacheVersionSegment(next, currentVersion)) {
          next = fwd(next).replace(
            CACHE_VERSION_RE,
            `wotjr1649/ctxscribe/${currentVersion}`,
          );
        }
        return next;
      });
      if (after.some((v, i) => v !== before[i])) {
        srv.args = after;
        mutated = true;
      }
    }

    if (srv.command === "node" && mutated) {
      // Only swap bare `node` when we also rewrote args — otherwise we'd
      // touch user-customized server entries unrelated to placeholders.
      srv.command = safeNode;
    }
  }

  if (!mutated) return content;
  return JSON.stringify(parsed, null, 2);
}

/**
 * Rewrite `.codex-plugin/mcp.json` so Codex launches the MCP server IN THE
 * WORKSPACE rather than inside the plugin install dir.
 *
 * Codex gives an MCP server no workspace env var and advertises no MCP `roots`
 * capability, so the server's own `cwd` is the ONLY channel through which it can
 * learn which project Codex is driving. And Codex does supply it: when a server
 * config omits `cwd`, the launcher falls back to `fallback_cwd`, which is the
 * workspace root (`rmcp-client/src/stdio_server_launcher.rs`, verified against
 * 0.144.2 with a probe server — it came up in the project dir). ctxscribe was
 * throwing that away: the shipped manifest pins `"cwd": "."`, and Codex re-bases
 * a *relative* cwd onto the plugin root (`codex-mcp/src/plugin_config.rs`), so
 * the server always booted in `~/.codex/plugins/cache/.../ctxscribe/<version>`
 * and had to guess the project from `~/.codex/sessions` instead.
 *
 * Drop `cwd` and `start.mjs` then sees the workspace as `process.cwd()` and
 * publishes it as CONTEXT_MODE_PROJECT_DIR, which wins the resolver cascade long
 * before any session-log heuristic runs.
 *
 * Why this is a boot-time heal of the INSTALLED copy rather than a change to the
 * committed manifest: Codex passes `args` to the child verbatim — it never
 * re-bases them — so `args: ["./start.mjs"]` only resolves while `cwd` is the
 * plugin root. A fresh clone therefore MUST ship `"cwd": "."`, or its very first
 * boot cannot find start.mjs, and a Codex whose MCP server fails to launch hangs
 * with no timeout. So the committed manifest stays relative and self-sufficient,
 * and only the installed copy is absolutised — from the second session onward.
 * The caller gates this on a plugin-install path so a dev checkout is untouched.
 *
 * Idempotent. Returns `content` unchanged when there is nothing to do.
 */
export function normalizeCodexMcpJson(content, pluginRoot) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object") return content;

  const entryPath = `${fwd(pluginRoot)}/start.mjs`;
  let mutated = false;

  for (const name of Object.keys(servers)) {
    const srv = servers[name];
    if (!srv || typeof srv !== "object" || !Array.isArray(srv.args)) continue;

    // Only touch the arg that launches OUR start.mjs — a sibling server entry
    // in the same manifest must be left exactly as the user wrote it.
    const idx = srv.args.findIndex(
      (a) => typeof a === "string" && /(?:^|\/)start\.mjs$/.test(fwd(a)),
    );
    if (idx === -1) continue;

    if (srv.args[idx] !== entryPath) {
      srv.args = srv.args.map((a, i) => (i === idx ? entryPath : a));
      mutated = true;
    }
    // The whole point: with `args[idx]` absolute, `cwd` is dead weight, and its
    // presence is what was costing us the workspace.
    if ("cwd" in srv) {
      delete srv.cwd;
      mutated = true;
    }
  }

  if (!mutated) return content;
  return JSON.stringify(parsed, null, 2);
}

/**
 * Apply normalization to hooks/hooks.json ONLY (not plugin.json).
 *
 * Why a narrow variant exists (#711 + #414 / #528):
 *   - plugin.json is read by Claude Code's plugin manager and carried forward
 *     into NEW versioned cache dirs on auto-update. Baking absolute paths into
 *     it during /ctx-upgrade poisons the next version (#711).
 *   - hooks/hooks.json lives in the per-version dir and is read by the SAME
 *     Node process that needs to spawn a child. On Windows + Git Bash, Claude
 *     Code fires SessionStart/PreToolUse BEFORE MCP boot — the unresolved
 *     `${CLAUDE_PLUGIN_ROOT}` placeholder yields MODULE_NOT_FOUND for the
 *     first hook fire after /ctx-upgrade (#414).
 *
 * So /ctx-upgrade calls THIS narrow function (hooks.json only) to close the
 * Windows first-hook-fire window without re-introducing #711.
 *
 * Options:
 *   - pluginRoot:     absolute path to plugin install dir
 *   - nodePath:       process.execPath (the Node binary running this script)
 *   - jsRuntimePath:  optional — resolved Bun ≥1.0 path (#738). When set, the
 *                     rewrite uses this instead of nodePath so hook invocations
 *                     gain Bun's ~40-60ms cold-start advantage. Falls back to
 *                     nodePath when omitted (back-compat).
 *   - platform:       process.platform. Triggers a write on:
 *                       • "win32" / "linux" — the original #378 path
 *                         (#369/#372 MSYS / nvm fixes), AND
 *                       • any platform when jsRuntimePath !== nodePath
 *                         (#738 — bun swap is a perf optimisation that should
 *                         not be gated by the historical Windows-only check;
 *                         issue was filed from macOS).
 *
 * Best-effort — never throws.
 */
export function normalizeHooksJsonOnly({ pluginRoot, nodePath, jsRuntimePath, platform }) {
  const effectiveRuntime = jsRuntimePath || nodePath;
  // #378 path: always normalize on Windows/Linux to heal placeholder + bare-node.
  // #738 path: also fire on macOS when we have a real bun swap to perform — the
  // legacy gate skipped darwin because system node was reliable there, but bun
  // resolution is the new perf-win that the gate now needs to allow through.
  const isPlatformGated = platform !== "win32" && platform !== "linux";
  const hasBunSwap = jsRuntimePath && jsRuntimePath !== nodePath;
  if (isPlatformGated && !hasBunSwap) return;
  if (!pluginRoot || !effectiveRuntime) return;

  try {
    const hooksPath = resolve(pluginRoot, "hooks", "hooks.json");
    if (existsSync(hooksPath)) {
      const original = readFileSync(hooksPath, "utf-8");
      if (needsHookNormalization(original, pluginRoot)) {
        const next = normalizeHooksJson(original, effectiveRuntime, pluginRoot);
        if (next !== original) {
          writeFileSync(hooksPath, next, "utf-8");
        }
      }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Apply normalization to hooks.json and plugin.json on startup.
 *
 * Options:
 *   - pluginRoot:     absolute path to plugin install dir (e.g. __dirname of start.mjs)
 *   - nodePath:       process.execPath
 *   - jsRuntimePath:  optional Bun ≥1.0 path (#738) — used for hooks.json only,
 *                     never for plugin.json (the MCP server itself must stay on
 *                     Node — better-sqlite3 ABI, #543)
 *   - platform:       process.platform ("win32" and "linux" trigger plugin.json
 *                     rewrite for #378; hooks.json also rewrites on darwin when
 *                     `jsRuntimePath` !== `nodePath` for #738)
 *
 * Best-effort — never throws.
 */
export function normalizeHooksOnStartup({ pluginRoot, nodePath, jsRuntimePath, platform }) {
  // Delegate the hooks.json branch to the narrow helper so /ctx-upgrade and
  // boot share one implementation. plugin.json normalization stays here —
  // start.mjs and postinstall still need it; /ctx-upgrade must NOT (#711).
  normalizeHooksJsonOnly({ pluginRoot, nodePath, jsRuntimePath, platform });

  // .codex-plugin/mcp.json — hand Codex's workspace cwd back to the MCP server
  // (see normalizeCodexMcpJson). Deliberately NOT behind the win32/linux gate
  // below: that gate exists for #378 PATH quirks, whereas the plugin-root `cwd`
  // costs us the project on every platform. Installed plugins only — a dev
  // checkout must keep the committed, relative manifest.
  if (pluginRoot && isPluginInstallPath(pluginRoot)) {
    try {
      const mcpPath = resolve(pluginRoot, ".codex-plugin", "mcp.json");
      const entry = resolve(pluginRoot, "start.mjs");
      // Never aim Codex at a path we cannot prove exists: a manifest whose
      // server fails to launch makes Codex hang with no timeout, so the bar for
      // touching this file is that the launch target is on disk right now.
      if (existsSync(mcpPath) && existsSync(entry)) {
        const original = readFileSync(mcpPath, "utf-8");
        const next = normalizeCodexMcpJson(original, pluginRoot);
        if (next !== original) {
          JSON.parse(next); // refuse to ship a manifest Codex cannot parse
          // Write-then-rename: a torn write here is not a bad session, it is a
          // permanently unlaunchable plugin.
          const tmp = `${mcpPath}.tmp`;
          writeFileSync(tmp, next, "utf-8");
          renameSync(tmp, mcpPath);
        }
      }
    } catch {
      /* best effort — the committed relative manifest still boots */
    }
  }

  // plugin.json rewrite: ALWAYS uses nodePath (MCP server must stay on Node,
  // #543). Bun resolution is irrelevant here — `jsRuntimePath` is consumed
  // exclusively by the hooks.json branch above.
  if (platform !== "win32" && platform !== "linux") return;
  if (!pluginRoot || !nodePath) return;

  // .claude-plugin/plugin.json
  try {
    const pluginPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
    if (existsSync(pluginPath)) {
      const original = readFileSync(pluginPath, "utf-8");
      if (needsHookNormalization(original, pluginRoot)) {
        const next = normalizePluginJson(original, nodePath, pluginRoot);
        if (next !== original) {
          writeFileSync(pluginPath, next, "utf-8");
        }
      }
    }
  } catch {
    /* best effort */
  }
}
