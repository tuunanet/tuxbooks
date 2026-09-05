import {
  clickRetryingStale,
  closeReaderNavigation,
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
describe("reading annotations", () => {
  it("creates a PDF highlight from a selection, attaches a note, and revisits both after reopen", async () => {
    await openInReader("A Minimal Manual (PDF)");

    // Deterministic anchor: page 1 rendered, with its selectable text layer
    // (the spans render asynchronously after the container mounts). The
    // reader restores the book's saved position before the surface mounts,
    // so wait for the document slots before scrolling — scrollToSlot
    // no-ops while the reader is still loading.
    await browser.waitUntil(async () => (await slotStates()).length > 0, {
      timeout: 30000,
      timeoutMsg: "pdf slots never appeared",
    });
    await scrollToSlot(1);
    await waitForRendered(1, 60000);
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const layer = document.querySelector('[data-pdf-text-layer="1"]');
          return layer !== null && layer.querySelectorAll("span").length > 0;
        }),
      { timeout: 30000, timeoutMsg: "page 1 text layer spans never rendered" },
    );

    // Select the page's text through its text layer and release the pointer,
    // so the reader captures the selection the same way a mouse drag ends.
    await browser.execute(() => {
      const layer = document.querySelector('[data-pdf-text-layer="1"]');
      const spans = layer ? Array.from(layer.querySelectorAll("span")) : [];
      if (spans.length === 0) return;
      const range = document.createRange();
      range.setStartBefore(spans[0]!);
      range.setEndAfter(spans[spans.length - 1]!);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });

    await $("[data-testid=selection-toolbar]").waitForDisplayed({ timeout: 10000 });
    await $("[data-testid=highlight-color-yellow]").click();

    // The stored highlight's overlay draws on the page right away.
    await $("[data-pdf-highlight]").waitForExist({ timeout: 10000 });

    // Attach a note through the drawer's Highlights tab.
    await openReaderNavigation();
    await $("[data-testid=nav-tab-highlights]").click();
    await $("[data-testid=nav-highlight-0]").waitForDisplayed({ timeout: 10000 });
    await $("[data-testid=nav-highlight-note-0]").click();
    await $("[data-testid=annotation-note-input]").setValue("check this later");
    await $("[data-testid=annotation-note-save]").click();
    await browser.waitUntil(
      async () => (await textOf("nav-highlight-0")).includes("check this later"),
      { timeout: 10000, timeoutMsg: "note never appeared on the highlight" },
    );
    await closeReaderNavigation();

    // Bookmark the page as well, then leave; the debounced progress save
    // plus the unmount flush persist everything.
    await clickRetryingStale("[data-testid=reader-bookmark]");
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=reader-bookmark]").getAttribute("aria-pressed")) === "true",
      { timeout: 10000, timeoutMsg: "bookmark was never placed" },
    );
    await returnToLibrary();

    // Reopen: highlight, note, and bookmark all come back from the database.
    await openInReader("A Minimal Manual (PDF)");
    await openReaderNavigation();
    await $("[data-testid=nav-tab-highlights]").click();
    await $("[data-testid=nav-highlight-0]").waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await textOf("nav-highlight-0")).includes("check this later"),
      { timeout: 10000, timeoutMsg: "note was not restored on reopen" },
    );

    // Revisit: jumping to the highlight lands on page 1 with the overlay drawn.
    await $("[data-testid=nav-highlight-jump-0]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "highlight jump never reached page 1",
    });
    await waitForRendered(1);
    await $("[data-pdf-highlight]").waitForExist({ timeout: 10000 });

    await openReaderNavigation();
    await $("[data-testid=nav-tab-bookmarks]").click();
    await $("[data-testid=nav-bookmark-0]").waitForDisplayed({ timeout: 10000 });
    expect(await textOf("nav-bookmark-0")).toMatch(/Page \d+/);
    await closeReaderNavigation();

    await returnToLibrary();
  });

  it("keeps an EPUB bookmark across close and reopen", async () => {
    const epubReady = () =>
      browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              document
                .querySelector("[data-testid=epub-reader]")
                ?.getAttribute("data-epub-state") === "ready",
          ),
        { timeout: 30000, timeoutMsg: "epub reader never became ready" },
      );

    await openInReader("A Minimal Book (EPUB)");
    await epubReady();

    await clickRetryingStale("[data-testid=reader-bookmark]");
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=reader-bookmark]").getAttribute("aria-pressed")) === "true",
      { timeout: 10000, timeoutMsg: "bookmark was never placed" },
    );
    await openReaderNavigation();
    await $("[data-testid=nav-tab-bookmarks]").click();
    await $("[data-testid=nav-bookmark-0]").waitForDisplayed({ timeout: 10000 });
    await closeReaderNavigation();

    await returnToLibrary();
    await openInReader("A Minimal Book (EPUB)");
    await epubReady();

    // Reopening restores the same position, so the stored bookmark lights
    // the toolbar button up again.
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=reader-bookmark]").getAttribute("aria-pressed")) === "true",
      { timeout: 30000, timeoutMsg: "stored bookmark not reflected after reopen" },
    );
    await openReaderNavigation();
    await $("[data-testid=nav-tab-bookmarks]").click();
    await $("[data-testid=nav-bookmark-0]").waitForDisplayed({ timeout: 10000 });
    await closeReaderNavigation();

    await returnToLibrary();
  });

  it("truncates long bookmark labels and keeps the row actions inside the drawer", async () => {
    // Created before the reader opens, so the drawer's initial load has it.
    const marker = "very-long-chapter-href-".padEnd(180, "x");
    const created = await browser.execute(async (marker) => {
      const books = await window.__TAURI__.core.invoke("list_books");
      const epub = books.find((book) => book.format === "epub");
      return window.__TAURI__.core.invoke("create_annotation", {
        bookId: epub.id,
        annotation: {
          kind: "bookmark",
          cfi: "epubcfi(/6/2!/4/2,/1:0,/1:1)",
          chapterHref: marker,
        },
      });
    }, marker);

    await openInReader("A Minimal Book (EPUB)");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelector("[data-testid=epub-reader]")?.getAttribute("data-epub-state") ===
            "ready",
        ),
      { timeout: 30000, timeoutMsg: "epub reader never became ready" },
    );

    await openReaderNavigation();
    await $("[data-testid=nav-tab-bookmarks]").click();
    await $("[data-testid=nav-bookmark-0]").waitForDisplayed({ timeout: 10000 });

    // The bookmark's spine href is far longer than the drawer: its label
    // must ellipsize instead of stretching the row past the sheet edge
    // (regression: the delete button disappeared off-sheet on wide rows).
    const rowChecks = await browser.execute((marker) => {
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

    await browser.execute(async (id) => {
      await window.__TAURI__.core.invoke("delete_annotation", { id });
    }, created.id);
    await closeReaderNavigation();
    await returnToLibrary();
  });
});
