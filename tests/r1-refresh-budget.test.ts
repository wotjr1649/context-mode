/**
 * R1 (ADR-0008 amendment): bounded stale-source refresh.
 *
 * Passive Read indexing multiplies file-backed sources, and
 * searchWithFallback eagerly examined EVERY one before searching — a git
 * checkout touching hundreds of indexed files would stall the next
 * ctx_search behind unbounded re-hash/re-index work. The budget caps the
 * expensive examinations per search; leftovers refresh on later searches.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ContentStore, REFRESH_BUDGET } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "r1-budget-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Backdate every source's indexed_at so mtime(now) counts as stale. */
function backdateSources(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    raw.prepare("UPDATE sources SET indexed_at = '2020-01-01 00:00:00'").run();
  } finally {
    raw.close();
  }
}

describe("R1: bounded stale-source refresh", () => {
  it("re-indexes at most REFRESH_BUDGET changed sources per search, resuming next search", () => {
    const dbPath = join(dir, "budget.db");
    const store = new ContentStore(dbPath);
    const total = REFRESH_BUDGET + 6;
    const files: string[] = [];
    for (let i = 0; i < total; i++) {
      const f = join(dir, `src-${i}.md`);
      writeFileSync(f, `# doc ${i}\n\noriginal content number ${i}\n`, "utf-8");
      store.index({ path: f });
      files.push(f);
    }
    for (const f of files) {
      writeFileSync(f, `# doc changed\n\ncompletely different body for ${f}\n`, "utf-8");
    }
    backdateSources(dbPath);

    store.searchWithFallback("zzznomatch");
    expect(store.lastRefreshCount).toBe(REFRESH_BUDGET);

    store.searchWithFallback("zzznomatch");
    expect(store.lastRefreshCount).toBe(6);

    store.close();
  });

  it("touches indexed_at on same-hash examinations so unchanged files leave the stale set", () => {
    const dbPath = join(dir, "touch.db");
    const store = new ContentStore(dbPath);
    const f = join(dir, "untouched-content.md");
    writeFileSync(f, "# same\n\nsame body\n", "utf-8");
    store.index({ path: f });
    backdateSources(dbPath); // stale by timestamp, content unchanged

    store.searchWithFallback("zzznomatch");
    expect(store.lastRefreshCount).toBe(0); // hash matched — no re-index

    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw.prepare("SELECT indexed_at FROM sources").get() as { indexed_at: string };
      expect(row.indexed_at).not.toBe("2020-01-01 00:00:00"); // left the stale set
    } finally {
      raw.close();
    }
    store.close();
  });
});
