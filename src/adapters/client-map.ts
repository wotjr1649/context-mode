/**
 * adapters/client-map — MCP clientInfo.name → PlatformId mapping.
 *
 * Source: Apify MCP Client Capabilities Registry
 * https://github.com/apify/mcp-client-capabilities
 *
 * Only includes platforms we have adapters for.
 */

import type { PlatformId } from "./types.js";

export const CLIENT_NAME_TO_PLATFORM: Record<string, PlatformId> = {
  "claude-code": "claude-code",
  "Codex": "codex",
  "codex-mcp-client": "codex",
};

/**
 * The only error server.ts rethrows by name. It fires wherever clientInfo is
 * present — the request-boundary re-detections today (ctx_doctor / ctx_upgrade).
 * MCP init sees no clientInfo yet (connect-then-sync timing at getClientVersion),
 * so init-time enforcement waits on a future init-await.
 */
export class UnsupportedClientError extends Error {
  constructor(public readonly clientName: string) {
    super(`unsupported client: "${clientName}". This fork supports Claude Code and Codex only.`);
    this.name = "UnsupportedClientError";
  }
}

/**
 * clientInfo.name values for the clients this fork removed. Kept so we fail
 * explicitly instead of silently degrading them to claude-code. Unknown names
 * NOT listed here fall through to config-dir sniffing — branch (B). The qwen
 * entry also guards the dynamic `qwen-cli-mcp-client-<serverName>` prefix,
 * matched separately in detect.ts.
 */
export const REMOVED_CLIENT_NAMES = new Set<string>([
  "gemini-cli-mcp-client", "antigravity-client", "antigravity-cli", "agy",
  "cursor-vscode", "Visual-Studio-Code", "copilot-cli", "GitHub Copilot CLI",
  "github-copilot-cli", "JetBrains Client", "IntelliJ IDEA", "PyCharm",
  "Kilo Code", "Kiro CLI", "Pi CLI", "Pi Coding Agent", "omp-coding-agent",
  "Zed", "zed", "qwen-code", "qwen-cli-mcp-client", "kimi-code", "kimi", "Kimi Code",
]);
