import {
  canvasIsNonBlank,
  fitFactor,
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
 * High-DPI regression coverage (docs/testing.md): one configuration that is
 * representative of a high-DPI/high-refresh desktop — the reference
 * conditions in docs/performance.md name devicePixelRatio 2.0 explicitly.
 * The hidpi phase (`just test-e2e-hidpi`) launches the app with
 * `--force-device-scale-factor=2` through E2E_DEVICE_SCALE_FACTOR, so every
 * buffer is four times the pixels of the default run.
 *
 * Assertions are deterministic attributes and geometry only (timing stays
 * out of headless E2E, docs/performance.md): the scale factor is actually
 * applied, pages render at the doubled backing store, the PERF-1 buffer
 * caps hold at dpr 2, a rapid page-turn sweep stays inside the render
 * budget, and the EPUB engine still initializes and reports progression.
 * This is the guard against "works at 60 Hz/dpr 1, degrades badly at high
 * DPI" rendering behavior.
 */

const RENDER_BUDGET_LIMIT = 15;

describe("tuxbooks high-DPI configuration (devicePixelRatio 2)", () => {
  it("launches with the forced scale factor", async () => {
    const dpr = await browser.execute(() => window.devicePixelRatio);
    expect(dpr).toBe(2);
  });

  it("renders PDF pages at the doubled backing store within the buffer caps", async () => {
    await openInReader("A Minimal Manual (PDF)");
    const canvas = await $("[data-testid=pdf-canvas]");
    await canvas.waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "hidpi: minimal PDF never reported its page count",
    });

    // Geometry mirrors the default-run contract, times dpr 2.
    const dpr = await browser.execute(() => window.devicePixelRatio);
    const fit = await fitFactor();
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) === Math.floor(612 * fit * dpr),
      { timeout: 30000, timeoutMsg: "hidpi: page 1 never rendered at fit width × 2" },
    );
    expect(await canvasIsNonBlank(1)).toBe(true);

    // PERF-1 at the high-DPI reference condition: the backing store stays
    // inside the pixel and dimension caps.
    const bufferPx =
      Number(await canvas.getAttribute("width")) * Number(await canvas.getAttribute("height"));
    expect(bufferPx).toBeLessThanOrEqual(2 ** 25);
    expect(
      Math.max(
        Number(await canvas.getAttribute("width")),
        Number(await canvas.getAttribute("height")),
      ),
    ).toBeLessThanOrEqual(8192);

    // Zoom still works at dpr 2 and respects the caps.
    await $("[data-testid=pdf-zoom-in]").click();
    await browser.waitUntil(async () => (await textOf("pdf-zoom-level")).includes("150%"), {
      timeout: 30000,
      timeoutMsg: "hidpi: zoom in never applied",
    });
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) > Math.floor(612 * fit * dpr),
      { timeout: 30000, timeoutMsg: "hidpi: zoom never re-rendered a larger buffer" },
    );
    const zoomedPx =
      Number(await canvas.getAttribute("width")) * Number(await canvas.getAttribute("height"));
    expect(zoomedPx).toBeLessThanOrEqual(2 ** 25);

    await returnToLibrary();
  });

  it("survives rapid page transitions in a large document at dpr 2", async () => {
    await openInReader("A Large Fixture (PDF)");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await browser.waitUntil(
      async () => /Page \d+ of 100/.test(await textOf("pdf-page-indicator")),
      {
        timeout: 30000,
        timeoutMsg: "hidpi: large fixture never reported its page count",
      },
    );

    // Rapid down/up sweep across a third of the document: every stop must
    // render, and the active canvas set must stay bounded the whole time.
    const stops = [10, 25, 40, 55, 40, 25, 10];
    for (const page of stops) {
      await scrollToSlot(page);
      await waitForRendered(page, 60000);
      expect(await renderedCount()).toBeLessThan(RENDER_BUDGET_LIMIT);
    }
    const memory = await pdfSurfaceMemory();
    const onePage = await maxSingleBitmapBytes(1);
    expect(memory.pageCanvases).toBeLessThanOrEqual(8);
    expect(memory.pageBytes).toBeLessThanOrEqual(8 * onePage);

    await returnToLibrary();
  });

  it("initializes the EPUB engine and reports progression at dpr 2", async () => {
    await openInReader("A Minimal Book (EPUB)");
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30000, timeoutMsg: "hidpi: epub engine never became ready" },
    );
    await browser.waitUntil(async () => /^(100|[1-9]?\d)%$/.test(await textOf("reader-position")), {
      timeout: 30000,
      timeoutMsg: "hidpi: epub progression never reported a percentage",
    });
    expect(await $("[data-testid=epub-error]").isExisting()).toBe(false);
    await returnToLibrary();
  });
});
