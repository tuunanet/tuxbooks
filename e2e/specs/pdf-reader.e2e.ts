import { expect, test, type Page } from "../fixtures/electron-app.js";

import {
  firstPdfCanvas,
  bitmapCacheUsage,
  canvasIsNonBlank,
  clickUntilEffect,
  closeReaderNavigation,
  currentPageNumber,
  fitFactor,
  maxSingleBitmapBytes,
  openInReader,
  openReaderNavigation,
  openReaderTab,
  renderedCount,
  returnToLibrary,
  scrollToSlot,
  scrollThumbnailsToBottom,
  slotStates,
  textOf,
  thumbnailCanvasCount,
  thumbnailIsActive,
  thumbnailState,
  waitForRendered,
} from "./helpers.js";

test.describe("tuxbooks continuous PDF reader", () => {
  // Virtualization on the 100-page fixture: the whole document reserves
  // geometry, but only a bounded set of pages may own canvases at any time.
  // The upper bound is a regression guard against rendering the entire
  // document — not an exact contract.
  const RENDER_BUDGET_LIMIT = 15;
  const THUMBNAIL_BUDGET_LIMIT = 20;

  async function openLargeFixture(page: Page): Promise<void> {
    await openInReader(page, "A Large Fixture (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    // The document may restore to a previously read page (persistence), so
    // only the page count itself is a stable expectation here.
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 100", {
      timeout: 30000,
    });
  }

  test("renders the minimal fixture with working page navigation", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    // Deterministic geometry: pages render fit-to-width times the zoom
    // multiplier, times the device pixel ratio for the backing store.
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const fit = await fitFactor(page);
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBe(Math.floor(612 * fit * dpr));
    expect(await canvasIsNonBlank(page, 1)).toBe(true);

    await page.getByTestId("pdf-next").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await page.getByTestId("pdf-prev").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    await returnToLibrary(page);
  });

  // Okular-style zoom control: an editable percentage plus a presets
  // dropdown (fit modes and percentages) replace the fixed ladder.
  test("zooms to a typed percentage and a dropdown preset", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });
    const toolbar = page.getByTestId("pdf-toolbar");
    const input = page.getByTestId("pdf-zoom-input");
    const widthAtFit = Number(await canvas.getAttribute("width"));

    // A typed percentage becomes the zoom (the field reports the effective
    // scale, so 250 reads back as "250").
    await input.fill("250");
    await input.press("Enter");
    await expect(input).toHaveValue("250");
    await expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "custom");
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBeGreaterThan(widthAtFit);

    // An unparseable value leaves the current zoom in place.
    await input.fill("abc");
    await input.press("Enter");
    await expect(input).toHaveValue("250");

    // The dropdown's fit entries switch the mode back.
    await page.getByTestId("pdf-zoom-menu").click();
    await page.getByTestId("pdf-zoom-fit-width").click();
    await expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "fit-width");

    await returnToLibrary(page);
  });

  // Smooth Ctrl+wheel zoom: while the wheel turns, the scale only PREVIEWS —
  // a CSS transform on the document element with the toolbar tracking it
  // live, no canvas re-render — and the sharp raster commits once the wheel
  // settles. Deterministic DOM contract; no timing assertions.
  test("previews Ctrl+wheel zoom and commits it after the wheel settles", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });
    const input = page.getByTestId("pdf-zoom-input");
    const widthBefore = Number(await canvas.getAttribute("width"));
    const percentBefore = await input.inputValue();

    // Gesture over the page surface: one notch in.
    const box = await page.getByTestId("reader-content").boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);

    // The preview is visible immediately: the toolbar percentage moved off
    // the fit value, the document element carries the transform, and no
    // canvas re-render happened (the backing store keeps its fit geometry).
    await expect(input).not.toHaveValue(percentBefore);
    await expect
      .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.transform))
      .toContain("scale(");
    expect(Number(await canvas.getAttribute("width"))).toBe(widthBefore);

    // Settle: the transform clears and the page rasterizes sharp at the
    // previewed scale.
    await page.keyboard.up("Control");
    await expect
      .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.transform), {
        timeout: 30000,
      })
      .toBe("");
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBeGreaterThan(widthBefore);
    expect(await canvasIsNonBlank(page, 1)).toBe(true);

    await returnToLibrary(page);
  });

  // Viewport clipping above the whole-page budget (deep zoom): the canvas
  // rasterizes only the visible region and never allocates a page-sized
  // buffer. The region ratio is capped by the whole-page budget (ADR 0004),
  // so at deep zoom it can be below device resolution and the region buffer
  // smaller than the CSS region. Deterministic DOM contract; no timing
  // assertions.
  test("rasterizes only the visible region above the whole-page budget", async ({ page }) => {
    await openInReader(page, "A Large Fixture (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });

    // Fit width keeps the whole-page path untouched.
    await expect(canvas).toHaveAttribute("data-pdf-render-region", "full");

    const input = page.getByTestId("pdf-zoom-input");
    await input.fill("1600");
    await input.press("Enter");
    await expect(input).toHaveValue("1600");

    // The visible page re-renders as a clipped region at device resolution.
    const region = page
      .locator(
        '[data-testid=pdf-canvas][data-pdf-render-region]:not([data-pdf-render-region="full"])',
      )
      .first();
    await expect(region).toBeVisible({ timeout: 30000 });

    // Wait for the region raster to land: until the atomic blit, the canvas
    // still carries the previous (fit-width) geometry. Assert consistency
    // against the element's own current region attribute, since the attribute
    // updates a render before the slower blit.
    await expect
      .poll(
        () =>
          region.evaluate((el) => {
            const canvas = el as HTMLCanvasElement;
            const w = Number(
              (canvas.getAttribute("data-pdf-render-region") ?? "0,0,0,0").split(",")[2],
            );
            return canvas.style.width === `${w}px` && canvas.width >= 1;
          }),
        { timeout: 30000 },
      )
      .toBe(true);

    const geometry = await region.evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const [x, y, w, h] = (canvas.getAttribute("data-pdf-render-region") ?? "")
        .split(",")
        .map(Number);
      const dpr = window.devicePixelRatio || 1;
      return {
        x,
        y,
        w,
        h,
        left: canvas.style.left,
        top: canvas.style.top,
        cssWidth: canvas.style.width,
        cssHeight: canvas.style.height,
        bufferRatio: canvas.width / w,
        dpr,
      };
    });
    expect(geometry.left).toBe(`${geometry.x}px`);
    expect(geometry.top).toBe(`${geometry.y}px`);
    expect(geometry.cssWidth).toBe(`${geometry.w}px`);
    expect(geometry.cssHeight).toBe(`${geometry.h}px`);
    // The region ratio is capped at device resolution and by the whole-page
    // budget (ADR 0004): at deep zoom it is at or below dpr, and the buffer
    // respects the PERF-1 dimension and pixel budgets.
    expect(geometry.bufferRatio).toBeLessThanOrEqual(geometry.dpr + 0.02);
    expect(geometry.bufferRatio).toBeGreaterThan(0);
    expect(Math.max(geometry.w, geometry.h)).toBeLessThanOrEqual(8192);
    expect(geometry.w * geometry.h * geometry.bufferRatio ** 2).toBeLessThanOrEqual(2 ** 25);

    // The region must carry page ink over the page background, not a sized
    // but blank or black box (a wrong clip transform, or an opaque clear,
    // bakes a uniform region). Composite over the white page wrapper.
    const stats = await region.evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext("2d");
      if (!ctx || !canvas.width || !canvas.height) return { light: -1, ink: -1 };
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let light = 0;
      let ink = 0;
      let total = 0;
      for (let i = 0; i < data.length; i += 4 * 16) {
        total += 1;
        const alpha = data[i + 3] / 255;
        const lum =
          (data[i] * alpha +
            255 * (1 - alpha) +
            data[i + 1] * alpha +
            255 * (1 - alpha) +
            data[i + 2] * alpha +
            255 * (1 - alpha)) /
          3;
        if (lum > 200) light += 1;
        else if (lum < 128) ink += 1;
      }
      return { light: light / total, ink: ink / total };
    });
    expect(stats.light).toBeGreaterThan(0.5);
    expect(stats.ink).toBeGreaterThan(0.002);

    await returnToLibrary(page);
  });

  // The appearance controls are reflow-only (issue #46 UAT): a fixed-layout
  // PDF exposes exactly the theme — applied as a CSS filter over the
  // rendered pages (the Foliate fixed-content approach) — and none of the
  // EPUB typography/layout sections that could not act on a raster page.
  test("exposes only the theme in the appearance menu", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });

    await page.getByTestId("appearance-trigger").click();
    const content = page.getByTestId("appearance-content");
    await expect(content).toBeVisible({ timeout: 30000 });

    // No reflow sections for a fixed layout.
    await expect(page.getByTestId("pref-font-size")).not.toBeAttached();
    await expect(page.getByTestId("pref-word-spacing")).not.toBeAttached();
    await expect(page.getByTestId("pref-font-family")).not.toBeAttached();
    await expect(page.getByTestId("pref-text-align")).not.toBeAttached();
    await expect(page.getByTestId("pref-layout")).not.toBeAttached();
    await expect(page.getByTestId("pref-columns")).not.toBeAttached();
    await expect(page.getByTestId("pref-page-gutter")).not.toBeAttached();

    // The theme group offers exactly the PDF color modes (issue #67):
    // Smart dark (worker-side recoloring), the explicit Invert negative,
    // and High contrast — a choice lands on the document surface.
    const theme = page.getByTestId("pref-theme");
    await expect(theme.getByText("Default", { exact: true })).toBeVisible();
    await expect(theme.getByText("Smart dark", { exact: true })).toBeVisible();
    await expect(theme.getByText("Invert", { exact: true })).toBeVisible();
    await expect(theme.getByText("High contrast", { exact: true })).toBeVisible();
    await expect(theme.getByText("Blue", { exact: true })).toBeHidden();
    await expect(page.getByTestId("pdf-document").evaluate((el) => el.style.filter)).resolves.toBe(
      "",
    );
    // Invert is the full-page negative (the old Dark recipe); Smart dark
    // applies no CSS filter — it recolors at raster time in the worker.
    await theme.getByText("Invert", { exact: true }).click();
    await expect
      .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.filter), {
        timeout: 30000,
      })
      .toBe("invert(1) hue-rotate(180deg)");
    await theme.getByText("Smart dark", { exact: true }).click();
    await expect
      .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.filter), {
        timeout: 30000,
      })
      .toBe("");

    // Paper multiplies the white pages down to the theme's paper color —
    // the tint overlay, not a filter (a filter cannot darken white) — and
    // the page/zoom controls dock into the reader header (issue #68), whose
    // chrome the themed shell paints (no app-white strip floating over the
    // tinted pages).
    await theme.getByText("Paper", { exact: true }).click();
    await expect(page.getByTestId("pdf-theme-tint")).toBeAttached();
    await expect(
      page.getByTestId("pdf-theme-tint").evaluate((el) => el.style.mixBlendMode),
    ).resolves.toBe("multiply");
    await expect(page.getByTestId("pdf-document").evaluate((el) => el.style.filter)).resolves.toBe(
      "",
    );
    await expect
      .poll(
        () =>
          page
            .getByTestId("pdf-toolbar")
            .evaluate(
              (el) => getComputedStyle(el.closest("[data-testid=reader-view]")!).backgroundColor,
            ),
        { timeout: 30000 },
      )
      .toBe("rgb(246, 240, 228)");

    // The reading surface's scrollbar thumb derives from the theme (via the
    // --reader-scrollbar-thumb custom property feeding scrollbar-color).
    await expect
      .poll(
        () =>
          page.getByTestId("reader-content").evaluate((el) => getComputedStyle(el).scrollbarColor),
        { timeout: 30000 },
      )
      .toBe("rgba(58, 51, 42, 0.4) rgba(0, 0, 0, 0)");

    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 30000 });
    await returnToLibrary(page);
  });

  // § PDF-open telemetry: the deterministic, state-only half of the open
  // timeline. The state machine must reach "interactive" through the
  // range-backed open (bytes=range); timing segments are recorded but only
  // their shape is asserted — thresholds live in the manual bench
  // (docs/PERFORMANCE.md), never in headless CI.
  test("publishes the PDF-open state timeline attributes", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const root = page.getByTestId("pdf-reader");
    await expect(root).toHaveAttribute("data-pdf-open-state", "interactive", { timeout: 30000 });
    const timing = await root.getAttribute("data-pdf-open-timing");
    expect(timing).toMatch(/^bytes=range;/);
    await expect(root).toHaveAttribute("data-pdf-open-ms", /^\d+$/);
    await expect(root).toHaveAttribute("data-pdf-first-paint-ms", /^\d+$/);
    await expect(root).toHaveAttribute("data-pdf-first-page", /^\d+$/);
    await returnToLibrary(page);
  });

  test("tracks the current page while scrolling continuously", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    // Scrolling is the navigation: the anchor rule moves the current page
    // forward through the document and back without any button presses.
    await scrollToSlot(page, 2);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await scrollToSlot(page, 3);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 3 of 3", {
      timeout: 30000,
    });
    await scrollToSlot(page, 1);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    await returnToLibrary(page);
  });

  test("keeps the active canvas set bounded in a 100-page document", async ({ page }) => {
    await openLargeFixture(page);

    expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);

    // Scrolling deep must render the destination page without ever
    // exploding the number of live canvases.
    await scrollToSlot(page, 60);
    await waitForRendered(page, 60);
    expect(await textOf(page, "pdf-page-indicator")).toContain("Page");
    expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);

    // The engine worker must actually load. A silent fake-worker fallback
    // (main-thread rendering) is a classic cause of seconds-long, highly
    // variable page render times.
    const workerSrc = await page.evaluate(() =>
      document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-worker-src"),
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

    await scrollToSlot(page, 100);
    await waitForRendered(page, 100);
    expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);

    // Distant pages are evicted: slot 2's canvas is gone while its
    // geometry reservation remains as an unloaded slot.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.querySelector('[data-pdf-slot="2"]')?.getAttribute("data-render-state"),
          ),
        { timeout: 30000 },
      )
      .toBe("unloaded");

    // Rapid long-distance jumps (scrollbar-drag churn): superseded renders
    // must unwind cleanly, and the final revisit ends with a fully painted
    // canvas — no interleaved-paint fragments. The last jump is re-driven
    // once: under load one programmatic scroll of a rapid burst can be
    // dropped, and the stress target here is the render unwind, not scroll
    // coalescing. (A systematic scroll loss still fails the wait below.)
    await scrollToSlot(page, 87);
    await scrollToSlot(page, 30);
    await scrollToSlot(page, 74);
    await scrollToSlot(page, 60);
    await scrollToSlot(page, 60);
    await waitForRendered(page, 60);
    expect(await canvasIsNonBlank(page, 60)).toBe(true);

    await returnToLibrary(page);
  });

  // Milestone 9 stress: the report that motivated the render-policy rework.
  // Oscillating scroll between two pages must converge — each page, as the
  // reading anchor, renders and paints; revisited pages blit retained
  // bitmaps instead of re-running the full raster; zoom churn during the
  // same session settles cleanly. (Only the anchor page is a guaranteed
  // render-set member at fit-width geometry, so every assertion targets the
  // page currently scrolled to.)
  test("recovers rendered pages under rapid scroll oscillation and zoom churn", async ({
    page,
  }) => {
    await openLargeFixture(page);

    for (let round = 0; round < 3; round++) {
      await scrollToSlot(page, 10);
      await scrollToSlot(page, 11);
    }
    await scrollToSlot(page, 10);
    await expect.poll(() => canvasIsNonBlank(page, 10), { timeout: 30000 }).toBe(true);
    await scrollToSlot(page, 11);
    await expect.poll(() => canvasIsNonBlank(page, 11), { timeout: 30000 }).toBe(true);

    // Zoom invalidates every cached bitmap; the visible page must converge
    // to a freshly rendered canvas at the new scale.
    const levelBefore = await page.getByTestId("pdf-zoom-input").inputValue();
    await page.getByTestId("pdf-zoom-in").click();
    await expect(page.getByTestId("pdf-zoom-input")).not.toHaveValue(levelBefore, {
      timeout: 30000,
    });
    await expect.poll(() => canvasIsNonBlank(page, 11), { timeout: 30000 }).toBe(true);

    // Reverse scroll across already-visited pages: cached bitmaps make
    // re-entry cheap, and the render budget still holds at the end.
    await scrollToSlot(page, 1);
    await expect.poll(() => canvasIsNonBlank(page, 1), { timeout: 30000 }).toBe(true);
    expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);

    // Milestone 9 memory bound: after the stress, cache occupancy as
    // reported by the diagnostics attribute stays within its configured
    // budget (8 entries / 320 MiB — mirroring PdfBitmapCache's defaults;
    // sized for ≥ 2 capped 4K page buffers at BOTH reference dprs,
    // docs/PERFORMANCE.md PERF-3).
    const cache = await bitmapCacheUsage(page);
    expect(cache).not.toBeNull();
    expect(cache!.entries).toBeLessThanOrEqual(8);
    // The byte budget bounds retained memory except the newest single page
    // (oversized-keep-latest): at this point the reader sits one ladder rung
    // above its fit scale (issue #65 — at reference viewport sizes that is
    // at most 1.5× the fit factor; 2 covers the whole ladder), so one
    // dpr-scaled page bitmap is the allowed excess.
    const onePage = await maxSingleBitmapBytes(page, 2);
    expect(cache!.bytes).toBeLessThanOrEqual(320 * 1024 * 1024 + onePage);

    await returnToLibrary(page);
  });

  // Critical acceptance test (§ persistence): the reader resumes where the
  // user stopped, across close/reopen.
  test("restores the reading position when a PDF is reopened", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    // Scroll to page 2 and let the debounced save land before leaving.
    await scrollToSlot(page, 2);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await page.waitForTimeout(1500);
    await returnToLibrary(page);

    // Reopen: page 2 is restored (indicator, canvas, geometry).
    await openInReader(page, "A Minimal Manual (PDF)");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await waitForRendered(page, 2);
    expect(await canvasIsNonBlank(page, 2)).toBe(true);

    await returnToLibrary(page);
  });

  test("keeps the current page rendered when zooming deep in the document", async ({ page }) => {
    await openLargeFixture(page);

    // Jump deep via the semantic Pages drawer (not pixel coordinates). The
    // condition is the rendered state, not the indicator: right after the
    // jump the render set holds page 87, but a layout re-anchor racing the
    // drawer's exit animation can bounce the viewport back — re-driving the
    // jump converges (same retry pattern as the outline navigation).
    await page.getByTestId("reader-nav-trigger").click();
    await expect(page.getByTestId("nav-pages")).toBeVisible({ timeout: 30000 });
    await clickUntilEffect(
      page,
      "[data-testid=nav-page-87]",
      async () =>
        (await page.evaluate(() =>
          document.querySelector('[data-pdf-slot="87"]')?.getAttribute("data-render-state"),
        )) === "rendered",
    );

    await waitForRendered(page, 87);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 87 of 100", {
      timeout: 30000,
    });

    // Zoom rescales every slot; the current page must stay rendered and
    // visible rather than leaving a stale viewport offset (UAT regression).
    const levelBefore = await page.getByTestId("pdf-zoom-input").inputValue();
    await page.getByTestId("pdf-zoom-in").click();
    await expect(page.getByTestId("pdf-zoom-input")).not.toHaveValue(levelBefore, {
      timeout: 30000,
    });
    await waitForRendered(page, 87);
    expect(
      await page.evaluate(
        () => document.querySelector('[data-testid="pdf-canvas"][data-pdf-page="87"]') !== null,
      ),
    ).toBe(true);
    expect(await canvasIsNonBlank(page, 87)).toBe(true);
    await returnToLibrary(page);
  });

  test("lays out mixed page sizes independently without overlap", async ({ page }) => {
    await openInReader(page, "Odd Sizes (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 6", {
      timeout: 30000,
    });

    // Geometry corrects lazily as pages approach the viewport, and the fit
    // reference is the document's widest page (792pt here), not page 1's
    // 612pt. Walk the whole document once so every page is measured and the
    // fit scale settles on its final reference before the heights below are
    // read. (100% zoom = fit width; dpr = 1 under Xvfb.)
    const rawHeights = [792, 612, 1008, 500, 842, 504];
    for (let pageNumber = 1; pageNumber <= rawHeights.length; pageNumber++) {
      await scrollToSlot(page, pageNumber);
      await waitForRendered(page, pageNumber);
    }

    const fit = await fitFactor(page, 792);
    const expectedHeights = rawHeights.map((height) => Math.floor(height * fit));

    // From the top, the document shows real mixed geometry and stacks
    // strictly: each top equals the previous bottom plus the 8px page gap —
    // no overlap, no collapse (±1px for offsetHeight rounding).
    await scrollToSlot(page, 1);
    const layout = await page.evaluate(() =>
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
    expect(await renderedCount(page)).toBeLessThan(6);
    await returnToLibrary(page);
  });

  test("navigates to destinations from the document outline", async ({ page }) => {
    await openInReader(page, "A Large Fixture (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 100", {
      timeout: 30000,
    });

    await openReaderNavigation(page);
    // 15 deterministic entries (5 parts × 2 sections), flattened depth-first:
    // index 6 is "Part Three" (page 41), index 8 "Section Three-B" (page 51).
    await openReaderTab(page, "nav-tab-outline", "nav-outline-item-0");
    expect(await textOf(page, "nav-outline-item-6")).toContain("Part Three");

    await clickUntilEffect(page, "[data-testid=nav-outline-item-6]", async () =>
      (await textOf(page, "pdf-page-indicator")).includes("Page 41 of 100"),
    );
    await waitForRendered(page, 41);
    // Selecting an entry closes the drawer; wait out the exit animation so
    // the fading sheet overlay cannot swallow the header clicks below.
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

    // A nested entry resolves to its own destination, not its parent's.
    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-outline", "nav-outline-item-8");
    await clickUntilEffect(page, "[data-testid=nav-outline-item-8]", async () =>
      (await textOf(page, "pdf-page-indicator")).includes("Page 51 of 100"),
    );
    await waitForRendered(page, 51);
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

    await returnToLibrary(page);
  });

  test("shows an empty outline state for documents without one", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    // The document may restore a previously read page (persistence), so only
    // the page count itself is a stable expectation here.
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 3", {
      timeout: 30000,
    });

    await page.getByTestId("reader-nav-trigger").click();
    await openReaderTab(page, "nav-tab-outline", "nav-outline-empty");
    expect(await textOf(page, "nav-outline-empty")).toContain("no outline");

    // Close the drawer before leaving: the sheet overlay covers the header.
    await page.keyboard.press("Escape");
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

    await returnToLibrary(page);
  });

  test("navigates with virtualized thumbnails in a bounded sidebar", async ({ page }) => {
    await openLargeFixture(page);

    await page.getByTestId("reader-sidebar-toggle").click();
    await expect(page.getByTestId("pdf-thumbnails")).toBeVisible({ timeout: 30000 });

    // The reading page is indicated without any interaction — whichever page
    // the reader restored to, its thumbnail is marked active.
    const restoredPage = Number(
      (await textOf(page, "pdf-page-indicator")).match(/Page (\d+) of 100/)?.[1],
    );
    expect(restoredPage).toBeGreaterThanOrEqual(1);
    await expect.poll(() => thumbnailIsActive(page, restoredPage), { timeout: 30000 }).toBe(true);

    // Clicking a thumbnail navigates the document (the whole list reserves
    // cells up front, so the target exists even while far out of view).
    await page.locator('[data-pdf-thumb-slot="50"] button').click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 50 of 100", {
      timeout: 30000,
    });
    await waitForRendered(page, 50);
    expect(await thumbnailIsActive(page, 50)).toBe(true);
    expect(await thumbnailCanvasCount(page)).toBeLessThan(THUMBNAIL_BUDGET_LIMIT);

    // Scrolling the sidebar deep renders destination thumbnails and still
    // never mounts the whole document as bitmaps.
    await scrollThumbnailsToBottom(page);
    await expect.poll(() => thumbnailState(page, 100), { timeout: 30000 }).toBe("rendered");
    expect(await thumbnailCanvasCount(page)).toBeLessThan(THUMBNAIL_BUDGET_LIMIT);

    // Current-page synchronization: scrolling the document moves the
    // highlight (and brings the page's thumbnail into view and rendered).
    await scrollToSlot(page, 70);
    await expect.poll(() => thumbnailIsActive(page, 70), { timeout: 30000 }).toBe(true);
    await expect.poll(() => thumbnailState(page, 70), { timeout: 30000 }).toBe("rendered");
    expect(await canvasIsNonBlank(page, 70, "pdf-thumbnail")).toBe(true);

    // Closing the sidebar unmounts the thumbnails with it.
    await page.getByTestId("reader-sidebar-toggle").click();
    await page.getByTestId("pdf-thumbnails").waitFor({ state: "detached", timeout: 30000 });

    await returnToLibrary(page);
  });

  // Milestone 5 — in-book search: page text comes from the engine through
  // the seam; picking a match navigates to its page.
  test("finds page text and navigates to the matching page", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    // Earlier specs leave the book's saved position past page 1, and the
    // reader restores it before the surface mounts — so wait for the
    // document slots, then navigate to page 1 explicitly before waiting
    // for its render.
    await expect
      .poll(async () => (await slotStates(page)).length, { timeout: 30000 })
      .toBeGreaterThan(0);
    await scrollToSlot(page, 1);
    await waitForRendered(page, 1);

    await page.getByTestId("reader-search").click();
    const searchInput = page.getByTestId("reader-search-input");
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    // "Page 2 of 3" exists only on page 2 of the fixture.
    await searchInput.fill("Page 2 of 3");

    await expect(page.getByTestId("reader-search-match").first()).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("reader-search-status")).toContainText("1 match", {
      timeout: 30000,
    });
    const resultsText = await page.evaluate(
      () => document.querySelector("[data-testid=reader-search-results]")?.textContent ?? "",
    );
    expect(resultsText).toContain("Page 2");

    // Clicking the match navigates to page 2; the drawer stays open.
    await page.getByTestId("reader-search-match").click();
    await expect.poll(() => currentPageNumber(page), { timeout: 30000 }).toBe(2);
    await expect(page.getByTestId("reader-nav")).toBeVisible();

    await closeReaderNavigation(page);
    await returnToLibrary(page);
  });
});
