import { expect, test } from "../fixtures/electron-app.js";

import {
  canvasIsNonBlank,
  epubSectionTotal,
  openInReader,
  returnToLibrary,
  textOf,
  waitForPdfEngineState,
} from "./helpers.js";
/**
 * Engine smoke tests (docs/TESTING.md): small, fast, deterministic proofs
 * that each renderer actually initialized end to end — application up,
 * document open, engine initialized, metadata/geometry available, visible
 * content rendered, location/progression available. They run before the
 * deeper reader suites so a broken engine or asset fails quickly and
 * clearly instead of surfacing as a dozen downstream timeouts.
 *
 * The chains are asserted through the format-agnostic reader seam (stable
 * DOM attributes, docs/EPUB.md + docs/PDF.md), so they keep proving the same
 * initialization contract when the engines are swapped (Readium, PDFium).
 */

test.describe("tuxbooks engine smoke (EPUB)", () => {
  test("initializes the EPUB engine and reports metadata and progression", async ({ page }) => {
    await openInReader(page, "A Minimal Book (EPUB)");

    const host = page.locator("div[data-epub-host]");
    await host.waitFor({ state: "attached", timeout: 30000 });
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });

    const total = await epubSectionTotal(page);
    expect(Number(total)).toBeGreaterThanOrEqual(3);

    await expect
      .poll(() => textOf(page, "reader-position"), { timeout: 30000 })
      .toMatch(/^(100|[1-9]?\d)%$/);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document
              .querySelector("[data-testid=epub-reader] [data-epub-host]")
              ?.hasAttribute("data-epub-locator"),
          ),
        { timeout: 30000 },
      )
      .toBe(true);

    await expect(page.getByTestId("epub-error")).toHaveCount(0);
    await expect(page.getByTestId("reader-view")).toBeVisible();

    await returnToLibrary(page);
  });
});

test.describe("tuxbooks engine smoke (PDF)", () => {
  test("initializes the PDF engine, renders page 1, navigates, and zooms", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");

    await waitForPdfEngineState(page, "interactive");

    const workerSrc = await page.evaluate(
      () =>
        document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-worker-src") ??
        null,
    );
    expect(workerSrc).toBeTruthy();
    const workerReachable = await page.evaluate(async (src) => {
      try {
        if (typeof src !== "string") return false;
        const response = await fetch(src);
        return response.ok;
      } catch {
        return false;
      }
    }, workerSrc);
    expect(workerReachable).toBe(true);

    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });
    expect(await canvasIsNonBlank(page, 1)).toBe(true);

    await page.getByTestId("pdf-next").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await page.getByTestId("pdf-prev").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    // Zoom is a ladder from the fit scale: in snaps up a rung, out steps back.
    const canvas = page.locator('[data-testid=pdf-canvas][data-pdf-page="1"]');
    // Wait for page 1's raster: the canvas list can lead with a stale page.
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBeGreaterThan(0);
    const widthBefore = Number(await canvas.getAttribute("width"));
    const levelBefore = await page.getByTestId("pdf-zoom-input").inputValue();
    await page.getByTestId("pdf-zoom-in").click();
    await expect(page.getByTestId("pdf-zoom-input")).not.toHaveValue(levelBefore, {
      timeout: 30000,
    });
    const levelZoomed = await page.getByTestId("pdf-zoom-input").inputValue();
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBeGreaterThan(widthBefore);
    await page.getByTestId("pdf-zoom-out").click();
    await expect(page.getByTestId("pdf-zoom-input")).not.toHaveValue(levelZoomed, {
      timeout: 30000,
    });
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBeLessThanOrEqual(widthBefore);

    await returnToLibrary(page);
  });
});
