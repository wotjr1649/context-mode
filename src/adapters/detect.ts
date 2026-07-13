/**
 * adapters/detect — Auto-detect which platform is running.
 *
 * Hard fork: Claude Code and Codex only.
 *
 * Detection priority:
 *   1. Environment variables (high confidence)
 *   2. Config directory existence (medium confidence)
 *   3. Fallback to Claude Code (low confidence — most common)
 *
 * Verified env vars per platform (from source code audit):
 *   - Claude Code: CLAUDE_CODE_ENTRYPOINT, CLAUDE_PLUGIN_ROOT,
 *                  CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID | ~/.claude/
 *   - Codex CLI:   CODEX_CI, CODEX_THREAD_ID | ~/.codex/
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { PlatformId, DetectionSignal, HookAdapter } from "./types.js";
import { CLIENT_NAME_TO_PLATFORM, REMOVED_CLIENT_NAMES, UnsupportedClientError } from "./client-map.js";

/**
 * Issue #539 — VS Code host disambiguator. A VS Code-hosted terminal exports
 * VSCODE_PID/VSCODE_CWD into every spawned child — an ambiguous signal on its
 * own. When one is present, we look at ~/.claude/plugins/installed_plugins.json:
 * if that file lists context-mode as an installed plugin, the runtime MUST be
 * Claude Code (only Claude Code has a concept of Claude plugins), so detection
 * resolves to claude-code instead of falling through to a lower-confidence
 * config-directory tier. Memoized per-process: the file is read at most once,
 * with a tri-state cache so a missing/malformed file does not trigger repeated
 * I/O on the detect() hot path.
 */
type PluginCache = { hasCM: boolean } | "miss" | null;
let claudeCodePluginCache: PluginCache = null;

function claudeCodeHasContextModePlugin(): boolean {
  if (claudeCodePluginCache !== null) {
    return claudeCodePluginCache !== "miss" && claudeCodePluginCache.hasCM;
  }
  try {
    const path = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as {
      plugins?: Record<string, unknown>;
      enabledPlugins?: Record<string, unknown>;
    };
    const keys = [
      ...Object.keys(parsed.plugins ?? {}),
      ...Object.keys(parsed.enabledPlugins ?? {}),
    ];
    const hasCM = keys.some((k) => k.includes("ctxscribe"));
    claudeCodePluginCache = { hasCM };
    return hasCM;
  } catch {
    claudeCodePluginCache = "miss";
    return false;
  }
}

/** Test-only: reset the installed_plugins.json memo so each test starts cold. */
export function __resetClaudeCodePluginCacheForTests(): void {
  claudeCodePluginCache = null;
}

/**
 * Test-only: pretend installed_plugins.json does not exist (or has no
 * context-mode entry). Lets tests that exercise the VSCODE_PID env-var
 * disambiguation path (#539) run on a developer machine that actually has
 * context-mode installed as a Claude Code plugin.
 */
export function __seedClaudeCodePluginCacheMissForTests(): void {
  claudeCodePluginCache = "miss";
}

/**
 * Tag for each PLATFORM_ENV_VARS row.
 *   - `workspace`: env var names a project/working directory. Used by
 *     `resolveProjectDir({ strictPlatform })` to form the candidate list.
 *   - `identification`: env var only signals which host is running; carries
 *     no project path. PRESERVED in normal operation (some are load-bearing
 *     for hook integrations on the host that owns them, e.g. CLAUDE_PLUGIN_ROOT
 *     for Claude Code's hook context).
 *
 * Issue #545 — algorithmic env-leak fix. The split allows resolveProjectDir
 * to derive ALLOW (own workspace vars) and BAN (other platforms' workspace
 * vars) sets from a single registry, keeping every adapter on equal rules.
 *
 * Issue #561 — FOREIGN identification vars MUST be scrubbed when spawning a
 * context-mode child under a different host (a bridge parent must scrub
 * Claude Code identification vars CLAUDE_CODE_ENTRYPOINT / CLAUDE_PLUGIN_ROOT
 * to prevent detectPlatform() in the child from misidentifying the host as
 * claude-code and writing the host's data into ~/.claude/context-mode/).
 */
export type EnvVarRole = "workspace" | "identification";
export interface PlatformEnvEntry {
  readonly name: string;
  readonly role: EnvVarRole;
  /**
   * When `false`, this entry is NOT used as a high-confidence detection
   * signal — only consumed by `workspaceEnvVarsFor` (project-dir cascade
   * and bridge env scrub). Use for consumer-set
   * workspace vars that the host runtime never emits itself, so that a
   * stale env var on an unrelated host does not misclassify the platform
   * (issue #542). Default: `true` (entry participates in detection).
   */
  readonly detect?: boolean;
}

/**
 * High-confidence env vars per platform, checked in priority order.
 * Single source of truth — consumed by detectPlatform() below and by
 * `resolveProjectDir({ strictPlatform })` for cascade construction.
 * Tests also iterate this map to clear platform-related env vars
 * deterministically.
 *
 * The map shape is `Map<PlatformId, ReadonlyArray<PlatformEnvEntry>>`. Use
 * `getEnvVarNames(p)` to get just the names (legacy `string[]` shape).
 */
const _PLATFORM_ENV_VARS_RAW: ReadonlyArray<readonly [PlatformId, readonly PlatformEnvEntry[]]> = [
  // Order matters: forks listed BEFORE the fork's parent so collision
  // detection works. Every entry verified against platform's own runtime
  // source code (PR #376 follow-up: full audit, May 2026 — see git blame).
  // Claude Code — verified against a live `env` dump (2026-05-11):
  //   CLAUDE_CODE_ENTRYPOINT=cli              (set on every CC session)
  //   CLAUDE_PLUGIN_ROOT=/Users/.../<version>  (set when a plugin is loaded)
  //   CLAUDE_PROJECT_DIR=/Users/.../project    (set in hooks context)
  //   CLAUDE_SESSION_ID=<uuid>                 (legacy session marker)
  ["claude-code", [
    { name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" },
    { name: "CLAUDE_PLUGIN_ROOT",     role: "identification" },
    { name: "CLAUDE_PROJECT_DIR",     role: "workspace" },
    { name: "CLAUDE_SESSION_ID",      role: "identification" },
  ]],
  // codex — openai/codex codex-rs/core/src/exec_env.rs sets CODEX_THREAD_ID
  // per exec; unified_exec/process_manager.rs sets CODEX_CI in CI mode.
  ["codex", [
    { name: "CODEX_THREAD_ID", role: "identification" },
    { name: "CODEX_CI",        role: "identification" },
  ]],
];

export const PLATFORM_ENV_VARS: ReadonlyMap<PlatformId, readonly PlatformEnvEntry[]> = new Map(
  _PLATFORM_ENV_VARS_RAW,
);

/**
 * Backwards-compat shim: legacy `string[]` shape used by detection logic and
 * by tests that iterate the registry to clear env vars. Always returns the
 * names in registry order.
 */
export function getEnvVarNames(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? []).map((e) => e.name);
}

/**
 * Issue #545 — return only role=workspace env var names for a platform, in
 * registry order. Empty array for adapters with no workspace var (e.g.
 * codex). Consumed by `resolveProjectDir({ strictPlatform })` to build the
 * cascade.
 */
export function workspaceEnvVarsFor(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? [])
    .filter((e) => e.role === "workspace")
    .map((e) => e.name);
}

/**
 * Sync map from platform identifier → home-relative path segments where that
 * platform stores its config. Mirrors the `super([...])` argument passed by
 * each adapter — kept in sync as the single source of truth used when we need
 * a session dir BEFORE an adapter has been instantiated (race window between
 * MCP server start and `initialize` handshake completion).
 *
 * Returns `null` for "unknown" or any string outside the supported set so the
 * caller can decide on a safe fallback.
 */
export function getSessionDirSegments(platform: string): string[] | null {
  switch (platform) {
    case "claude-code": return [".claude"];
    case "codex":        return [".codex"];
    default:             return null;
  }
}

/**
 * Detect the current platform by checking env vars and config dirs.
 *
 * @param clientInfo - Optional MCP clientInfo from initialize handshake.
 *   When provided, takes highest priority (zero-config detection).
 */
export function detectPlatform(clientInfo?: { name: string; version?: string }): DetectionSignal {
  // ── Highest priority: MCP clientInfo ──────────────────
  if (clientInfo?.name) {
    const platform = CLIENT_NAME_TO_PLATFORM[clientInfo.name];
    if (platform) {
      return {
        platform,
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}"`,
      };
    }
    // Net 4 (branch B): a client this fork REMOVED hard-fails instead of
    // silently degrading to claude-code. The qwen check is a prefix match —
    // the runtime name is `qwen-cli-mcp-client-<serverName>`, so a Set lookup
    // (and tsc) can never catch it. Unknown names NOT on this list fall
    // through to the config-dir sniffing below.
    if (
      REMOVED_CLIENT_NAMES.has(clientInfo.name) ||
      clientInfo.name.startsWith("qwen-cli-mcp-client")
    ) {
      throw new UnsupportedClientError(clientInfo.name);
    }
  }

  // ── Explicit platform override ────────────────────────
  const platformOverride = process.env.CONTEXT_MODE_PLATFORM;
  if (platformOverride) {
    const validPlatforms: PlatformId[] = ["claude-code", "codex"];
    if (validPlatforms.includes(platformOverride as PlatformId)) {
      return {
        platform: platformOverride as PlatformId,
        confidence: "high",
        reason: `CONTEXT_MODE_PLATFORM=${platformOverride} override`,
      };
    }
  }

  // ── High confidence: environment variables ─────────────

  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (vars.some((v) => v.detect !== false && process.env[v.name])) {
      return {
        platform,
        confidence: "high",
        reason: `${vars.filter((v) => v.detect !== false).map((v) => v.name).join(" or ")} env var set`,
      };
    }
  }

  // Issue #539: Claude Code booting inside VS Code exposes only VSCODE_* env
  // markers (Microsoft's `code` exports VSCODE_PID/VSCODE_CWD into every
  // child process) — the CLAUDE_* vars handled by the loop above may not
  // have propagated yet on an MCP-server-only boot. If this machine's
  // ~/.claude/plugins/installed_plugins.json lists context-mode, that is
  // Claude Code running in a VS Code terminal — keep high confidence
  // instead of falling through to the config-dir tier.
  if (
    (process.env.VSCODE_PID || process.env.VSCODE_CWD) &&
    claudeCodeHasContextModePlugin()
  ) {
    return {
      platform: "claude-code",
      confidence: "high",
      reason:
        "VSCODE_PID set but ~/.claude/plugins/installed_plugins.json lists context-mode (issue #539 fallback)",
    };
  }

  // ── Medium confidence: config directory existence ──────

  const home = homedir();

  if (existsSync(resolve(home, ".claude"))) {
    return {
      platform: "claude-code",
      confidence: "medium",
      reason: "~/.claude/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".codex"))) {
    return {
      platform: "codex",
      confidence: "medium",
      reason: "~/.codex/ directory exists",
    };
  }

  // ── Low confidence: fallback ───────────────────────────

  return {
    platform: "claude-code",
    confidence: "low",
    reason: "No platform detected, defaulting to Claude Code",
  };
}

/**
 * Get the adapter instance for a given platform.
 * Lazily imports platform-specific adapter modules.
 */
export async function getAdapter(platform?: PlatformId): Promise<HookAdapter> {
  const target = platform ?? detectPlatform().platform;

  switch (target) {
    case "claude-code": {
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }

    case "codex": {
      const { CodexAdapter } = await import("./codex/index.js");
      return new CodexAdapter();
    }

    case "unknown": {
      // Normal state (CLI path booted without clientInfo, fresh install) —
      // an explicit contract, not a silent fallback.
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }

    default:
      // PlatformId is narrowed to 3, so unreachable in TS. This is the runtime
      // string defense for a value that bypassed the type (e.g. a bad cast).
      throw new Error(
        `unsupported platform: ${target}. This fork supports claude-code and codex only.`,
      );
  }
}
