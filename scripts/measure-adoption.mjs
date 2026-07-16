#!/usr/bin/env node
// measure-adoption.mjs — era-safe ctxscribe adoption measurement over Claude Code transcripts.
//
// Methodology mirrors memory/ctxscribe-baseline-era-mixing.md ("the denominator of a rate must
// be drawn only from the period in which the measured object existed; apply one convention to
// every row"). Era assignment is by SESSION START ("a session carries the plugin build it booted
// with"), so a session is in-window iff its FIRST timestamp ∈ [--since, --until); all of its
// events (including subagent transcripts, which share the parent sessionId) then count.
//
// Definitions the memory file does not pin down are defined HERE (explicitly author-defined):
//   * context  = one context window: one transcript file (a main-session .jsonl or one
//                subagents/agent-*.jsonl) containing >=1 tool_use, PLUS one extra unit per
//                compact_boundary inside it (compaction resets the window). Calibrated: the
//                memory's N=69 = 67 in-window files + 2 in-window compaction boundaries.
//   * missed   = bytes that entered a context window but plausibly carried no durable value:
//                  Read results whose file_path is NOT the target of a later Edit/Write/
//                  NotebookEdit in the same session ("exploratory read"; a within-10-turns
//                  variant is also reported)
//                + Bash results > 2 KiB + Grep results > 2 KiB (dump-sized outputs).
//                missed share = missed bytes / ALL tool_result bytes.
//   * bytes    = UTF-8 Buffer.byteLength of tool_result string content, or the sum over
//                array items with type 'text'. (JS .length undercounts ~12% on this corpus.)
//   * adoption = strict-plugin ctx_* tool_use calls / all tool_use calls (call basis), plus a
//                byte-share variant. Read byte share denominator EXCLUDES ctx_* bytes
//                (calibrated against the memory's 75.5%).
//
// Exclusions (fixed):
//   1. sessions with any observed cwd matching /context-mode|ctxscribe/i (self-referential)
//   2. session 7e4e550a-d0bb-49fd-915d-69dac939b67c and its subagent/sidechain transcripts
//      (the verification session that ordered ctx_* usage — circular; subagents share its
//      sessionId, so the sessionId match covers them)
//   3. --cut sessions (default, era-safe, per task spec): sessions whose FIRST timestamp
//      < --since or >= --until are dropped whole (a session carries the plugin build it
//      booted with; covers subagents of pre-era parents via the shared sessionId).
//      --cut events (memory-compatible): counts individual tool_use events with timestamp in
//      [--since, --until) from non-excluded sessions regardless of boot time. NOT era-safe
//      for numerators when plugin generations overlap; exists to reproduce ERA-2 arithmetic.
//
// CLI:  node measure-adoption.mjs [--since ISO] [--until ISO] [--min-contexts N] [--cut sessions|events] [--debug]
//   --since         default 2026-07-16T12:26:17.365Z (v1.0.7 install time)
//   --until         optional exclusive upper bound
//   --min-contexts  default 60; WARN-ONLY sample-size floor
//
// CALIBRATION VERDICT (ERA-2, --since 2026-07-13T14:46:40Z --until 2026-07-16T12:26:17Z):
// The memory file's own rows come from two DIFFERENT cuts (the era-mixing failure mode it
// warns about, in miniature). Every component reproduces exactly, but under different cuts:
//   * adoption 3.82%  = 88 / 2,306: numerator is EVENT-cut (in-window strict ctx_* calls;
//     --cut events reports exactly 88), denominator is SESSION-cut organic calls (2,306;
//     --cut sessions reports exactly 2,306). Pure cuts bracket it: events 3.67%, sessions 4.94%.
//   * Read byte share 75.5% -> --cut sessions: 75.52% (Δ0.02pt) with non-ctx denominator.
//   * missed ≈54%     -> --cut sessions: 55.07% (Δ1.1pt) under the any-later-edit definition.
//   * N≈69 contexts   -> --cut events: 67 files + 2 compaction boundaries = 69 (exact).
//   * overall row 285/3,634 (7.84%) -> strict-name, session-cut, cwd-included: 285/3,635.

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');
const EXCLUDED_SESSION = '7e4e550a-d0bb-49fd-915d-69dac939b67c';
const CWD_RE = /context-mode|ctxscribe/i;
// Numerator counts ONLY the installed plugin's tools (strict prefix). ERA-2 calibration proved
// the memory file uses this convention: 26 ctx_*-shaped calls from other registrations existed
// in the organic window and are NOT counted (they are reported separately under --debug).
const CTX_RE = /^mcp__plugin_ctxscribe_mcp__ctx_[a-z_]+$/;
const CTX_ANY_RE = /^mcp__.*__ctx_[a-z_]+$/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const BIG = 2 * 1024;
const MB = 1024 * 1024;

// ---- CLI ----
const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
const sinceStr = opt('since', '2026-07-16T12:26:17.365Z');
const untilStr = opt('until', null);
const minContexts = Number(opt('min-contexts', '60'));
const cut = opt('cut', 'sessions'); // 'sessions' (era-safe, default) | 'events' (memory-compatible)
const sinceMs = Date.parse(sinceStr);
const untilMs = untilStr ? Date.parse(untilStr) : Infinity;
if (Number.isNaN(sinceMs) || (untilStr && Number.isNaN(untilMs)) || !['sessions', 'events'].includes(cut)) {
  console.error('invalid --since/--until/--cut'); process.exit(1);
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}
const norm = p => (p || '').replace(/\\/g, '/').toLowerCase();
const resultBytes = it => {
  if (typeof it.content === 'string') return Buffer.byteLength(it.content, 'utf8');
  let b = 0;
  if (Array.isArray(it.content)) for (const x of it.content) {
    if (x && x.type === 'text' && typeof x.text === 'string') b += Buffer.byteLength(x.text, 'utf8');
  }
  return b;
};

// sess -> record
const S = new Map();
function sessRec(sess) {
  let s = S.get(sess);
  if (!s) {
    s = { firstMs: Infinity, cwdHit: false, ctxFiles: new Set(), msgFiles: new Set(), calls: 0,
          ctxCalls: 0, ctxAnyCalls: 0, bytes: 0, ctxBytes: 0, readBytes: 0, bashBig: 0,
          grepBig: 0, reads: [], edits: [], turnTs: [],
          compactAll: 0, compactWin: 0,
          // in-window (event-cut) counters
          wCalls: 0, wCtxCalls: 0, wBytes: 0, wCtxBytes: 0, wReadBytes: 0, wBashBig: 0, wGrepBig: 0, wFiles: new Set() };
    S.set(sess, s);
  }
  return s;
}

let seq = 0;
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).split(path.sep);
  let fileSess = null;
  const m = f.replace(/\\/g, '/').match(/([0-9a-f-]{36})\/subagents\//);
  if (m) fileSess = m[1];
  else if (/^[0-9a-f-]{36}\.jsonl$/.test(rel[rel.length - 1])) fileSess = rel[rel.length - 1].slice(0, 36);

  // Cheap era pre-filter: a file whose mtime < since holds no in-window events, but its first
  // timestamp must still be harvested so a straggler subagent file cannot re-date the session.
  if (fs.statSync(f).mtimeMs < sinceMs) {
    if (!fileSess) continue;
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const mm = buf.toString('utf8', 0, n).match(/"timestamp"\s*:\s*"([^"]+)"/);
      if (mm) {
        const ms = Date.parse(mm[1]);
        const s = sessRec(fileSess);
        if (!Number.isNaN(ms) && ms < s.firstMs) s.firstMs = ms;
      }
    } catch { /* unreadable: ignore */ }
    continue;
  }

  const idMap = new Map();
  let lastMid = null, lastTs = '';
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const sess = o.sessionId || fileSess;
    if (!sess) continue;
    const s = sessRec(sess);
    const ts = o.timestamp || lastTs; if (o.timestamp) lastTs = o.timestamp;
    if (o.timestamp) { const ms = Date.parse(o.timestamp); if (!Number.isNaN(ms) && ms < s.firstMs) s.firstMs = ms; }
    if (o.cwd && CWD_RE.test(o.cwd)) s.cwdHit = true;
    if (o.subtype === 'compact_boundary') {
      s.compactAll++;
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms) && ms >= sinceMs && ms < untilMs) s.compactWin++;
    }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    if (o.type === 'assistant') {
      s.msgFiles.add(f);
      const mid = o.message?.id || o.uuid;
      if (mid !== lastMid) { lastMid = mid; s.turnTs.push(ts); }
      for (const it of c) {
        if (it.type !== 'tool_use' || idMap.has(it.id)) continue;
        const ms = Date.parse(ts);
        const inWin = !Number.isNaN(ms) && ms >= sinceMs && ms < untilMs;
        s.calls++;
        s.ctxFiles.add(f);
        if (inWin) { s.wCalls++; s.wFiles.add(f); }
        const isCtx = CTX_RE.test(it.name);
        if (isCtx) { s.ctxCalls++; if (inWin) s.wCtxCalls++; }
        if (CTX_ANY_RE.test(it.name)) { s.ctxAnyCalls++; if (!isCtx) (s.ctxOther ??= {})[it.name] = ((s.ctxOther ??= {})[it.name] || 0) + 1; }
        const rec = { name: it.name, isCtx, inWin, b: 0 };
        idMap.set(it.id, rec);
        const pos = seq++;
        if (it.name === 'Read') s.reads.push({ path: norm(it.input?.file_path), pos, rec, ts });
        else if (EDIT_TOOLS.has(it.name)) s.edits.push({ path: norm(it.name === 'NotebookEdit' ? it.input?.notebook_path : it.input?.file_path), pos, ts, inWin });
      }
    } else if (o.type === 'user') {
      for (const it of c) {
        if (it.type !== 'tool_result') continue;
        const rec = idMap.get(it.tool_use_id);
        if (!rec || rec.done) continue;
        rec.done = 1;
        const b = resultBytes(it);
        rec.b = b;
        s.bytes += b;
        if (rec.isCtx) s.ctxBytes += b;
        if (rec.name === 'Read') s.readBytes += b;
        else if (rec.name === 'Bash' && b > BIG) s.bashBig += b;
        else if (rec.name === 'Grep' && b > BIG) s.grepBig += b;
        if (rec.inWin) {
          s.wBytes += b;
          if (rec.isCtx) s.wCtxBytes += b;
          if (rec.name === 'Read') s.wReadBytes += b;
          else if (rec.name === 'Bash' && b > BIG) s.wBashBig += b;
          else if (rec.name === 'Grep' && b > BIG) s.wGrepBig += b;
        }
      }
    }
  }
}

// ---- filter sessions & aggregate ----
const tot = { sessions: 0, contexts: 0, msgContexts: 0, calls: 0, ctxCalls: 0, ctxAnyCalls: 0,
              bytes: 0, ctxBytes: 0, readBytes: 0, explAny: 0, explW10: 0, bashBig: 0, grepBig: 0 };
const excl = { era: 0, cwd: 0, verification: 0, empty: 0 };
const ctxOtherNames = {};
const later = (a, b) => b.ts > a.ts || (b.ts === a.ts && b.pos > a.pos); // b after a
const evCut = cut === 'events';
for (const [sess, s] of S) {
  if (sess === EXCLUDED_SESSION) { excl.verification++; continue; }
  if (evCut) {
    if (s.cwdHit) { excl.cwd++; continue; }
    if (s.wCalls === 0) { excl.era++; continue; } // no in-window activity
  } else {
    if (!(s.firstMs >= sinceMs && s.firstMs < untilMs)) { excl.era++; continue; }
    if (s.cwdHit) { excl.cwd++; continue; }
    if (s.calls === 0) { excl.empty++; continue; }
  }
  // exploratory reads, two defs: (any) no later same-path Edit/Write in this session;
  // (w10) no such edit within the next 10 assistant turns. Ordering by (timestamp, capture pos).
  // In event cut, only in-window reads count and only in-window edits qualify as followers
  // (approximates a transcript snapshot taken at --until).
  s.turnTs.sort();
  const turnIdx = ts => { let lo = 0, hi = s.turnTs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s.turnTs[m] <= ts) lo = m + 1; else hi = m; } return lo; };
  const byPath = new Map();
  for (const e of s.edits) {
    if (!e.path || (evCut && !e.inWin)) continue;
    let a = byPath.get(e.path); if (!a) { a = []; byPath.set(e.path, a); } a.push(e);
  }
  for (const r of s.reads) {
    if (evCut && !r.rec.inWin) continue;
    const arr = r.path ? byPath.get(r.path) : undefined;
    let any = 0, w10 = 0;
    if (arr) {
      const rT = turnIdx(r.ts);
      for (const e of arr) {
        if (!later(r, e)) continue;
        any = 1;
        if (turnIdx(e.ts) - rT <= 10) { w10 = 1; break; }
      }
    }
    if (!any) tot.explAny += r.rec.b;
    if (!w10) tot.explW10 += r.rec.b;
  }
  if (s.ctxOther) for (const [n, c] of Object.entries(s.ctxOther)) ctxOtherNames[n] = (ctxOtherNames[n] || 0) + c;
  tot.sessions++;
  if (evCut) {
    tot.contexts += s.wFiles.size + s.compactWin;
    tot.msgContexts += s.wFiles.size;
    tot.calls += s.wCalls; tot.ctxCalls += s.wCtxCalls; tot.ctxAnyCalls += s.ctxAnyCalls;
    tot.bytes += s.wBytes; tot.ctxBytes += s.wCtxBytes;
    tot.readBytes += s.wReadBytes; tot.bashBig += s.wBashBig; tot.grepBig += s.wGrepBig;
  } else {
    tot.contexts += s.ctxFiles.size + s.compactAll;
    tot.msgContexts += s.msgFiles.size;
    tot.calls += s.calls; tot.ctxCalls += s.ctxCalls; tot.ctxAnyCalls += s.ctxAnyCalls;
    tot.bytes += s.bytes; tot.ctxBytes += s.ctxBytes;
    tot.readBytes += s.readBytes; tot.bashBig += s.bashBig; tot.grepBig += s.grepBig;
  }
}

if (argv.includes('--debug')) {
  const rows = [];
  for (const [sess, s] of S) {
    const inEra = s.firstMs >= sinceMs && s.firstMs < untilMs;
    if (!inEra && s.wCalls === 0) continue;
    rows.push({
      sess: sess.slice(0, 8),
      first: Number.isFinite(s.firstMs) ? new Date(s.firstMs).toISOString().slice(5, 16) : '?',
      cwdHit: s.cwdHit ? 1 : 0,
      verif: sess === EXCLUDED_SESSION ? 1 : 0,
      files: s.ctxFiles.size, wFiles: s.wFiles.size,
      calls: s.calls, ctx: s.ctxCalls, wCalls: s.wCalls, wCtx: s.wCtxCalls,
      readMB: +(s.readBytes / MB).toFixed(2), MB: +(s.bytes / MB).toFixed(2), wMB: +(s.wBytes / MB).toFixed(2),
    });
  }
  rows.sort((a, b) => a.first < b.first ? -1 : 1);
  console.error('in-era sessions (pre-exclusion):');
  for (const r of rows) console.error(JSON.stringify(r));
}

const pct = (a, b) => b ? +(100 * a / b).toFixed(2) : 0;
// Read byte share denominator EXCLUDES ctx_* result bytes (calibrated: reproduces the memory
// file's 75.5% on ERA-2; with ctx bytes in the denominator it is 70.4%).
const nonCtxBytes = tot.bytes - tot.ctxBytes;
const missedBytes = tot.explAny + tot.bashBig + tot.grepBig;       // primary (any-later-edit def)
const missedBytesW10 = tot.explW10 + tot.bashBig + tot.grepBig;    // variant (10-turn def)
const out = {
  window: { since: sinceStr, until: untilStr || '(open)', cut },
  sessions: { included: tot.sessions, excluded: excl },
  contexts: tot.contexts,
  contextsFilesOnly: tot.msgContexts,
  sampleWarning: tot.contexts < minContexts ? `N=${tot.contexts} < --min-contexts ${minContexts}: sample too small, treat as indicative only` : null,
  adoption: {
    callBasis: { ctxCalls: tot.ctxCalls, allCalls: tot.calls, pct: pct(tot.ctxCalls, tot.calls) },
    byteBasis: { ctxMB: +(tot.ctxBytes / MB).toFixed(2), allMB: +(tot.bytes / MB).toFixed(2), pct: pct(tot.ctxBytes, tot.bytes) },
    ctxShapedCallsFromOtherRegistrations: tot.ctxAnyCalls - tot.ctxCalls,
  },
  readByteShare: { readMB: +(tot.readBytes / MB).toFixed(2), nonCtxMB: +(nonCtxBytes / MB).toFixed(2), pct: pct(tot.readBytes, nonCtxBytes), pctOfTotal: pct(tot.readBytes, tot.bytes) },
  missed: {
    exploratoryReadMB_anyLaterEditDef: +(tot.explAny / MB).toFixed(2),
    exploratoryReadMB_within10TurnsDef: +(tot.explW10 / MB).toFixed(2),
    bashOver2KBMB: +(tot.bashBig / MB).toFixed(2),
    grepOver2KBMB: +(tot.grepBig / MB).toFixed(2),
    totalMB: +(missedBytes / MB).toFixed(2),
    pct: pct(missedBytes, tot.bytes),
    pctW10Variant: pct(missedBytesW10, tot.bytes),
  },
};
console.log(JSON.stringify(out, null, 1));
if (argv.includes('--debug') && Object.keys(ctxOtherNames).length) console.error('ctx-shaped non-plugin tools: ' + JSON.stringify(ctxOtherNames));
if (out.sampleWarning) console.error('WARN: ' + out.sampleWarning);
