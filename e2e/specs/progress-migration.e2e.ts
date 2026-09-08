import { DatabaseSync } from "node:sqlite";

import { openInReader, returnToLibrary, textOf } from "./helpers.js";

/**
 * Reading-progress migration E2E (docs/testing.md): stored progress is
 * user data that must survive the engine migration (foliate → Readium,
 * docs/electron-migration.md). This suite seeds the scratch database with
 * progress rows in the format the previous (foliate/WebKitGTK) app wrote —
 * a canonical CFI plus chapter href and coarse percent — and asserts the
 * reader restores the SAME LOGICAL LOCATION (spine section), never a page
 * number: the pagination may legitimately change between engines.
 *
 * The CFIs below were captured from the foliate engine on the deterministic
 `minimal.epub` fixture (byte-identical across runs, `scripts/
 * make-fixture.py`), so they are exactly what the old app persisted for
 * these locations. If foliate's CFI format ever changes such that old rows
 * stop resolving, this suite must fail — that is the regression it guards.
 *
 * Coverage here is the E2E slice: beginning, chapter boundary, late book,
 * stale/invalid rows, and the PDF page row. Mid-chapter offsets and the
 * several EPUB structures (varied spines, fixed layout, malformed corpora)
 * are pinned by the Rust-level progress-migration fixtures (docs/epub.md,
 * `src-tauri/tests`), which run the full corpus per `cargo test`.
 */

interface SeededBook {
  id: number;
  title: string;
}

/** Captured foliate CFIs for minimal.epub (see file comment). */
const OLD_FOLIATE_CFI = {
  beginning: "epubcfi(/6/2!/4,/2,/6/1:89)",
  chapterTwo: "epubcfi(/6/4!/4,/2,/6/1:62)",
  chapterThree: "epubcfi(/6/6!/4,/2,/8/1:73)",
} as const;

const EPUB_TITLE = "A Minimal Book";
const PDF_TITLE = "A Minimal Manual";

function scratchDatabase(): DatabaseSync {
  const databasePath = process.env.TEST_DATABASE_PATH;
  if (!databasePath || !databasePath.includes("tuxbooks-e2e-")) {
    throw new Error(
      "TEST_DATABASE_PATH must point at this run's scratch dir — refusing to touch anything else",
    );
  }
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function bookIdByTitle(db: DatabaseSync, title: string): number {
  const row = db.prepare("SELECT id FROM books WHERE title = ?").get(title) as
    { id: number } | undefined;
  if (!row) throw new Error(`fixture book "${title}" not found in the scratch database`);
  return row.id;
}

/** Insert a progress row shaped like the previous app's writes. */
function seedProgress(
  db: DatabaseSync,
  bookId: number,
  row: {
    cfi: string | null;
    chapterHref: string | null;
    pageNumber: number | null;
    percent: number;
  },
): void {
  db.prepare(
    `INSERT INTO reading_progress
       (book_id, chapter_href, cfi, character_offset, page_number, scroll_offset, progress_percent,
        locator, progression, locations, engine, schema_version)
     VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT(book_id) DO UPDATE SET
       chapter_href = excluded.chapter_href,
       cfi = excluded.cfi,
       page_number = excluded.page_number,
       progress_percent = excluded.progress_percent,
       locator = NULL,
       progression = NULL,
       locations = NULL,
       engine = NULL,
       schema_version = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(bookId, row.chapterHref, row.cfi, row.pageNumber, row.percent);
}

describe("tuxbooks reading-progress migration (foliate rows)", () => {
  let db: DatabaseSync;
  let epubId: number;
  let pdfId: number;

  before(() => {
    db = scratchDatabase();
    epubId = bookIdByTitle(db, EPUB_TITLE);
    pdfId = bookIdByTitle(db, PDF_TITLE);
  });

  it("restores the beginning of the book from an old foliate row", async () => {
    seedProgress(db, epubId, {
      cfi: OLD_FOLIATE_CFI.beginning,
      chapterHref: "chapter1.xhtml",
      pageNumber: null,
      percent: 0,
    });
    await openInReader(`${EPUB_TITLE} (EPUB)`);
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30000, timeoutMsg: "epub engine never became ready" },
    );
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-section")) === "0",
      { timeout: 30000, timeoutMsg: "old 'beginning' row never restored to the first section" },
    );
    expect(parseInt(await textOf("reader-position"), 10)).toBeLessThan(60);
    await returnToLibrary();
  });

  it("restores a chapter boundary (section start) from an old foliate row", async () => {
    seedProgress(db, epubId, {
      cfi: OLD_FOLIATE_CFI.chapterTwo,
      chapterHref: "chapter2.xhtml",
      pageNumber: null,
      percent: 40,
    });
    await openInReader(`${EPUB_TITLE} (EPUB)`);
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30000, timeoutMsg: "epub engine never became ready" },
    );
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-section")) === "1",
      { timeout: 30000, timeoutMsg: "old chapter-two row never restored to section 1" },
    );
    await returnToLibrary();
  });

  it("restores a late-book position from an old foliate row", async () => {
    seedProgress(db, epubId, {
      cfi: OLD_FOLIATE_CFI.chapterThree,
      chapterHref: "chapter3.xhtml",
      pageNumber: null,
      percent: 92,
    });
    await openInReader(`${EPUB_TITLE} (EPUB)`);
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30000, timeoutMsg: "epub engine never became ready" },
    );
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-section")) === "2",
      { timeout: 30000, timeoutMsg: "old chapter-three row never restored to the last section" },
    );
    await returnToLibrary();
  });

  it("degrades a stale foliate row to the beginning without crashing", async () => {
    // A CFI pointing at a nonexistent spine entry plus a chapter href that
    // matches no spine item: every locator tier of the migration adapter's
    // fallback hierarchy (docs/epub.md) fails validation against the actual
    // EPUB. A locator-bearing row never falls back to its stale percentage
    // — that would silently jump into a different file — so the adapter
    // degrades to the beginning (section 0), and the reader stays usable.
    seedProgress(db, epubId, {
      cfi: "epubcfi(/6/999!/4/2/1:0)",
      chapterHref: "gone.xhtml",
      pageNumber: null,
      percent: 50,
    });
    await openInReader(`${EPUB_TITLE} (EPUB)`);
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30000, timeoutMsg: "stale row left the reader in no defined state" },
    );
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-section")) === "0",
      { timeout: 30000, timeoutMsg: "stale row did not degrade to the beginning" },
    );
    // A real position change (page turn) flushes the debounced save and
    // lands the migration markers: the converted row carries the Readium
    // locator + engine/schema markers while the original foliate locator
    // survives as provenance (docs/epub.md).
    await browser.keys("ArrowRight");
    await browser.pause(1500);
    const migrated = db
      .prepare(
        "SELECT engine, schema_version, locator, cfi, chapter_href FROM reading_progress WHERE book_id = ?",
      )
      .get(epubId) as {
      engine: string | null;
      schema_version: number | null;
      locator: string | null;
      cfi: string | null;
      chapter_href: string | null;
    };
    expect(migrated.engine).toBe("readium");
    expect(migrated.schema_version).toBe(2);
    expect(migrated.locator).toContain("chapter");
    // Original data preserved beside the converted locator.
    expect(migrated.cfi).toBe("epubcfi(/6/999!/4/2/1:0)");
    expect(migrated.chapter_href).toBe("gone.xhtml");
    await returnToLibrary();
  });

  it("restores the PDF page from an old page-number row", async () => {
    seedProgress(db, pdfId, {
      cfi: null,
      chapterHref: null,
      pageNumber: 3,
      percent: 100,
    });
    await openInReader(`${PDF_TITLE} (PDF)`);
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 3 of 3", {
      timeout: 30000,
      timeoutMsg: "old PDF page row never restored to page 3",
    });
    await returnToLibrary();
  });

  after(() => {
    // Clean up this suite's DB writes so later specs in the phase see the
    // state they expect (no spec may assume fresh state, but leaving seeded
    // rows behind would spread restore side effects across every reader).
    db.prepare("DELETE FROM reading_progress WHERE book_id = ? OR book_id = ?").run(epubId, pdfId);
    db.close();
  });
});
