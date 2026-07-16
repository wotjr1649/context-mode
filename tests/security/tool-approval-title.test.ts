/**
 * The MCP approval prompt renders `serverName - <title> (MCP)`, and the host
 * cannot inspect tool params. For tools that run model-authored code, the title
 * is therefore the only place the user learns what they are approving.
 *
 * These assertions started life inside the #852 project-boundary suite. That
 * boundary was removed — it validated `ctx_execute_file`'s `path` while the same
 * call's `code` could read anything, so it never held — but the disclosure
 * requirement outlives it, and is now the only honest control on this surface.
 * Nothing else in the repo pins these titles.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("execution tools disclose code execution in their MCP-prompt title", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  // titleAfter: the first double-quoted string following a `title:` key that
  // appears after `marker`. Source-introspection, no regex (project rule).
  function titleAfter(src: string, marker: string): string | null {
    const i = src.indexOf(marker);
    if (i === -1) return null;
    const t = src.indexOf("title:", i);
    if (t === -1) return null;
    const q1 = src.indexOf('"', t);
    const q2 = src.indexOf('"', q1 + 1);
    return q1 === -1 || q2 === -1 ? null : src.slice(q1 + 1, q2);
  }

  test("execution tools announce code execution in their MCP-prompt title (#852)", () => {
    // refs(claude-code): the approval prompt renders `serverName - <title> (MCP)`;
    // the title is the one server-controlled field, so it must read as code-exec.
    const execTitle = titleAfter(serverSrc, '"ctx_execute",');
    const fileTitle = titleAfter(serverSrc, '"ctx_execute_file",');
    expect(execTitle?.toLowerCase()).toContain("code");
    const fileLower = fileTitle?.toLowerCase() ?? "";
    expect(fileLower.includes("code") || fileLower.includes("execute")).toBe(
      true,
    );
  });
});
