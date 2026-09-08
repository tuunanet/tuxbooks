import {
  canvasIsNonBlank,
  epubSectionTotal,
  openInReader,
  returnToLibrary,
  textOf,
  waitForPdfEngineState,
} from "./helpers.js";
/**
 * Engine smoke tests (docs/testing.md): small, fast, deterministic proofs
 * that each renderer actually initialized end to end — application up,
 * document open, engine initialized, metadata/geometry available, visible
 * content rendered, location/progression available. They run before the
 * deeper reader suites so a broken engine or asset fails quickly and
 * clearly instead of surfacing as a dozen downstream timeouts.
 *
 * The chains are asserted through the format-agnostic reader seam (stable
 * DOM attributes, docs/epub.md + docs/pdf.md), so they keep proving the same
 * initialization contract when the engines are swapped (foliate → Readium,
 * pdf.js → MuPDF.js) in migration phases 3–4.
 */

describe("tuxbooks engine smoke (EPUB)", () => {
  it("initializes the EPUB engine and reports metadata and progression", async () => {
    // Metadata: the library imported and indexed the book — its card (built
    // from the parsed publication metadata) is present and opens a detail
    // view that names the title and format.
    await openInReader("A Minimal Book (EPUB)");

    // Engine initialized: the host mounts and the engine reports ready.
    await $("div[data-epub-host]").waitForExist({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30000, timeoutMsg: "EPUB engine never became ready" },
    );

    // Publication structure: a spine with the three fixture chapters.
    const total = await epubSectionTotal();
    expect(Number(total)).toBeGreaterThanOrEqual(3);

    // Location/progression available: the shell reports a percentage and
    // the engine reports its exact locator (data-epub-locator).
    await browser.waitUntil(async () => /^(100|[1-9]?\d)%$/.test(await textOf("reader-position")), {
      timeout: 30000,
      timeoutMsg: "EPUB progression never reported a percentage",
    });
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          document
            .querySelector("[data-testid=epub-reader] [data-epub-host]")
            ?.hasAttribute("data-epub-locator"),
        )) === true,
      { timeout: 30000, timeoutMsg: "EPUB engine never reported a locator" },
    );

    // Visible content rendered: no engine error surface, and the reader
    // surface is on screen (an engine that failed to load content shows
    // data-testid=epub-error instead).
    expect(await $("[data-testid=epub-error]").isExisting()).toBe(false);
    await expect($("[data-testid=reader-view]")).toBeDisplayed();

    await returnToLibrary();
  });
});

describe("tuxbooks engine smoke (PDF)", () => {
  it("initializes the PDF engine, renders page 1, navigates, and zooms", async () => {
    await openInReader("A Minimal Manual (PDF)");

    // Engine lifecycle: the deterministic stage attribute reaches
    // "interactive" (document parsed → layout ready → position restored).
    await waitForPdfEngineState("interactive");

    // WASM/worker assets: the worker script the engine configured is
    // reachable through the app's resource path (a packaged build that
    // loses its assets fails here, not visually).
    const workerSrc = await browser.execute(
      () =>
        document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-worker-src") ??
        null,
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

    // First page rendered: geometry reported and pixels on the canvas.
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "PDF engine never reported the fixture page count",
    });
    expect(await canvasIsNonBlank(1)).toBe(true);

    // Page navigation works in both directions.
    await $("[data-testid=pdf-next]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 2 of 3", {
      timeout: 30000,
      timeoutMsg: "smoke: next page never rendered",
    });
    await $("[data-testid=pdf-prev]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "smoke: previous page never rendered",
    });

    // Zoom works: the level indicator changes and the backing store grows
    // with it (fit-width × zoom × dpr).
    const widthBefore = Number(await $("[data-testid=pdf-canvas]").getAttribute("width"));
    await $("[data-testid=pdf-zoom-in]").click();
    await browser.waitUntil(async () => (await textOf("pdf-zoom-level")).includes("150%"), {
      timeout: 30000,
      timeoutMsg: "smoke: zoom in never applied",
    });
    await browser.waitUntil(
      async () => Number(await $("[data-testid=pdf-canvas]").getAttribute("width")) > widthBefore,
      { timeout: 30000, timeoutMsg: "smoke: zoom never re-rendered a larger buffer" },
    );
    await $("[data-testid=pdf-zoom-out]").click();

    await returnToLibrary();
  });
});
