import { describe, it, expect } from "vitest";
import {
  CLIENT_NAME_TO_PLATFORM,
  REMOVED_CLIENT_NAMES,
  UnsupportedClientError,
} from "../../src/adapters/client-map.js";

describe("CLIENT_NAME_TO_PLATFORM", () => {
  it("maps claude-code → claude-code", () => {
    expect(CLIENT_NAME_TO_PLATFORM["claude-code"]).toBe("claude-code");
  });

  it("maps Codex → codex", () => {
    expect(CLIENT_NAME_TO_PLATFORM["Codex"]).toBe("codex");
  });

  it("maps codex-mcp-client → codex", () => {
    expect(CLIENT_NAME_TO_PLATFORM["codex-mcp-client"]).toBe("codex");
  });

  it("returns undefined for unknown client name", () => {
    expect(CLIENT_NAME_TO_PLATFORM["some-unknown-client"]).toBeUndefined();
  });
});

describe("REMOVED_CLIENT_NAMES", () => {
  it("lists a removed client so it hard-fails instead of degrading", () => {
    expect(REMOVED_CLIENT_NAMES.has("cursor-vscode")).toBe(true);
    expect(REMOVED_CLIENT_NAMES.has("Visual-Studio-Code")).toBe(true);
  });

  it("does not list a supported client", () => {
    expect(REMOVED_CLIENT_NAMES.has("claude-code")).toBe(false);
    expect(REMOVED_CLIENT_NAMES.has("Codex")).toBe(false);
  });
});

describe("UnsupportedClientError", () => {
  it("sets .name so server.ts can match it across a bundle boundary", () => {
    const err = new UnsupportedClientError("cursor-vscode");
    expect(err.name).toBe("UnsupportedClientError");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/cursor-vscode/);
  });
});
