/**
 * R1 read-guard sidecar state (ADR-0008 R1 amendment).
 *
 * PostToolUse records each successfully indexed full-file Read here (per
 * session, main conversation only); the PreToolUse Read branch consults it
 * to deny byte-identical full-file re-reads with a recall recipe.
 *
 * Plain node builtins ONLY — PreToolUse must never load native modules
 * (native module load breaks the hook's stdout JSON, see pretooluse.mjs).
 * Every path fails OPEN: any error, mismatch, or ambiguity → allow / no-op.
 */
import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const SESSION_MAX_FILES = 300;
export const SESSION_MAX_BYTES = 25_165_824; // 24 MiB per session
export const STATE_TTL_MS = 48 * 60 * 60 * 1000;
// Files above this are never indexed nor recorded (partial indexing would
// make the deny recipe lie about searchability).
export const MAX_INDEX_FILE_BYTES = 1_048_576;

export function statePath(sessionId) {
  return join(tmpdir(), `ctxscribe-readstate-${sessionId}.json`);
}

/** Sidecar key: resolved, forward-slashed, case-folded on win32. */
export function canonicalKey(filePath) {
  let p = resolve(String(filePath)).replace(/\\/g, "/");
  if (process.platform === "win32") p = p.toLowerCase();
  return p;
}

/**
 * Identity of the content-store db file: recreation (ctx_purge, SessionStart
 * cleanup) changes ino/birthtime, invalidating stale guard records. On exotic
 * filesystems where both read 0 the check degrades to existence-only —
 * documented residual, still fail-open on deletion.
 */
export function fileIdOf(filePath) {
  try {
    const st = statSync(filePath);
    return `${st.ino ?? 0}-${st.birthtimeMs ?? 0}`;
  } catch {
    return null;
  }
}

export function hashFileSha256(filePath, maxBytes = MAX_INDEX_FILE_BYTES) {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

export function readState(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(statePath(sessionId), "utf-8"));
    if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
      return { entries: raw.entries, files: Number(raw.files) || 0, bytes: Number(raw.bytes) || 0 };
    }
  } catch { /* missing or corrupted — fail open with an empty state */ }
  return { entries: {}, files: 0, bytes: 0 };
}

export function capExceeded(state, addBytes) {
  return state.files >= SESSION_MAX_FILES || state.bytes + addBytes > SESSION_MAX_BYTES;
}

function writeState(sessionId, state) {
  const target = statePath(sessionId);
  const tmp = `${target}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf-8");
  // ponytail: temp+rename prevents torn reads; parallel tool calls may still
  // lose an update (last writer wins) — that only leaves the guard unarmed.
  renameSync(tmp, target);
}

export function recordFullRead(sessionId, filePath, meta) {
  try {
    const state = readState(sessionId);
    const key = canonicalKey(filePath);
    const prev = state.entries[key];
    state.entries[key] = {
      hash: meta.hash,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      dbPath: meta.dbPath,
      dbFileId: meta.dbFileId,
      ts: Date.now(),
    };
    if (!prev) state.files += 1;
    // Replace, don't accumulate: a file re-read after an Edit must not burn
    // the session byte budget once per revision.
    state.bytes += (Number(meta.size) || 0) - (prev ? Number(prev.size) || 0 : 0);
    writeState(sessionId, state);
  } catch { /* best-effort — the guard simply stays unarmed */ }
}

/**
 * Count indexed volume without arming the guard — subagent reads must still
 * consume the session byte budget or one subagent could fill the store to
 * the global cap unchecked.
 */
export function recordVolume(sessionId, addBytes) {
  try {
    const state = readState(sessionId);
    state.bytes += Number(addBytes) || 0;
    writeState(sessionId, state);
  } catch { /* best-effort */ }
}

export function lookupEntry(sessionId, filePath) {
  try {
    const entry = readState(sessionId).entries[canonicalKey(filePath)];
    if (!entry) return null;
    if (typeof entry.ts !== "number" || Date.now() - entry.ts > STATE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Deny an exact full-file re-read ONLY when every condition holds (all
 * checked cheaply, non-native): main conversation, no offset/limit, a fresh
 * record exists, the content-store db still has the recorded identity, and
 * size+mtime+sha256 are all unchanged. Anything else → null (allow).
 */
export function evaluateReadGuard({ toolInput, filePath, sessionId, isSubagent }) {
  try {
    if (process.env.CONTEXT_MODE_READ_GUARD === "0") return null;
    if (isSubagent || !sessionId || !filePath) return null;
    const ti = toolInput ?? {};
    if (ti.offset != null || ti.limit != null) return null;
    const entry = lookupEntry(sessionId, filePath);
    if (!entry) return null;
    if (!entry.dbPath || fileIdOf(entry.dbPath) !== entry.dbFileId) return null;
    const st = statSync(filePath);
    if (!st.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) return null;
    if (hashFileSha256(filePath) !== entry.hash) return null;
    const abs = resolve(String(filePath));
    return {
      action: "deny",
      reason:
        `ctxscribe read-guard: ${abs} is unchanged since your full Read earlier this session — ` +
        `its content is already indexed. Recall it with ctx_search(queries: [...], source: "${abs.slice(-120)}") ` +
        `instead of re-reading. To view a specific region (or to re-arm Edit), re-Read with offset/limit. ` +
        `Set CONTEXT_MODE_READ_GUARD=0 to disable this guard.`,
      redirectMeta: {
        tool: "Read",
        type: "read-guard-denied",
        bytesAvoided: st.size,
        commandSummary: String(abs).slice(0, 200),
      },
    };
  } catch {
    return null;
  }
}
