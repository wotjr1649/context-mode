/**
 * R1 passive indexing orchestrator (ADR-0008 R1 amendment).
 *
 * Called from posttooluse.mjs for every tool result. Indexes the on-disk
 * file behind a large full-file Read into the per-project ContentStore
 * (label = resolved absolute path — the ctx_index convention, so the
 * existing content-hash staleness + label dedup apply as-is) and records a
 * read-guard sidecar entry for the main conversation.
 *
 * R1 is Read-only: Bash output indexing was deferred (secret persistence —
 * see the ADR-0008 amendment). Every gate fails open: skip, never throw.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalKey, capExceeded, fileIdOf, readState, recordFullRead, recordVolume,
  MAX_INDEX_FILE_BYTES,
} from "./readstate.mjs";

export const INDEX_MIN_RESPONSE_BYTES = 4096;
// ponytail: coarse project-wide source ceiling so passive indexing cannot
// grow the refresh scan unbounded; raise if real projects hit it.
export const GLOBAL_MAX_SOURCES = 800;

const READ_TOOL_NAMES = new Set(["Read", "read_file", "fs_read", "view_file", "view"]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar", ".exe", ".dll", ".so",
  ".dylib", ".node", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".avi", ".mov", ".wasm", ".class", ".jar",
  ".db", ".sqlite", ".bin",
]);

// Built-in floor under the user-configurable Read deny patterns: never
// persist likely credentials, even when the Read itself was permitted.
const SENSITIVE_BASENAME_RES = [
  /^\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|keychain)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /credential/i,
  /secret/i,
];

export function extractResponseText(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  if (toolResponse && typeof toolResponse === "object") {
    if (typeof toolResponse.text === "string") return toolResponse.text;
    if (toolResponse.file && typeof toolResponse.file.content === "string") return toolResponse.file.content;
    if (Array.isArray(toolResponse)) {
      return toolResponse.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
    }
    try { return JSON.stringify(toolResponse); } catch { return ""; }
  }
  return "";
}

function getReadFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.path === "string") return toolInput.path;
  return "";
}

function isSensitiveBasename(name) {
  return SENSITIVE_BASENAME_RES.some((re) => re.test(name));
}

async function defaultDeps(hookDir) {
  const dir = hookDir ?? dirname(new URL(import.meta.url).pathname);
  const { createSessionLoaders } = await import("../session-loaders.mjs");
  const loaders = createSessionLoaders(dir);
  const dbMod = await loaders.loadSessionDB();
  const storeMod = await loaders.loadStore();
  const securityMod = await loaders.loadSecurity();
  const { getSessionDBPath } = await import("../session-helpers.mjs");
  return {
    openStore(projectDir) {
      const sessionsDir = dirname(getSessionDBPath());
      const contentDir = dbMod.ensureWritableStorageDir(dbMod.resolveContentStorageDir(() => sessionsDir));
      const dbPath = dbMod.resolveContentStorePath({ projectDir, contentDir });
      return { store: new storeMod.ContentStore(dbPath), dbPath };
    },
    security: {
      readToolDenyPatterns: securityMod.readToolDenyPatterns,
      evaluateFilePath: securityMod.evaluateFilePath,
    },
  };
}

/**
 * Index a qualifying full-file Read result; never throws.
 * Returns null when the input is out of scope, otherwise a small
 * diagnostics object: { indexed, recorded, skipped? }.
 */
export async function maybeIndexToolResult({ input, projectDir, sessionId, hookDir, deps }) {
  try {
    if (process.env.CONTEXT_MODE_TOOL_INDEX === "0") return null;
    const toolName = String(input?.tool_name ?? "");
    if (!READ_TOOL_NAMES.has(toolName)) return null;

    const toolInput = input?.tool_input ?? {};
    const rawPath = getReadFilePath(toolInput);
    if (!rawPath || !projectDir || !sessionId) return null;

    if (toolInput.offset != null || toolInput.limit != null) {
      return { indexed: false, recorded: false, skipped: "windowed" };
    }

    const text = extractResponseText(input?.tool_response);
    if (Buffer.byteLength(text, "utf8") <= INDEX_MIN_RESPONSE_BYTES) {
      return { indexed: false, recorded: false, skipped: "small" };
    }

    const abs = resolve(String(rawPath));
    const st = statSync(abs);
    if (!st.isFile()) return { indexed: false, recorded: false, skipped: "not-a-file" };
    if (st.size > MAX_INDEX_FILE_BYTES) {
      return { indexed: false, recorded: false, skipped: "too-large" };
    }
    // Containment/sensitivity checks run on the lexical path AND the real
    // path: a symlink with an innocent in-project name can point at an
    // external credential file — readFileSync/store.index follow the target,
    // so the gates must too.
    let real = abs;
    try { real = realpathSync(abs); } catch { return { indexed: false, recorded: false, skipped: "unreadable" }; }
    const projectKey = canonicalKey(projectDir) + "/";
    for (const candidate of real === abs ? [abs] : [abs, real]) {
      if (!canonicalKey(candidate).startsWith(projectKey)) {
        return { indexed: false, recorded: false, skipped: "outside-project" };
      }
      if (isSensitiveBasename(basename(candidate))) {
        return { indexed: false, recorded: false, skipped: "sensitive" };
      }
      if (BINARY_EXTS.has(extname(candidate).toLowerCase())) {
        return { indexed: false, recorded: false, skipped: "binary" };
      }
    }
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) {
      return { indexed: false, recorded: false, skipped: "binary" };
    }

    const d = deps ?? await defaultDeps(hookDir);
    const denyGlobs = d.security.readToolDenyPatterns("Read", projectDir);
    if (d.security.evaluateFilePath(abs, denyGlobs, undefined, projectDir).denied) {
      return { indexed: false, recorded: false, skipped: "denied" };
    }

    const sha = createHash("sha256").update(buf).digest("hex");
    const mainConversation = input?.agent_id == null && input?.agent_type == null;
    const { store, dbPath } = d.openStore(projectDir);
    try {
      const meta = store.getSourceMeta(abs);
      const sameHash = meta != null && meta.contentHash === sha;
      let indexed = false;
      let skipped;

      if (sameHash) {
        skipped = "same-hash";
      } else if (meta == null && store.listSources().length >= GLOBAL_MAX_SOURCES) {
        return { indexed: false, recorded: false, skipped: "global-cap" };
      } else if (capExceeded(readState(sessionId), st.size)) {
        return { indexed: false, recorded: false, skipped: "session-cap" };
      } else {
        store.index({ path: abs, attribution: { sessionId } });
        indexed = true;
      }

      let recorded = false;
      if (indexed && !mainConversation) {
        // Subagent volume still consumes the session byte budget (no entry).
        recordVolume(sessionId, st.size);
      }
      if (mainConversation && (indexed || sameHash)) {
        recordFullRead(sessionId, abs, {
          hash: sha,
          size: st.size,
          mtimeMs: st.mtimeMs,
          dbPath,
          dbFileId: fileIdOf(dbPath),
        });
        recorded = true;
      }
      return skipped ? { indexed, recorded, skipped } : { indexed, recorded };
    } finally {
      try { store.close(); } catch { /* best-effort */ }
    }
  } catch {
    return null;
  }
}
