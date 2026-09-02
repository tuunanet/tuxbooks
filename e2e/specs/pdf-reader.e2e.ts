import {
  canvasIsNonBlank,
  fitFactor,
  openInReader,
  renderedCount,
  returnToLibrary,
  scrollToSlot,
  scrollThumbnailsToBottom,
  textOf,
  thumbnailCanvasCount,
  thumbnailIsActive,
  thumbnailState,
  waitForRendered,
} from "./helpers.js";

describe("tuxbooks continuous PDF reader", () => {
  // Virtualization on the 100-page fixture: the whole document reserves
  // geometry, but only a bounded set of pages may own canvases at any time.
  // The upper bound is a regression guard against rendering the entire
  // document — not an exact contract.
  const RENDER_BUDGET_LIMIT = 15;
  const THUMBNAIL_BUDGET_LIMIT = 20;

  async function openLargeFixture(): Promise<void> {
    await openInReader("A Large Fixture (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    // The document may restore to a previously read page (persistence), so
    // only the page count itself is a stable expectation here.
    await browser.waitUntil(
      async () => /Page \d+ of 100/.test(await textOf("pdf-page-indicator")),
      { timeout: 30000, timeoutMsg: "large fixture never reported its page count" },
    );
  }

  it("renders the minimal fixture with working page navigation", async () => {
    await openInReader("A Minimal Manual (PDF)");
    const canvas = await $("[data-testid=pdf-canvas]");
    await canvas.waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "minimal fixture never reported its page count",
    });

    // Deterministic geometry: pages render fit-to-width times the zoom
    // multiplier, times the device pixel ratio for the backing store.
    const dpr = await browser.execute(() => window.devicePixelRatio);
    const fit = await fitFactor();
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) === Math.floor(612 * fit * dpr),
      { timeout: 30000, timeoutMsg: "page 1 never rendered at fit width" },
    );
    expect(await canvasIsNonBlank(1)).toBe(true);

    await $("[data-testid=pdf-next]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 2 of 3", {
      timeout: 30000,
      timeoutMsg: "next never reached page 2",
    });
    await $("[data-testid=pdf-prev]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "prev never returned to page 1",
    });

    await returnToLibrary();
  });

  it("tracks the current page while scrolling continuously", async () => {
    await openInReader("A Minimal Manual (PDF)");
    const canvas = await $("[data-testid=pdf-canvas]");
    await canvas.waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "minimal fixture never reported its page count",
    });

    // Scrolling is the navigation: the anchor rule moves the current page
    // forward through the document and back without any button presses.
    await scrollToSlot(2);
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 2 of 3", {
      timeout: 30000,
      timeoutMsg: "scrolling never reached page 2",
    });
    await scrollToSlot(3);
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 3 of 3", {
      timeout: 30000,
      timeoutMsg: "scrolling never reached page 3",
    });
    await scrollToSlot(1);
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "reverse scrolling never returned to page 1",
    });

    await returnToLibrary();
  });

  it("keeps the active canvas set bounded in a 100-page document", async () => {
    await openLargeFixture();

    expect(await renderedCount()).toBeLessThan(RENDER_BUDGET_LIMIT);

    // Scrolling deep must render the destination page without ever
    // exploding the number of live canvases.
    await scrollToSlot(60);
    await waitForRendered(60);
    expect(await textOf("pdf-page-indicator")).toContain("Page");
    expect(await renderedCount()).toBeLessThan(RENDER_BUDGET_LIMIT);

    // The PDF.js worker must actually load. A silent fake-worker fallback
    // (main-thread rendering) is a classic cause of seconds-long, highly
    // variable page render times.
    const workerSrc = await browser.execute(() =>
      document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-worker-src"),
    );
    expect(workerSrc).toBeTruthy();
    const workerReachable = await browser.execute(async (src) => {
      try {
        if (typeof src !== "string") return false;
        const response = await fetch(src);
        return response.ok;
      } catch {
        return false;
      }
    }, workerSrc);
    expect(workerReachable).toBe(true);

    await scrollToSlot(100);
    await waitForRendered(100);
    expect(await renderedCount()).toBeLessThan(RENDER_BUDGET_LIMIT);

    // Distant pages are evicted: slot 2's canvas is gone while its
    // geometry reservation remains as an unloaded slot.
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          document.querySelector('[data-pdf-slot="2"]')?.getAttribute("data-render-state"),
        )) === "unloaded",
      { timeout: 30000, timeoutMsg: "distant page 2 was never evicted" },
    );

    // Rapid long-distance jumps (scrollbar-drag churn): superseded renders
    // must unwind cleanly, and the final revisit ends with a fully painted
    // canvas — no interleaved-paint fragments.
    await scrollToSlot(87);
    await scrollToSlot(30);
    await scrollToSlot(74);
    await scrollToSlot(60);
    await waitForRendered(60);
    expect(await canvasIsNonBlank(60)).toBe(true);

    await returnToLibrary();
  });

  // Critical acceptance test (§ persistence): the reader resumes where the
  // user stopped, across close/reopen.
  it("restores the reading position when a PDF is reopened", async () => {
    await openInReader("A Minimal Manual (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "minimal fixture never reported its page count",
    });

    // Scroll to page 2 and let the debounced save land before leaving.
    await scrollToSlot(2);
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 2 of 3", {
      timeout: 30000,
      timeoutMsg: "scrolling never reached page 2",
    });
    await browser.pause(1500);
    await returnToLibrary();

    // Reopen: page 2 is restored (indicator, canvas, geometry).
    await openInReader("A Minimal Manual (PDF)");
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 2 of 3", {
      timeout: 30000,
      timeoutMsg: "reading position was not restored on reopen",
    });
    await waitForRendered(2);
    expect(await canvasIsNonBlank(2)).toBe(true);

    await returnToLibrary();
  });

  it("keeps the current page rendered when zooming deep in the document", async () => {
    await openLargeFixture();

    // Jump deep via the semantic Pages drawer (not pixel coordinates).
    await $("[data-testid=reader-nav-trigger]").click();
    await $("[data-testid=nav-pages]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=nav-page-87]").click();

    await waitForRendered(87);
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 87 of 100", {
      timeout: 30000,
      timeoutMsg: "drawer jump never reached page 87",
    });

    // Zoom rescales every slot; the current page must stay rendered and
    // visible rather than leaving a stale viewport offset (UAT regression).
    await $("[data-testid=pdf-zoom-in]").click();
    await browser.waitUntil(async () => (await textOf("pdf-zoom-level")).includes("150%"), {
      timeout: 30000,
      timeoutMsg: "zoom never reached 150%",
    });
    await waitForRendered(87);
    expect(
      await browser.execute(
        () => document.querySelector('[data-testid="pdf-canvas"][data-pdf-page="87"]') !== null,
      ),
    ).toBe(true);
    expect(await canvasIsNonBlank(87)).toBe(true);
    await returnToLibrary();
  });

  it("lays out mixed page sizes independently without overlap", async () => {
    await openInReader("Odd Sizes (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 6", {
      timeout: 30000,
      timeoutMsg: "mixed fixture never reported its page count",
    });

    // Geometry corrects lazily as pages approach the viewport, so walk the
    // document and wait for each slot to take its real displayed height
    // (100% zoom = fit width; dpr = 1 under Xvfb; heights scale from the
    // fixture MediaBoxes by the fit factor).
    const fit = await fitFactor();
    const expectedHeights = [792, 612, 1008, 500, 842, 504].map((height) =>
      Math.floor(height * fit),
    );
    for (const [index, height] of expectedHeights.entries()) {
      const pageNumber = index + 1;
      await scrollToSlot(pageNumber);
      await browser.waitUntil(
        async () =>
          Math.abs(
            (await browser.execute(
              (page) => document.querySelector(`[data-pdf-slot="${page}"]`)?.offsetHeight ?? 0,
              pageNumber,
            )) - height,
          ) <= 1,
        { timeout: 30000, timeoutMsg: `slot ${pageNumber} never reached height ${height}` },
      );
    }

    // From the top, the document now shows real mixed geometry and stacks
    // strictly: each top equals the previous bottom plus the 8px page gap —
    // no overlap, no collapse (±1px for offsetHeight rounding).
    await scrollToSlot(1);
    const layout = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-pdf-slot]")).map((slot) => ({
        page: slot.getAttribute("data-pdf-slot"),
        top: slot.offsetTop,
        height: slot.offsetHeight,
        width: slot.offsetWidth,
      })),
    );
    expect(layout.map((slot) => slot.page)).toEqual(["1", "2", "3", "4", "5", "6"]);
    for (let i = 0; i < layout.length; i++) {
      expect(Math.abs(layout[i].height - expectedHeights[i])).toBeLessThanOrEqual(1);
    }

    // Slots stack strictly: each top equals the previous bottom plus the
    // 8px page gap — no overlap, no collapse (±1px: offsetTop/offsetHeight
    // round independently at fractional fit scales).
    for (let i = 1; i < layout.length; i++) {
      expect(
        Math.abs(layout[i].top - layout[i - 1].top - (layout[i - 1].height + 8)),
      ).toBeLessThanOrEqual(1);
    }

    // The bounded render budget holds on a mixed-size document too.
    expect(await renderedCount()).toBeLessThan(6);
    await returnToLibrary();
  });

  it("navigates to destinations from the document outline", async () => {
    await openInReader("A Large Fixture (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await browser.waitUntil(
      async () => /Page \d+ of 100/.test(await textOf("pdf-page-indicator")),
      { timeout: 30000, timeoutMsg: "large fixture never reported its page count" },
    );

    await $("[data-testid=reader-nav-trigger]").click();
    await $("[data-testid=nav-tab-outline]").click();
    // 15 deterministic entries (5 parts × 2 sections), flattened depth-first:
    // index 6 is "Part Three" (page 41), index 8 "Section Three-B" (page 51).
    await $("[data-testid=nav-outline-item-0]").waitForDisplayed({ timeout: 30000 });
    expect(await textOf("nav-outline-item-6")).toContain("Part Three");

    await $("[data-testid=nav-outline-item-6]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 41 of 100", {
      timeout: 30000,
      timeoutMsg: "outline jump never reached page 41",
    });
    await waitForRendered(41);
    // Selecting an entry closes the drawer; wait out the exit animation so
    // the fading sheet overlay cannot swallow the header clicks below.
    await $("[data-testid=reader-nav]").waitForExist({ reverse: true, timeout: 30000 });

    // A nested entry resolves to its own destination, not its parent's.
    await $("[data-testid=reader-nav-trigger]").click();
    await $("[data-testid=nav-tab-outline]").click();
    await $("[data-testid=nav-outline-item-8]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=nav-outline-item-8]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 51 of 100", {
      timeout: 30000,
      timeoutMsg: "outline jump never reached page 51",
    });
    await waitForRendered(51);
    await $("[data-testid=reader-nav]").waitForExist({ reverse: true, timeout: 30000 });

    await returnToLibrary();
  });

  it("shows an empty outline state for documents without one", async () => {
    await openInReader("A Minimal Manual (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    // The document may restore a previously read page (persistence), so only
    // the page count itself is a stable expectation here.
    await browser.waitUntil(async () => /Page \d+ of 3/.test(await textOf("pdf-page-indicator")), {
      timeout: 30000,
      timeoutMsg: "minimal fixture never reported its page count",
    });

    await $("[data-testid=reader-nav-trigger]").click();
    await $("[data-testid=nav-tab-outline]").click();
    await $("[data-testid=nav-outline-empty]").waitForDisplayed({ timeout: 30000 });
    expect(await textOf("nav-outline-empty")).toContain("no outline");

    // Close the drawer before leaving: the sheet overlay covers the header.
    await browser.keys(["Escape"]);
    await $("[data-testid=reader-nav]").waitForExist({ reverse: true, timeout: 30000 });

    await returnToLibrary();
  });

  it("navigates with virtualized thumbnails in a bounded sidebar", async () => {
    await openLargeFixture();

    await $("[data-testid=reader-sidebar-toggle]").click();
    await $("[data-testid=pdf-thumbnails]").waitForDisplayed({ timeout: 30000 });

    // The reading page is indicated without any interaction — whichever page
    // the reader restored to, its thumbnail is marked active.
    const restoredPage = Number(
      (await textOf("pdf-page-indicator")).match(/Page (\d+) of 100/)?.[1],
    );
    expect(restoredPage).toBeGreaterThanOrEqual(1);
    await browser.waitUntil(async () => thumbnailIsActive(restoredPage), {
      timeout: 30000,
      timeoutMsg: `page ${restoredPage} thumbnail never marked active`,
    });

    // Clicking a thumbnail navigates the document (the whole list reserves
    // cells up front, so the target exists even while far out of view).
    await $('[data-pdf-thumb-slot="50"] button').click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 50 of 100", {
      timeout: 30000,
      timeoutMsg: "thumbnail click never reached page 50",
    });
    await waitForRendered(50);
    expect(await thumbnailIsActive(50)).toBe(true);
    expect(await thumbnailCanvasCount()).toBeLessThan(THUMBNAIL_BUDGET_LIMIT);

    // Scrolling the sidebar deep renders destination thumbnails and still
    // never mounts the whole document as bitmaps.
    await scrollThumbnailsToBottom();
    await browser.waitUntil(async () => (await thumbnailState(100)) === "rendered", {
      timeout: 30000,
      timeoutMsg: "deep thumbnail never rendered",
    });
    expect(await thumbnailCanvasCount()).toBeLessThan(THUMBNAIL_BUDGET_LIMIT);

    // Current-page synchronization: scrolling the document moves the
    // highlight (and brings the page's thumbnail into view and rendered).
    await scrollToSlot(70);
    await browser.waitUntil(async () => thumbnailIsActive(70), {
      timeout: 30000,
      timeoutMsg: "thumbnail highlight never followed the reading position",
    });
    await browser.waitUntil(async () => (await thumbnailState(70)) === "rendered", {
      timeout: 30000,
      timeoutMsg: "active thumbnail never rendered",
    });
    expect(await canvasIsNonBlank(70, "pdf-thumbnail")).toBe(true);

    // Closing the sidebar unmounts the thumbnails with it.
    await $("[data-testid=reader-sidebar-toggle]").click();
    await $("[data-testid=pdf-thumbnails]").waitForExist({ reverse: true, timeout: 30000 });

    await returnToLibrary();
  });
});
