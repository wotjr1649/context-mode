import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeCodexMcpJson,
  normalizeHooksOnStartup,
} from "../../hooks/normalize-hooks.mjs";

// ─────────────────────────────────────────────────────────
// Codex hands an MCP server no workspace env var and no MCP `roots` capability,
// so the server's own cwd is the only channel that can carry the project dir —
// and Codex DOES fill it: a server config that omits `cwd` is launched in the
// workspace root. ctxscribe was discarding that by pinning `"cwd": "."`, which
// Codex re-bases onto the plugin install dir; the server then had to guess the
// project from ~/.codex/sessions, and picked a different project whenever
// another Codex window was busier.
//
// `args` are passed to the child verbatim, so `./start.mjs` only resolves while
// cwd IS the plugin root. The committed manifest therefore has to keep
// `"cwd": "."` (a fresh clone's first boot depends on it — and a Codex whose MCP
// server fails to launch hangs with no timeout); only the INSTALLED copy may be
// rewritten to an absolute entry point with `cwd` dropped.
// ─────────────────────────────────────────────────────────

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

/** The manifest exactly as this repo ships it. */
const SHIPPED = JSON.stringify(
  {
    mcpServers: {
      mcp: {
        command: "node",
        args: ["./start.mjs"],
        cwd: ".",
        env: { CONTEXT_MODE_PLATFORM: "codex" },
        default_tools_approval_mode: "approve",
      },
    },
  },
  null,
  2,
);

/** Lay out a plugin tree at `root` with the shipped manifest + a real start.mjs. */
function plantPlugin(root: string): string {
  mkdirSync(join(root, ".codex-plugin"), { recursive: true });
  writeFileSync(join(root, "start.mjs"), "// entry point\n");
  writeFileSync(join(root, ".codex-plugin", "mcp.json"), SHIPPED);
  return join(root, ".codex-plugin", "mcp.json");
}

function tmpRoot(suffix: string): string {
  const base = mkdtempSync(join(tmpdir(), "ctx-codex-mcp-"));
  cleanup.push(base);
  const root = join(base, suffix);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("normalizeCodexMcpJson", () => {
  it("absolutises the entry point and drops the plugin-root cwd", () => {
    const root = "/home/u/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.0";
    const next = JSON.parse(normalizeCodexMcpJson(SHIPPED, root));
    const srv = next.mcpServers.mcp;

    expect(srv.args).toEqual([`${root}/start.mjs`]);
    expect("cwd" in srv).toBe(false); // ← the whole fix
    // Everything else must survive untouched — `approve` in particular is what
    // keeps the headless companion path from hanging on an absent approver.
    expect(srv.command).toBe("node");
    expect(srv.env).toEqual({ CONTEXT_MODE_PLATFORM: "codex" });
    expect(srv.default_tools_approval_mode).toBe("approve");
  });

  it("converts Windows backslashes to forward slashes", () => {
    const root = "C:\\Users\\u\\.codex\\plugins\\cache\\wotjr1649\\ctxscribe\\1.0.0";
    const next = JSON.parse(normalizeCodexMcpJson(SHIPPED, root));
    expect(next.mcpServers.mcp.args).toEqual([
      "C:/Users/u/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.0/start.mjs",
    ]);
  });

  it("is idempotent — a second pass is a no-op", () => {
    const root = "/home/u/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.0";
    const once = normalizeCodexMcpJson(SHIPPED, root);
    expect(normalizeCodexMcpJson(once, root)).toBe(once);
  });

  it("rewrites a placeholder entry point too", () => {
    const root = "/home/u/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.0";
    const withPlaceholder = JSON.stringify({
      mcpServers: {
        mcp: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"], cwd: "." },
      },
    });
    const srv = JSON.parse(
      normalizeCodexMcpJson(withPlaceholder, root),
    ).mcpServers.mcp;
    expect(srv.args).toEqual([`${root}/start.mjs`]);
    expect("cwd" in srv).toBe(false);
  });

  it("never touches a sibling server entry", () => {
    const root = "/home/u/.codex/plugins/cache/wotjr1649/ctxscribe/1.0.0";
    const withSibling = JSON.stringify({
      mcpServers: {
        mcp: { command: "node", args: ["./start.mjs"], cwd: "." },
        other: { command: "node", args: ["./other/server.mjs"], cwd: "." },
      },
    });
    const next = JSON.parse(normalizeCodexMcpJson(withSibling, root));
    expect(next.mcpServers.other).toEqual({
      command: "node",
      args: ["./other/server.mjs"],
      cwd: ".",
    });
  });

  it("returns malformed content unchanged rather than destroying it", () => {
    expect(normalizeCodexMcpJson("{not json", "/plugins/cache/x")).toBe(
      "{not json",
    );
  });
});

describe("normalizeHooksOnStartup — .codex-plugin/mcp.json heal", () => {
  it("heals an installed plugin", () => {
    const root = tmpRoot(join(".codex", "plugins", "cache", "wotjr1649", "ctxscribe", "1.0.0"));
    const manifest = plantPlugin(root);

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: process.execPath,
      platform: process.platform,
    });

    const srv = JSON.parse(readFileSync(manifest, "utf-8")).mcpServers.mcp;
    expect("cwd" in srv).toBe(false);
    expect(String(srv.args[0]).endsWith("/start.mjs")).toBe(true);
    expect(String(srv.args[0]).startsWith(".")).toBe(false);
  });

  it("leaves a dev checkout's committed manifest alone", () => {
    const root = tmpRoot("dev-checkout");
    const manifest = plantPlugin(root);

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: process.execPath,
      platform: process.platform,
    });

    expect(readFileSync(manifest, "utf-8")).toBe(SHIPPED);
  });

  it("refuses to rewrite when start.mjs is not on disk", () => {
    const root = tmpRoot(join(".codex", "plugins", "cache", "wotjr1649", "ctxscribe", "1.0.0"));
    const manifest = plantPlugin(root);
    rmSync(join(root, "start.mjs")); // launch target gone → do not aim Codex at it

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: process.execPath,
      platform: process.platform,
    });

    expect(readFileSync(manifest, "utf-8")).toBe(SHIPPED);
  });
});

describe("committed .codex-plugin/mcp.json", () => {
  // A fresh clone boots with THIS file. Codex passes `args` to the child
  // verbatim, so `./start.mjs` resolves only while `cwd` is the plugin root —
  // and an MCP server Codex cannot launch makes Codex hang with no timeout.
  // Do not "helpfully" drop `cwd` here: the heal above is what removes it, from
  // the installed copy, once an absolute entry point has replaced the relative one.
  it("keeps the relative, self-sufficient shape that a first boot depends on", () => {
    const shipped = JSON.parse(
      readFileSync(".codex-plugin/mcp.json", "utf-8"),
    ).mcpServers.mcp;

    expect(shipped.cwd).toBe(".");
    expect(shipped.args).toEqual(["./start.mjs"]);
    expect(shipped.command).toBe("node");
  });
});
