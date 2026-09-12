import { expect, test } from "../fixtures/electron-app.js";

import {
  firstPdfCanvas,
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
 * initialization contract when the engines are swapped (Readium, MuPDF.js).
 */

test.describe("tuxbooks engine smoke (EPUB)", () => {
  test("initializes the EPUB engine and reports metadata and progression", async ({ page }) => {
    // Metadata: the library imported and indexed the book — its card (built
    // from the parsed publication metadata) is present and opens a detail
    // view that names the title and format.
    await openInReader(page, "A Minimal Book (EPUB)");

    // Engine initialized: the host mounts and the engine reports ready.
    const host = page.locator("div[data-epub-host]");
    await host.waitFor({ state: "attached", timeout: 30000 });
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });

    // Publication structure: a spine with the three fixture chapters.
    const total = await epubSectionTotal(page);
    expect(Number(total)).toBeGreaterThanOrEqual(3);

    // Location/progression available: the shell reports a percentage and
    // the engine reports its exact locator (data-epub-locator).
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

    // Visible content rendered: no engine error surface, and the reader
    // surface is on screen (an engine that failed to load content shows
    // data-testid=epub-error instead).
    await expect(page.getByTestId("epub-error")).toHaveCount(0);
    await expect(page.getByTestId("reader-view")).toBeVisible();

    await returnToLibrary(page);
  });
});

test.describe("tuxbooks engine smoke (PDF)", () => {
  test("initializes the PDF engine, renders page 1, navigates, and zooms", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");

    // Engine lifecycle: the deterministic stage attribute reaches
    // "interactive" (document parsed → layout ready → position restored).
    await waitForPdfEngineState(page, "interactive");

    // WASM/worker assets: the worker script the engine configured is
    // reachable through the app's resource path (a packaged build that
    // loses its assets fails here, not visually).
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

    // First page rendered: geometry reported and pixels on the canvas.
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });
    expect(await canvasIsNonBlank(page, 1)).toBe(true);

    // Page navigation works in both directions.
    await page.getByTestId("pdf-next").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await page.getByTestId("pdf-prev").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    // Zoom works: the level indicator changes and the backing store grows
    // with it (fit-width × zoom × dpr).
    const canvas = firstPdfCanvas(page);
    const widthBefore = Number(await canvas.getAttribute("width"));
    await page.getByTestId("pdf-zoom-in").click();
    await expect(page.getByTestId("pdf-zoom-level")).toContainText("150%", { timeout: 30000 });
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBeGreaterThan(widthBefore);
    await page.getByTestId("pdf-zoom-out").click();

    await returnToLibrary(page);
  });
});
