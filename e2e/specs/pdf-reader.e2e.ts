import {
  canvasIsNonBlank,
  openInReader,
  renderedCount,
  returnToLibrary,
  scrollToSlot,
  textOf,
  waitForRendered,
} from "./helpers.js";

describe("tuxbooks continuous PDF reader", () => {
  // Virtualization on the 100-page fixture: the whole document reserves
  // geometry, but only a bounded set of pages may own canvases at any time.
  // The upper bound is a regression guard against rendering the entire
  // document — not an exact contract.
  const RENDER_BUDGET_LIMIT = 15;

  async function openLargeFixture(): Promise<void> {
    await openInReader("A Large Fixture (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 100", {
      timeout: 30000,
      timeoutMsg: "large fixture never reported its page count",
    });
  }

  it("renders the minimal fixture with working page navigation", async () => {
    await openInReader("A Minimal Manual (PDF)");
    const canvas = await $("[data-testid=pdf-canvas]");
    await canvas.waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "minimal fixture never reported its page count",
    });

    // Deterministic geometry: 612x792 pt pages at 100% zoom, dpr = 1.
    const dpr = await browser.execute(() => window.devicePixelRatio);
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) === Math.floor(612 * dpr),
      { timeout: 30000, timeoutMsg: "page 1 never rendered at 100% zoom" },
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
    // (100% zoom, dpr = 1 under Xvfb, mirroring the fixture MediaBoxes).
    const expectedHeights = [792, 612, 1008, 500, 842, 504];
    for (const [index, height] of expectedHeights.entries()) {
      const pageNumber = index + 1;
      await scrollToSlot(pageNumber);
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            (page) => document.querySelector(`[data-pdf-slot="${page}"]`)?.offsetHeight ?? 0,
            pageNumber,
          )) === height,
        { timeout: 30000, timeoutMsg: `slot ${pageNumber} never reached height ${height}` },
      );
    }

    // From the top, the document now shows real mixed geometry and stacks
    // strictly: each top equals the previous bottom plus the 8px page gap —
    // no overlap, no collapse.
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
    expect(layout.map((slot) => slot.height)).toEqual(expectedHeights);

    // Slots stack strictly: each top equals the previous bottom plus the
    // 8px page gap — no overlap, no collapse.
    for (let i = 1; i < layout.length; i++) {
      expect(layout[i].top - layout[i - 1].top).toBe(layout[i - 1].height + 8);
    }

    // The bounded render budget holds on a mixed-size document too.
    expect(await renderedCount()).toBeLessThan(6);
    await returnToLibrary();
  });
});
