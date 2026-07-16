/**
 * Issues #717 + #736 — server-side echo of the executed code/command.
 *
 * Both issues request that ctx_execute / ctx_execute_file / ctx_batch_execute
 * surface WHAT the agent ran so users can audit, debug, and block command
 * patterns. The server is the right layer — adapters render whatever the
 * response carries, so one fix covers all 17 adapters.
 *
 * Coverage by behaviour (vertical slices):
 *   1. runBatchCommands per-command section echoes `$ <command>` after `# <label>`
 *   2. ctx_batch_execute summary carries a "## Commands" inventory before
 *      "## Indexed Sections", listing each `- <label>: \`<command>\``
 *   3. Long commands (>500 chars) are truncated with `…` so heredoc payloads
 *      cannot dominate the response body
 *   4. ctx_execute does NOT return the source code (audit 2026-07: the echo
 *      was ~26% of ctx_execute response bytes while the caller already holds
 *      the code it sent); the provenance copy goes to the FTS5 index instead
 *      and is ctx_search-hittable (Behaviour 4b)
 *   5. ctx_execute_file likewise returns stdout only — no path header, no
 *      fenced source block
 *
 * Tests 1-3 hit the pure runBatchCommands/formatCommandOutput surface (fast,
 * no spawn). Tests 4-5 hit the live MCP server over JSON-RPC (covers the
 * tool handler wiring end-to-end).
 *
 * Run: npx vitest run tests/core/echo-commands.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  runBatchCommands,
  type BatchCommand,
} from "../../src/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpEntry = resolve(__dirname, "..", "..", "start.mjs");

interface MockResult { stdout: string; stderr?: string; timedOut?: boolean; }

function mkMockExecutor(
  handler: (code: string, timeout: number | undefined) => Promise<MockResult> | MockResult,
): { execute: (input: { language: "shell"; code: string; timeout: number | undefined }) => Promise<MockResult> } {
  return {
    execute: async ({ code, timeout }) => Promise.resolve(handler(code, timeout)),
  };
}

const NOOP_PREFIX = "";

// ════════════════════════════════════════════════════════════════════════════
// Behaviour 1 — runBatchCommands echoes `$ <command>` in each section
// ════════════════════════════════════════════════════════════════════════════
describe("issue #736 — ctx_batch_execute echoes the ran command per section", () => {
  test("serial path: each section header carries `$ <command>` below `# <label>`", async () => {
    const cmds: BatchCommand[] = [
      { label: "git commits mentioning niri in messages", command: "git log --all --grep='niri' --regexp-ignore-case" },
      { label: "git pickaxe niri content changes", command: "git log --all -i -S'niri' --date=short" },
      { label: "git changed paths containing niri", command: "git log --all -- '**/*niri*'" },
    ];
    const exec = mkMockExecutor(() => ({ stdout: "ok\n" }));
    const { outputs } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );

    expect(outputs).toHaveLength(3);
    for (let i = 0; i < cmds.length; i++) {
      expect(outputs[i]).toContain(`# ${cmds[i].label}`);
      expect(outputs[i]).toContain(`$ ${cmds[i].command}`);
    }
  });

  test("parallel path: each section header carries `$ <command>` below `# <label>`", async () => {
    const cmds: BatchCommand[] = [
      { label: "alpha", command: "echo alpha" },
      { label: "bravo", command: "echo bravo" },
      { label: "charlie", command: "echo charlie" },
    ];
    const exec = mkMockExecutor(() => ({ stdout: "ok\n" }));
    const { outputs } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 3, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    for (let i = 0; i < cmds.length; i++) {
      expect(outputs[i]).toContain(`# ${cmds[i].label}`);
      expect(outputs[i]).toContain(`$ ${cmds[i].command}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Behaviour 3 — Long commands are truncated with `…`
// ════════════════════════════════════════════════════════════════════════════
describe("issue #736 — pathological heredoc commands truncate cleanly", () => {
  test("commands longer than 500 chars are clipped with an ellipsis marker", async () => {
    const payload = "x".repeat(2000);
    const heredoc = `node - <<'NODE'\n${payload}\nNODE`;
    const exec = mkMockExecutor(() => ({ stdout: "ok\n" }));
    const { outputs } = await runBatchCommands(
      [{ label: "heredoc", command: heredoc }],
      { timeout: 5000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    const section = outputs[0];
    // Must still echo a `$ ` line but bounded in length and end with …
    const dollarLine = section.split("\n").find((l) => l.startsWith("$ "))!;
    expect(dollarLine).toBeDefined();
    expect(dollarLine.length).toBeLessThan(600); // 500 budget + `$ ` + ellipsis
    expect(dollarLine.endsWith("…")).toBe(true);
    // Sanity: full 2000-char payload is NOT inlined verbatim
    expect(section).not.toContain(payload);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// JSON-RPC harness for live-server behaviours (Behaviours 4/5)
// ════════════════════════════════════════════════════════════════════════════

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

function spawnServer(extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn("node", [mcpEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1", ...extraEnv },
  });
}

function sendRpc(proc: ChildProcess, msg: Record<string, unknown>): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

async function awaitRpc(
  proc: ChildProcess,
  id: number,
  request: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<RpcResponse | undefined> {
  return new Promise((res) => {
    let buffer = "";
    const onData = (d: Buffer) => {
      buffer += d.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as RpcResponse;
          if (parsed.id === id) {
            proc.stdout!.off("data", onData);
            clearTimeout(timer);
            res(parsed);
            return;
          }
        } catch { /* ignore non-JSON output */ }
      }
    };
    const timer = setTimeout(() => {
      proc.stdout!.off("data", onData);
      res(undefined);
    }, timeoutMs);
    proc.stdout!.on("data", onData);
    sendRpc(proc, request);
  });
}

async function initServer(proc: ChildProcess): Promise<void> {
  await awaitRpc(proc, 1, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "echo-commands-test", version: "1.0" } },
  });
  sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
}

// ════════════════════════════════════════════════════════════════════════════
// Behaviour 4 — ctx_execute keeps the source code OUT of the response.
// The caller already holds the code it sent (it is in the tool_use params);
// returning it again measured ~26% of ctx_execute response bytes (audit
// 2026-07). Provenance now lives in the FTS5 index only (Behaviour 4b).
// ════════════════════════════════════════════════════════════════════════════
describe("issue #717 follow-up — ctx_execute does not echo the code back", () => {
  let projectDir: string;
  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "echo-exec-"));
  });
  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("success path: response carries stdout but no fenced block and no source", async () => {
    const proc = spawnServer({ CLAUDE_PROJECT_DIR: projectDir });
    try {
      await initServer(proc);
      const marker = `EXEC-MARKER-${Math.random().toString(36).slice(2)}`;
      const code = `console.log("${marker}");`;
      const resp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_execute", arguments: { language: "javascript", code } },
      });
      expect(resp?.error).toBeUndefined();
      expect(resp?.result?.isError ?? false).toBe(false);
      const text = resp?.result?.content?.[0]?.text ?? "";
      // Stdout content arrives…
      expect(text).toContain(marker);
      // …but the source code does not round-trip
      expect(text).not.toContain("```javascript");
      expect(text).not.toContain(code);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("Behaviour 4b: intent path indexes the code — a code-only token is ctx_search-hittable, yet absent from the execute response", async () => {
    const proc = spawnServer({ CLAUDE_PROJECT_DIR: projectDir });
    try {
      await initServer(proc);
      // Token appears ONLY in the source, never in stdout. Discriminating
      // case: before the fix, indexed chunks carried raw stdout only, so
      // this search MISSED (live-fired 2026-07-17); it must now hit.
      const codeToken = `CODETOKEN${Math.random().toString(36).slice(2)}`;
      const code = [
        `const ${codeToken} = 1;`,
        `for (let i = 0; i < 700; i++) console.log("line " + i + " lorem ipsum dolor sit amet");`,
      ].join("\n");
      const execResp = await awaitRpc(proc, 110, {
        jsonrpc: "2.0", id: 110, method: "tools/call",
        params: { name: "ctx_execute", arguments: { language: "javascript", code, intent: "lorem lines" } },
      });
      expect(execResp?.error).toBeUndefined();
      const execText = execResp?.result?.content?.[0]?.text ?? "";
      // The declaration line must not ride back in the response
      expect(execText).not.toContain(`const ${codeToken}`);
      expect(execText).not.toContain("```javascript");

      const searchResp = await awaitRpc(proc, 111, {
        jsonrpc: "2.0", id: 111, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [codeToken] } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      // Provenance is recallable on demand from the index
      expect(searchText).toContain(codeToken);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// Behaviour 6 — ctx_batch_execute summary carries a "## Commands" inventory
//               so the response itself (not just per-section echoes) lists
//               every command the agent ran. Placed before "## Indexed
//               Sections" per the issue templates.
// ════════════════════════════════════════════════════════════════════════════
describe("issue #736 — ctx_batch_execute summary includes a Commands inventory", () => {
  let projectDir: string;
  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "echo-batch-"));
  });
  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("response carries `## Commands` listing each `- <label>: \\`<command>\\`` before `## Indexed Sections`", async () => {
    const proc = spawnServer({ CLAUDE_PROJECT_DIR: projectDir });
    try {
      await initServer(proc);
      const resp = await awaitRpc(proc, 102, {
        jsonrpc: "2.0", id: 102, method: "tools/call",
        params: {
          name: "ctx_batch_execute",
          arguments: {
            commands: [
              { label: "alpha", command: "echo alpha-output" },
              { label: "bravo", command: "echo bravo-output" },
              { label: "charlie", command: "echo charlie-output" },
            ],
            queries: ["alpha"],
          },
        },
      });
      expect(resp?.error).toBeUndefined();
      const text = resp?.result?.content?.[0]?.text ?? "";

      // Commands inventory present
      expect(text).toContain("## Commands");
      expect(text).toMatch(/- alpha: `echo alpha-output`/);
      expect(text).toMatch(/- bravo: `echo bravo-output`/);
      expect(text).toMatch(/- charlie: `echo charlie-output`/);
      // Ordering: Commands BEFORE Indexed Sections
      const cmdIdx = text.indexOf("## Commands");
      const secIdx = text.indexOf("## Indexed Sections");
      expect(cmdIdx).toBeGreaterThan(-1);
      expect(secIdx).toBeGreaterThan(-1);
      expect(cmdIdx).toBeLessThan(secIdx);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// Behaviour 5 — ctx_execute_file returns stdout only (no path/code preamble)
// ════════════════════════════════════════════════════════════════════════════
describe("issue #717 follow-up — ctx_execute_file does not echo path + code", () => {
  let projectDir: string;
  let dataFile: string;
  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "echo-execfile-"));
    dataFile = join(projectDir, "sample.txt");
    writeFileSync(dataFile, "line1\nline2\nline3\n", "utf-8");
  });
  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("success path: response carries stdout only — no path header, no fenced code", async () => {
    const proc = spawnServer({ CLAUDE_PROJECT_DIR: projectDir });
    try {
      await initServer(proc);
      const marker = `FILE-MARKER-${Math.random().toString(36).slice(2)}`;
      const code = `console.log("${marker}", FILE_CONTENT.split("\\n").length);`;
      const resp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_execute_file", arguments: { path: "sample.txt", language: "javascript", code } },
      });
      expect(resp?.error).toBeUndefined();
      expect(resp?.result?.isError ?? false).toBe(false);
      const text = resp?.result?.content?.[0]?.text ?? "";
      // Stdout arrives…
      expect(text).toContain(marker);
      // …with no provenance preamble riding along
      expect(text).not.toMatch(/path=.*sample\.txt/);
      expect(text).not.toContain("```javascript");
      expect(text).not.toContain(code);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);
});
