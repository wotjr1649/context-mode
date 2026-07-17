/**
 * R1/R3 read guards and sidecar state (ADR-0008 amendments).
 *
 * R1: PostToolUse records each successfully indexed full-file Read here (per
 * session, main conversation only); the PreToolUse Read branch consults it
 * to deny byte-identical full-file re-reads with a recall recipe.
 * R3: stateless large-read guard — a full Read of a text file too large for
 * R1 to index (> MAX_INDEX_FILE_BYTES) is denied with an execute_file /
 * windowed recipe (evaluated after R1 in the Read branch).
 *
 * Plain node builtins ONLY — PreToolUse must never load native modules
 * (native module load breaks the hook's stdout JSON, see pretooluse.mjs).
 * Every path fails OPEN: any error, mismatch, or ambiguity → allow / no-op.
 */
import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, extname } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const SESSION_MAX_FILES = 300;
export const SESSION_MAX_BYTES = 25_165_824; // 24 MiB per session
export const STATE_TTL_MS = 48 * 60 * 60 * 1000;
// Files above this are never indexed nor recorded (partial indexing would
// make the deny recipe lie about searchability).
export const MAX_INDEX_FILE_BYTES = 1_048_576;

// ─── ADR-0008 R3 large-read guard ───
// R3 denies full-file Reads of exactly the band R1 can never index: a
// > 1 MiB payload (≈ 269K tok at 3.9 B/tok) exceeds any usable context
// window, and no FTS5 recall exists up there to regress. Lower this only
// with a raw-source recall path for denied files (see ADR-0008 R3).
export const LARGE_READ_GUARD_BYTES = MAX_INDEX_FILE_BYTES;

// Read renders these visually (images/PDF) or as structured cells (ipynb) —
// no ctx tool substitutes for that, so the large-read guard lets them
// through. Deliberately narrower than toolindex BINARY_EXTS: an archive or
// executable full Read SHOULD be denied (ctx_execute_file analyzes those).
const VISUAL_READ_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".ipynb",
]);

/** The single definition of "windowed" shared by both Read guards. */
export function isWindowedRead(toolInput) {
  const ti = toolInput ?? {};
  return ti.offset != null || ti.limit != null;
}

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
    if (isWindowedRead(toolInput)) return null;
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

/**
 * ADR-0008 R3: deny a full-file Read of a text file too large for R1 to
 * index. Stateless — evaluated after the R1 read-guard (an armed re-read
 * keeps R1's ctx_search recipe; overlap is impossible anyway since R1 only
 * arms ≤ MAX_INDEX_FILE_BYTES) and before the 50 KB nudge. `st` comes from
 * the caller's statSync so the Read branch stays at one stat syscall.
 * Anything ambiguous → null (allow); fail open like everything else here.
 */
export function evaluateLargeReadGuard({ toolInput, filePath, st, isSubagent }) {
  try {
    if (process.env.CONTEXT_MODE_LARGE_READ_GUARD === "0") return null;
    if (isSubagent || !filePath) return null;
    if (isWindowedRead(toolInput)) return null;
    if (!st || !st.isFile() || st.size <= LARGE_READ_GUARD_BYTES) return null;
    const abs = resolve(String(filePath));
    if (VISUAL_READ_EXTS.has(extname(abs).toLowerCase())) return null;
    return {
      action: "deny",
      reason:
        `ctxscribe large-read guard: ${abs} is ${Math.round(st.size / 1024)} KB — a full Read would flood the context window. ` +
        `For analysis, call ctx_execute_file(path, language, code) and print only the answer. ` +
        `For editing, Read a window with offset/limit around the target lines — a windowed Read re-arms Edit for the whole file. ` +
        `This file's content is NOT indexed, so do not try ctx_search for it. ` +
        `Set CONTEXT_MODE_LARGE_READ_GUARD=0 to disable this guard.`,
      redirectMeta: {
        tool: "Read",
        type: "large-read-denied",
        bytesAvoided: st.size,
        commandSummary: String(abs).slice(0, 200),
      },
    };
  } catch {
    return null;
  }
}
