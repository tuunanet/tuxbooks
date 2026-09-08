import { expect, test } from "../fixtures/electron-app.js";

import {
  firstPdfCanvas,
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

test.describe("tuxbooks high-DPI configuration (devicePixelRatio 2)", () => {
  test("launches with the forced scale factor", async ({ page }) => {
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    expect(dpr).toBe(2);
  });

  test("renders PDF pages at the doubled backing store within the buffer caps", async ({
    page,
  }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    // Geometry mirrors the default-run contract, times dpr 2.
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const fit = await fitFactor(page);
    await expect
      .poll(async () => Number(await canvas.getAttribute("width")), { timeout: 30000 })
      .toBe(Math.floor(612 * fit * dpr));
    expect(await canvasIsNonBlank(page, 1)).toBe(true);

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
    await page.getByTestId("pdf-zoom-in").click();
    await expect(page.getByTestId("pdf-zoom-level")).toContainText("150%", { timeout: 30000 });
    await expect
      .poll(async () => Number(await canvas.getAttribute("width")), { timeout: 30000 })
      .toBeGreaterThan(Math.floor(612 * fit * dpr));
    const zoomedPx =
      Number(await canvas.getAttribute("width")) * Number(await canvas.getAttribute("height"));
    expect(zoomedPx).toBeLessThanOrEqual(2 ** 25);

    await returnToLibrary(page);
  });

  test("survives rapid page transitions in a large document at dpr 2", async ({ page }) => {
    await openInReader(page, "A Large Fixture (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 100", {
      timeout: 30000,
    });

    // Rapid down/up sweep across a third of the document: every stop must
    // render, and the active canvas set must stay bounded the whole time.
    const stops = [10, 25, 40, 55, 40, 25, 10];
    for (const page_number of stops) {
      await scrollToSlot(page, page_number);
      await waitForRendered(page, page_number, 60000);
      expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);
    }
    const memory = await pdfSurfaceMemory(page);
    const onePage = await maxSingleBitmapBytes(page, 1);
    expect(memory.pageCanvases).toBeLessThanOrEqual(8);
    expect(memory.pageBytes).toBeLessThanOrEqual(8 * onePage);

    await returnToLibrary(page);
  });

  test("initializes the EPUB engine and reports progression at dpr 2", async ({ page }) => {
    await openInReader(page, "A Minimal Book (EPUB)");
    const host = page.locator("div[data-epub-host]");
    await host.waitFor({ state: "attached", timeout: 30000 });
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await expect
      .poll(() => textOf(page, "reader-position"), { timeout: 30000 })
      .toMatch(/^(100|[1-9]?\d)%$/);
    await expect(page.getByTestId("epub-error")).toHaveCount(0);
    await returnToLibrary(page);
  });
});
