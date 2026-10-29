import { DatabaseSync } from "node:sqlite";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { ensureLibrary, openInReader, returnToLibrary, textOf } from "./helpers.js";

/**
 * Reading-progress migration E2E (docs/TESTING.md): stored progress is
 * user data that must survive the engine migration (foliate → Readium,
 * docs/EPUB.md). This suite seeds the scratch database with
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
 * are pinned by the Rust-level progress-migration fixtures (docs/EPUB.md,
 * `sidecar/tests`), which run the full corpus per `cargo test`.
 */

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

/**
 * Playwright retries relaunch the worker, which launches a fresh app against
 * the same scratch database and re-imports the seeded library asynchronously.
 * Reading the DB immediately after that relaunch can beat the import, so wait
 * for the seeded rows instead of failing the whole suite.
 */
async function bookUidByTitle(db: DatabaseSync, title: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const row = db.prepare("SELECT book_uid FROM books WHERE title = ?").get(title) as
        | { book_uid: string }
        | undefined;
      if (row) return row.book_uid;
    } catch (error) {
      // The app may have created the SQLite file but not the schema yet.
      if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`fixture book "${title}" not found in the scratch database`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Insert a progress row shaped like the previous app's writes. */
function seedProgress(
  db: DatabaseSync,
  bookUid: string,
  row: {
    cfi: string | null;
    chapterHref: string | null;
    pageNumber: number | null;
    percent: number;
  },
): void {
  db.prepare(
    `INSERT INTO reading_progress
       (book_uid, chapter_href, cfi, character_offset, page_number, scroll_offset, progress_percent,
        locator, progression, locations, engine, schema_version)
     VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT(book_uid) DO UPDATE SET
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
  ).run(bookUid, row.chapterHref, row.cfi, row.pageNumber, row.percent);
}

/** Waits until the EPUB engine reports ready and the given spine section. */
async function waitForEpubSection(page: Page, section: string): Promise<void> {
  const host = page.locator("div[data-epub-host]");
  await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
  await expect(host).toHaveAttribute("data-epub-section", section, { timeout: 30000 });
}

test.describe("tuxbooks reading-progress migration (foliate rows)", () => {
  let db: DatabaseSync;
  let epubUid = "";
  let pdfUid = "";

  test.beforeAll(() => {
    db = scratchDatabase();
  });

  // A Playwright retry relaunches the worker and the app. Wait for the
  // library view to trigger the seeded import, then for the rows it writes.
  test.beforeEach(async ({ page }) => {
    await ensureLibrary(page);
    epubUid = await bookUidByTitle(db, EPUB_TITLE);
    pdfUid = await bookUidByTitle(db, PDF_TITLE);
  });

  test("restores the beginning of the book from an old foliate row", async ({ page }) => {
    seedProgress(db, epubUid, {
      cfi: OLD_FOLIATE_CFI.beginning,
      chapterHref: "chapter1.xhtml",
      pageNumber: null,
      percent: 0,
    });
    await openInReader(page, `${EPUB_TITLE} (EPUB)`);
    await waitForEpubSection(page, "0");
    expect(parseInt(await textOf(page, "reader-position"), 10)).toBeLessThan(60);
    await returnToLibrary(page);
  });

  test("restores a chapter boundary (section start) from an old foliate row", async ({ page }) => {
    seedProgress(db, epubUid, {
      cfi: OLD_FOLIATE_CFI.chapterTwo,
      chapterHref: "chapter2.xhtml",
      pageNumber: null,
      percent: 40,
    });
    await openInReader(page, `${EPUB_TITLE} (EPUB)`);
    await waitForEpubSection(page, "1");
    await returnToLibrary(page);
  });

  test("restores a late-book position from an old foliate row", async ({ page }) => {
    seedProgress(db, epubUid, {
      cfi: OLD_FOLIATE_CFI.chapterThree,
      chapterHref: "chapter3.xhtml",
      pageNumber: null,
      percent: 92,
    });
    await openInReader(page, `${EPUB_TITLE} (EPUB)`);
    await waitForEpubSection(page, "2");
    await returnToLibrary(page);
  });

  test("degrades a stale foliate row to the beginning without crashing", async ({ page }) => {
    // A CFI pointing at a nonexistent spine entry plus a chapter href that
    // matches no spine item: every locator tier of the migration adapter's
    // fallback hierarchy (docs/EPUB.md) fails validation against the actual
    // EPUB. A locator-bearing row never falls back to its stale percentage
    // — that would silently jump into a different file — so the adapter
    // degrades to the beginning (section 0), and the reader stays usable.
    seedProgress(db, epubUid, {
      cfi: "epubcfi(/6/999!/4/2/1:0)",
      chapterHref: "gone.xhtml",
      pageNumber: null,
      percent: 50,
    });
    await openInReader(page, `${EPUB_TITLE} (EPUB)`);
    await waitForEpubSection(page, "0");
    // A real position change (page turn) flushes the debounced save and
    // lands the migration markers: the converted row carries the Readium
    // locator + engine/schema markers while the original foliate locator
    // survives as provenance (docs/EPUB.md).
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1500);
    const migrated = db
      .prepare(
        "SELECT engine, schema_version, locator, cfi, chapter_href FROM reading_progress WHERE book_uid = ?",
      )
      .get(epubUid) as {
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
    await returnToLibrary(page);
  });

  test("restores the PDF page from an old page-number row", async ({ page }) => {
    seedProgress(db, pdfUid, {
      cfi: null,
      chapterHref: null,
      pageNumber: 3,
      percent: 100,
    });
    await openInReader(page, `${PDF_TITLE} (PDF)`);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 3 of 3", {
      timeout: 30000,
    });
    await returnToLibrary(page);
  });

  test.afterAll(() => {
    if (db === undefined || !epubUid || !pdfUid) return;
    // Clean up this suite's DB writes so later specs in the phase see the
    // state they expect (no spec may assume fresh state, but leaving seeded
    // rows behind would spread restore side effects across every reader).
    try {
      db.prepare("DELETE FROM reading_progress WHERE book_uid = ? OR book_uid = ?").run(
        epubUid,
        pdfUid,
      );
    } catch {
      // beforeAll failed before the scratch schema existed; nothing to clean.
    } finally {
      db.close();
    }
  });
});
