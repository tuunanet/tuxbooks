import { expect, test, type Page } from "../fixtures/electron-app.js";

import {
  closeReaderNavigation,
  openReaderTab,
  openInReader,
  openReaderNavigation,
  returnToLibrary,
  scrollToSlot,
  slotStates,
  textOf,
  waitForRendered,
} from "./helpers.js";

/**
 * Persistent reading annotations (milestone 6): PDF highlights created from
 * real text-layer selections, bookmarks on both formats, and notes — each
 * revisited after closing and reopening the book (the reader reloads
 * everything from SQLite, so this exercises the persistence contract end
 * to end).
 */
/**
 * Select page 1's text-layer spans and release the pointer, so the reader
 * captures the selection the same way a mouse drag ends.
 */
async function selectPageOneText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const layer = document.querySelector('[data-pdf-text-layer="1"]');
    const spans = layer ? Array.from(layer.querySelectorAll("span")) : [];
    if (spans.length === 0) return;
    const range = document.createRange();
    range.setStartBefore(spans[0]!);
    range.setEndAfter(spans[spans.length - 1]!);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
}

test.describe("reading annotations", () => {
  test("creates a PDF highlight from a selection, attaches a note, and revisits both after reopen", async ({
    page,
  }) => {
    await openInReader(page, "A Minimal Manual (PDF)");

    // Deterministic anchor: page 1 rendered, with its selectable text layer
    // (the spans render asynchronously after the container mounts). The
    // reader restores the book's saved position before the surface mounts,
    // so wait for the document slots before scrolling — scrollToSlot
    // no-ops while the reader is still loading.
    await expect
      .poll(async () => (await slotStates(page)).length, { timeout: 30000 })
      .toBeGreaterThan(0);
    await scrollToSlot(page, 1);
    await waitForRendered(page, 1, 60000);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const layer = document.querySelector('[data-pdf-text-layer="1"]');
            return layer !== null && layer.querySelectorAll("span").length > 0;
          }),
        { timeout: 30000 },
      )
      .toBe(true);

    // Select the page's text through its text layer and release the pointer,
    // so the reader captures the selection the same way a mouse drag ends.
    await selectPageOneText(page);

    await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("highlight-color-yellow").click();

    // The stored highlight's overlay draws on the page right away (one
    // overlay per selection rectangle — multi-line selections make several).
    await page
      .locator("[data-pdf-highlight]")
      .first()
      .waitFor({ state: "attached", timeout: 10000 });

    // Attach a note through the drawer's Highlights tab.
    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-highlights", "nav-highlight-0");
    await page.getByTestId("nav-highlight-note-0").click();
    await page.getByTestId("annotation-note-input").fill("check this later");
    await page.getByTestId("annotation-note-save").click();
    await expect(page.getByTestId("nav-highlight-0")).toContainText("check this later", {
      timeout: 10000,
    });
    await closeReaderNavigation(page);

    // Bookmark the page as well, then leave; the debounced progress save
    // plus the unmount flush persist everything.
    await page.getByTestId("reader-bookmark").click();
    await expect(page.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "true", {
      timeout: 10000,
    });
    await returnToLibrary(page);

    // Reopen: highlight, note, and bookmark all come back from the database.
    await openInReader(page, "A Minimal Manual (PDF)");
    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-highlights", "nav-highlight-0");
    await expect(page.getByTestId("nav-highlight-0")).toContainText("check this later", {
      timeout: 10000,
    });

    // Revisit: jumping to the highlight lands on page 1 with the overlay drawn.
    await page.getByTestId("nav-highlight-jump-0").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });
    await waitForRendered(page, 1);
    // A highlight draws one overlay per selection rectangle (multi-line
    // selections produce several) — any overlay present is the contract.
    await page
      .locator("[data-pdf-highlight]")
      .first()
      .waitFor({ state: "attached", timeout: 10000 });

    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-bookmarks", "nav-bookmark-0");
    expect(await textOf(page, "nav-bookmark-0")).toMatch(/Page \d+/);
    await closeReaderNavigation(page);

    await returnToLibrary(page);
  });

  test("keeps an EPUB bookmark across close and reopen", async ({ page }) => {
    const epubReady = (page: Page) =>
      expect(page.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready", {
        timeout: 30000,
      });

    await openInReader(page, "A Minimal Book (EPUB)");
    await epubReady(page);

    await page.getByTestId("reader-bookmark").click();
    await expect(page.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "true", {
      timeout: 10000,
    });
    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-bookmarks", "nav-bookmark-0");
    await closeReaderNavigation(page);

    await returnToLibrary(page);
    await openInReader(page, "A Minimal Book (EPUB)");
    await epubReady(page);

    // Reopening restores the same position, so the stored bookmark lights
    // the toolbar button up again.
    await expect(page.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "true", {
      timeout: 30000,
    });
    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-bookmarks", "nav-bookmark-0");
    await closeReaderNavigation(page);

    await returnToLibrary(page);
  });

  test("truncates long bookmark labels and keeps the row actions inside the drawer", async ({
    page,
  }) => {
    // Created before the reader opens, so the drawer's initial load has it.
    const marker = "very-long-chapter-href-".padEnd(180, "x");
    const created = (await page.evaluate(async (marker) => {
      const books = (await window.tuxbooks!.invoke("list_books")) as {
        id: number;
        format: string;
      }[];
      const epub = books.find((book) => book.format === "epub");
      if (!epub) throw new Error("no epub book in the scratch library");
      return window.tuxbooks!.invoke("create_annotation", {
        bookId: epub.id,
        annotation: {
          kind: "bookmark",
          cfi: "epubcfi(/6/2!/4/2,/1:0,/1:1)",
          chapterHref: marker,
        },
      });
    }, marker)) as { id: number };

    await openInReader(page, "A Minimal Book (EPUB)");
    await expect(page.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready", {
      timeout: 30000,
    });

    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-bookmarks", "nav-bookmark-0");

    // The bookmark's spine href is far longer than the drawer: its label
    // must ellipsize instead of stretching the row past the sheet edge
    // (regression: the delete button disappeared off-sheet on wide rows).
    const rowChecks = await page.evaluate((marker) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLDivElement>("[data-testid^=nav-bookmark-]"),
      ).filter(
        (row) =>
          row.tagName === "DIV" &&
          row.className.includes("rounded-md") &&
          (row.textContent ?? "").includes(marker),
      );
      if (rows.length === 0) return { found: false };
      const row = rows[0];
      const label = row.querySelector("span");
      const sheet = document.querySelector("[data-testid=reader-nav]");
      const rightmost = Math.max(
        ...Array.from(row.querySelectorAll("button")).map(
          (button) => button.getBoundingClientRect().right,
        ),
      );
      return {
        found: true,
        labelTruncated: label !== null && label.scrollWidth > label.clientWidth,
        rowInsideSheet: sheet !== null && rightmost <= sheet.getBoundingClientRect().right - 4,
      };
    }, marker);

    expect(rowChecks.found).toBe(true);
    expect(rowChecks.labelTruncated).toBe(true);
    expect(rowChecks.rowInsideSheet).toBe(true);

    await page.evaluate(async (id) => {
      await window.tuxbooks!.invoke("delete_annotation", { id });
    }, created.id);
    await closeReaderNavigation(page);
    await returnToLibrary(page);
  });

  test("removes a PDF highlight from the palette and the removal persists across reopen", async ({
    page,
  }) => {
    // Order independence: earlier specs in the shared scratch library may
    // have left highlights on this book — clear them through the bridge
    // before the reader loads its annotation list.
    await page.evaluate(async () => {
      const books = (await window.tuxbooks!.invoke("list_books")) as {
        id: number;
        format: string;
        title: string;
      }[];
      const pdf = books.find((book) => book.format === "pdf" && book.title === "A Minimal Manual");
      if (!pdf) throw new Error("A Minimal Manual is not in the scratch library");
      const annotations = (await window.tuxbooks!.invoke("list_annotations", {
        bookId: pdf.id,
      })) as { id: number; kind: string }[];
      for (const annotation of annotations) {
        if (annotation.kind === "highlight") {
          await window.tuxbooks!.invoke("delete_annotation", { id: annotation.id });
        }
      }
    });

    await openInReader(page, "A Minimal Manual (PDF)");
    await expect
      .poll(async () => (await slotStates(page)).length, { timeout: 30000 })
      .toBeGreaterThan(0);
    await scrollToSlot(page, 1);
    await waitForRendered(page, 1, 60000);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const layer = document.querySelector('[data-pdf-text-layer="1"]');
            return layer !== null && layer.querySelectorAll("span").length > 0;
          }),
        { timeout: 30000 },
      )
      .toBe(true);
    await expect(page.locator("[data-pdf-highlight]")).toHaveCount(0);

    // Create a yellow highlight from a real text-layer selection.
    await selectPageOneText(page);
    await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("highlight-color-yellow").click();
    await page
      .locator("[data-pdf-highlight]")
      .first()
      .waitFor({ state: "attached", timeout: 10000 });

    // A plain click on the highlighted text addresses it: the palette
    // offers Remove, and Remove deletes the annotation — the overlay
    // disappears and the underlying text keeps working.
    await page.locator('[data-pdf-text-layer="1"] span').first().click();
    await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("highlight-remove")).toBeVisible();
    await page.getByTestId("highlight-remove").click();
    await expect(page.locator("[data-pdf-highlight]")).toHaveCount(0, { timeout: 10000 });
    await expect(page.getByTestId("selection-toolbar")).toBeHidden({ timeout: 10000 });

    // The same text is selectable again and nothing is targeted.
    await selectPageOneText(page);
    await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("highlight-remove")).toHaveCount(0);
    await page.getByRole("button", { name: "Dismiss selection" }).click();

    // Reopen: the removal was persisted — no highlight comes back.
    await returnToLibrary(page);
    await openInReader(page, "A Minimal Manual (PDF)");
    await expect
      .poll(async () => (await slotStates(page)).length, { timeout: 30000 })
      .toBeGreaterThan(0);
    await scrollToSlot(page, 1);
    await waitForRendered(page, 1, 60000);
    await expect(page.locator("[data-pdf-highlight]")).toHaveCount(0, { timeout: 10000 });
    await returnToLibrary(page);
  });
});
