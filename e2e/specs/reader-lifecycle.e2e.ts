import {
  bitmapCacheUsage,
  canvasIsNonBlank,
  currentPageNumber,
  epubHostCount,
  maxSingleBitmapBytes,
  openInReader,
  pdfSurfaceMemory,
  renderedCount,
  returnToLibrary,
  scrollToSlot,
  textOf,
  waitForRendered,
} from "./helpers.js";

/**
 * Milestone 9 reader-lifecycle hardening, on the real binary: document
 * switching (including across formats), rapid repeated open/close, closing
 * while renders are in flight, rapid navigation inputs, window resizes, and
 * the memory bounds behind all of it. Every reading-position expectation is
 * derived from the live indicator — the seeded library accumulates state
 * across specs, so nothing may assume a fresh book.
 */

/** Mirrors PdfBitmapCache's configured bounds (48 MiB / 8 entries). */
const CACHE_MAX_ENTRIES = 8;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;

/** The bounded render budget's regression ceiling (matches pdf-reader spec). */
const RENDER_BUDGET_LIMIT = 15;

async function openLargePdf(): Promise<void> {
  await openInReader("A Large Fixture (PDF)");
  await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
  await browser.waitUntil(async () => /Page \d+ of 100/.test(await textOf("pdf-page-indicator")), {
    timeout: 30000,
    timeoutMsg: "large fixture never reported its page count",
  });
}

/** Opens the EPUB and waits for the engine host to report ready. */
async function openReadyEpub(): Promise<void> {
  await openInReader("A Minimal Book (EPUB)");
  await browser.waitUntil(
    async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
    { timeout: 30000, timeoutMsg: "epub engine never became ready" },
  );
}

describe("tuxbooks reader lifecycle hardening", () => {
  it("switches between document types without carrying state over", async () => {
    await openReadyEpub();
    expect(await epubHostCount()).toBe(1);
    await returnToLibrary();

    await openInReader("A Minimal Manual (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => /Page \d+ of 3/.test(await textOf("pdf-page-indicator")), {
      timeout: 30000,
      timeoutMsg: "minimal PDF never reported its page count",
    });
    // The EPUB engine died with its reader: no orphaned host survives.
    expect(await epubHostCount()).toBe(0);
    await returnToLibrary();

    // Back into the EPUB: a fresh engine mounts, exactly one host.
    await openReadyEpub();
    expect(await epubHostCount()).toBe(1);
    await returnToLibrary();
  });

  it("survives rapid repeated open/close across books", async () => {
    for (let round = 0; round < 2; round++) {
      await openReadyEpub();
      await returnToLibrary();
      await openInReader("A Minimal Manual (PDF)");
      await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
      await returnToLibrary();
    }

    // The churned session still opens a clean, fully working document.
    await openLargePdf();
    const page = await currentPageNumber();
    expect(page).not.toBeNull();
    await waitForRendered(page!);
    expect(await canvasIsNonBlank(page!)).toBe(true);
    expect(await renderedCount()).toBeLessThan(RENDER_BUDGET_LIMIT);
    await returnToLibrary();
  });

  it("recovers from closing the reader while pages are still rendering", async () => {
    await openLargePdf();

    // Send the reader deep and close it before any render is waited for:
    // in-flight renders must unwind (cancel + document destroy) without
    // wedging the app.
    await scrollToSlot(95);
    await returnToLibrary();

    await openLargePdf();
    const page = await currentPageNumber();
    expect(page).not.toBeNull();
    await waitForRendered(page!);
    expect(await canvasIsNonBlank(page!)).toBe(true);
    await returnToLibrary();
  });

  it("keeps canvas and cache memory bounded across repeated sessions", async () => {
    for (let round = 0; round < 3; round++) {
      await openLargePdf();

      // A different deep region each round, so no session reuses the
      // previous one's canvases.
      const target = 20 + round * 25;
      await scrollToSlot(target);
      await waitForRendered(target);

      const memory = await pdfSurfaceMemory();
      expect(memory.pageCanvases).toBeLessThan(RENDER_BUDGET_LIMIT);
      // Live canvases alone stay in the tens of megabytes even at dpr 1 —
      // the render budget bounds them regardless of scroll distance.
      expect(memory.pageBytes).toBeLessThan(64 * 1024 * 1024);

      const cache = await bitmapCacheUsage();
      expect(cache).not.toBeNull();
      expect(cache!.entries).toBeLessThanOrEqual(CACHE_MAX_ENTRIES);
      // The byte budget holds, allowing for the newest single page being
      // kept even when oversized (oversized-keep-latest); this test never
      // zooms, so the excess is one fit-width bitmap at the session DPR.
      const onePage = await maxSingleBitmapBytes(1);
      expect(cache!.bytes).toBeLessThanOrEqual(CACHE_MAX_BYTES + onePage);

      await returnToLibrary();
    }

    // EPUB document lifecycle: after all the PDF churn, the engine host
    // count is still exactly one while an EPUB is open, zero after it.
    await openReadyEpub();
    expect(await epubHostCount()).toBe(1);
    await returnToLibrary();
    expect(await epubHostCount()).toBe(0);
  });

  it("keeps rapid navigation inputs converging on a rendered page", async () => {
    await openLargePdf();

    // Deterministic start, then hammer next.
    await browser.keys(["Home"]);
    await browser.waitUntil(async () => (await currentPageNumber()) === 1, {
      timeout: 30000,
      timeoutMsg: "Home never returned to page 1",
    });
    for (let i = 0; i < 4; i++) {
      await $("[data-testid=pdf-next]").click();
    }
    await browser.waitUntil(async () => (await currentPageNumber()) === 5, {
      timeout: 30000,
      timeoutMsg: "rapid next clicks never converged on page 5",
    });
    await waitForRendered(5);
    expect(await canvasIsNonBlank(5)).toBe(true);

    // Rapid thumbnail clicks: the last target wins and paints. The final
    // click is re-driven once — a lost programmatic scroll under load must
    // not fail the convergence wait (systematic loss still would).
    await $("[data-testid=reader-sidebar-toggle]").click();
    await $("[data-testid=pdf-thumbnails]").waitForDisplayed({ timeout: 30000 });
    for (const target of [50, 20, 70]) {
      await $(`[data-pdf-thumb-slot="${target}"] button`).click();
    }
    await $(`[data-pdf-thumb-slot="70"] button`).click();
    await browser.waitUntil(async () => (await currentPageNumber()) === 70, {
      timeout: 30000,
      timeoutMsg: "rapid thumbnail clicks never converged on page 70",
    });
    await waitForRendered(70);
    expect(await canvasIsNonBlank(70)).toBe(true);

    await $("[data-testid=reader-sidebar-toggle]").click();
    await $("[data-testid=pdf-thumbnails]").waitForExist({ reverse: true, timeout: 30000 });
    await returnToLibrary();
  });

  it("keeps the current page rendered through window resizes", async () => {
    const original = await browser.getWindowSize();
    try {
      await openLargePdf();
      await scrollToSlot(30);
      await waitForRendered(30);
      expect(await canvasIsNonBlank(30)).toBe(true);

      // Shrink within the window's minimum bounds: fit-width recomputes,
      // the anchor re-lands by fraction, and page 30 (or its immediate
      // neighbor — the anchor is a fraction into the page) renders again.
      await browser.setWindowSize(860, 600);
      await browser.waitUntil(
        async () => {
          const page = await currentPageNumber();
          return page !== null && page >= 29 && page <= 31;
        },
        { timeout: 30000, timeoutMsg: "the reading page never re-anchored after resize" },
      );
      const page = (await currentPageNumber())!;
      await waitForRendered(page);
      expect(await canvasIsNonBlank(page)).toBe(true);
      expect(await renderedCount()).toBeLessThan(RENDER_BUDGET_LIMIT);
    } finally {
      // The session is shared by every spec: restore the initial geometry.
      await browser.setWindowSize(original.width, original.height);
    }
    await returnToLibrary();
  });
});
