import { expect, test, type Page } from "../fixtures/electron-app.js";

import {
  firstPdfCanvas,
  bitmapCacheUsage,
  canvasIsNonBlank,
  clickUntilEffect,
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
  // Upper bound on live canvases; a regression guard, not an exact contract.
  const RENDER_BUDGET_LIMIT = 15;
  const THUMBNAIL_BUDGET_LIMIT = 20;

  async function openLargeFixture(page: Page): Promise<void> {
    await openInReader(page, "A Large Fixture (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
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

  test("jumps to a typed page in the reader toolbar", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    const input = page.getByTestId("pdf-page-input");
    await input.fill("2");
    await input.press("Enter");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await waitForRendered(page, 2);
    expect(await canvasIsNonBlank(page, 2)).toBe(true);

    await returnToLibrary(page);
  });

  test("clamps an out-of-range typed page to the last page", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    const input = page.getByTestId("pdf-page-input");
    await input.fill("99");
    await input.press("Enter");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 3 of 3", {
      timeout: 30000,
    });
    await expect(input).toHaveValue("3");

    await returnToLibrary(page);
  });

  test("zooms to a typed percentage and a dropdown preset", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });
    const toolbar = page.getByTestId("pdf-toolbar");
    const input = page.getByTestId("pdf-zoom-input");
    const widthAtFit = Number(await canvas.getAttribute("width"));

    await input.fill("250");
    await input.press("Enter");
    await expect(input).toHaveValue("250");
    await expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "custom");
    await expect
      .poll(() => canvas.getAttribute("width").then(Number), { timeout: 30000 })
      .toBeGreaterThan(widthAtFit);

    await input.fill("abc");
    await input.press("Enter");
    await expect(input).toHaveValue("250");

    await page.getByTestId("pdf-zoom-menu").click();
    await page.getByTestId("pdf-zoom-fit-width").click();
    await expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "fit-width");

    await returnToLibrary(page);
  });

  test("previews Ctrl+wheel zoom and commits it after the wheel settles", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });
    // The width attribute is 0 until the first raster lands; wait for it or the baseline reads stale.
    await waitForRendered(page, 1);
    const input = page.getByTestId("pdf-zoom-input");
    const widthBefore = Number(await canvas.getAttribute("width"));
    const percentBefore = await input.inputValue();

    const box = await page.getByTestId("reader-content").boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);

    await expect(input).not.toHaveValue(percentBefore);
    await expect
      .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.transform))
      .toContain("scale(");
    expect(Number(await canvas.getAttribute("width"))).toBe(widthBefore);

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

  test("centers the PDF title and hides the presentation bar until hover", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });

    const centers = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>("[data-testid=reader-title]")!;
      const header = document.querySelector<HTMLElement>("header")!;
      const t = title.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      return { title: t.left + t.width / 2, header: h.left + h.width / 2 };
    });
    expect(Math.abs(centers.title - centers.header)).toBeLessThanOrEqual(2);

    await page.keyboard.press("Control+l");
    const bar = page.getByTestId("pdf-presentation-bar");
    await expect(bar).toBeVisible({ timeout: 10000 });
    expect(Number(await bar.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.1);
    await bar.hover();
    await expect.poll(() => bar.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    await page.getByTestId("pdf-pres-exit").click();
    await returnToLibrary(page);
  });

  test("jumps to a typed page in the presentation bar", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    await page.keyboard.press("Control+l");
    const bar = page.getByTestId("pdf-presentation-bar");
    await expect(bar).toBeVisible({ timeout: 10000 });
    await bar.hover();

    const input = bar.getByTestId("pdf-page-input");
    await input.fill("3");
    await input.press("Enter");
    await expect(bar.getByTestId("pdf-page-indicator")).toHaveText("Page 3 of 3", {
      timeout: 10000,
    });
    await expect.poll(() => canvasIsNonBlank(page, 3), { timeout: 10000 }).toBe(true);

    await page.getByTestId("pdf-pres-exit").click();
    await returnToLibrary(page);
  });

  test("resumes on the presented page after leaving presentation mode", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    await page.keyboard.press("Control+l");
    const bar = page.getByTestId("pdf-presentation-bar");
    await expect(bar).toBeVisible({ timeout: 10000 });
    const input = bar.getByTestId("pdf-page-input");
    await input.fill("3");
    await input.press("Enter");
    await expect(bar.getByTestId("pdf-page-indicator")).toHaveText("Page 3 of 3", {
      timeout: 10000,
    });

    await page.getByTestId("pdf-pres-exit").click();
    await expect(page.getByTestId("pdf-presentation-bar")).toHaveCount(0);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 3 of 3", {
      timeout: 10000,
    });

    // Page 3's slot must sit at the top of the scroll container, not two pages down.
    const geometry = await page.evaluate(() => {
      const slot = document.querySelector('[data-pdf-slot="3"]');
      if (!slot) return null;
      let element: Element | null = slot.parentElement;
      while (element && !(element.scrollHeight > element.clientHeight + 1)) {
        element = element.parentElement;
      }
      if (!element) return null;
      return {
        top: slot.getBoundingClientRect().top - element.getBoundingClientRect().top,
        clientHeight: element.clientHeight,
      };
    });
    if (!geometry) throw new Error("presented page slot or its scroll container not found");
    expect(geometry.top).toBeLessThan(geometry.clientHeight / 2);

    await returnToLibrary(page);
  });

  // jsdom lays out nothing and cannot clamp, so this path is only provable here.
  test("returns to the entry page when presentation is left without flipping", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });
    await page.getByTestId("pdf-next").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });

    await page.keyboard.press("Control+l");
    await expect(page.getByTestId("pdf-presentation-bar")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("pdf-pres-exit").click();
    await expect(page.getByTestId("pdf-presentation-bar")).toHaveCount(0);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 10000,
    });

    await returnToLibrary(page);
  });

  test("pre-renders the next page before a presentation step", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    await page.keyboard.press("Control+l");
    await expect(page.getByTestId("pdf-presentation-bar")).toBeVisible({ timeout: 10000 });

    await expect
      .poll(
        () => page.getByTestId("pdf-reader").getAttribute("data-pdf-preload-count").then(Number),
        { timeout: 30000 },
      )
      .toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3");

    await page.getByTestId("pdf-pres-next").click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 10000,
    });
    await expect.poll(() => canvasIsNonBlank(page, 2), { timeout: 10000 }).toBe(true);

    await page.getByTestId("pdf-pres-exit").click();
    await returnToLibrary(page);
  });

  test("rasterizes only the visible region above the whole-page budget", async ({ page }) => {
    await openInReader(page, "A Large Fixture (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });

    await expect(canvas).toHaveAttribute("data-pdf-render-region", "full");

    const input = page.getByTestId("pdf-zoom-input");
    await input.fill("1600");
    await input.press("Enter");
    await expect(input).toHaveValue("1600");

    const region = page
      .locator(
        '[data-testid=pdf-canvas][data-pdf-render-region]:not([data-pdf-render-region="full"])',
      )
      .first();
    await expect(region).toBeVisible({ timeout: 30000 });

    // The region attribute updates a render before the blit, and a vertical move keeps the width, so poll both dimensions.
    await expect
      .poll(
        () =>
          region.evaluate((el) => {
            const canvas = el as HTMLCanvasElement;
            const [w, h] = (canvas.getAttribute("data-pdf-render-region") ?? "0,0,0,0")
              .split(",")
              .slice(2)
              .map(Number);
            return (
              canvas.style.width === `${w}px` &&
              canvas.style.height === `${h}px` &&
              canvas.width >= 1
            );
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
    expect(geometry.bufferRatio).toBeLessThanOrEqual(geometry.dpr + 0.02);
    expect(geometry.bufferRatio).toBeGreaterThan(0);
    expect(Math.max(geometry.w, geometry.h)).toBeLessThanOrEqual(8192);
    expect(geometry.w * geometry.h * geometry.bufferRatio ** 2).toBeLessThanOrEqual(2 ** 25);

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

  test("exposes only the theme in the appearance menu", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    const canvas = firstPdfCanvas(page);
    await canvas.waitFor({ state: "attached", timeout: 30000 });

    await page.getByTestId("appearance-trigger").click();
    const content = page.getByTestId("appearance-content");
    await expect(content).toBeVisible({ timeout: 30000 });

    await expect(page.getByTestId("pref-font-size")).not.toBeAttached();
    await expect(page.getByTestId("pref-word-spacing")).not.toBeAttached();
    await expect(page.getByTestId("pref-font-family")).not.toBeAttached();
    await expect(page.getByTestId("pref-text-align")).not.toBeAttached();
    await expect(page.getByTestId("pref-layout")).not.toBeAttached();
    await expect(page.getByTestId("pref-columns")).not.toBeAttached();
    await expect(page.getByTestId("pref-page-gutter")).not.toBeAttached();

    const theme = page.getByTestId("pref-theme");
    await expect(theme.getByText("Default", { exact: true })).toBeVisible();
    await expect(theme.getByText("Smart dark", { exact: true })).toBeVisible();
    await expect(theme.getByText("Invert", { exact: true })).toBeVisible();
    await expect(theme.getByText("High contrast", { exact: true })).toBeVisible();
    await expect(theme.getByText("Blue", { exact: true })).toBeHidden();
    await expect(page.getByTestId("pdf-document").evaluate((el) => el.style.filter)).resolves.toBe(
      "",
    );
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
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

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

    await scrollToSlot(page, 60);
    await waitForRendered(page, 60);
    expect(await textOf(page, "pdf-page-indicator")).toContain("Page");
    expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);

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

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.querySelector('[data-pdf-slot="2"]')?.getAttribute("data-render-state"),
          ),
        { timeout: 30000 },
      )
      .toBe("unloaded");

    // Under load one programmatic scroll of a burst can be dropped; the last jump is re-driven.
    await scrollToSlot(page, 87);
    await scrollToSlot(page, 30);
    await scrollToSlot(page, 74);
    await scrollToSlot(page, 60);
    await scrollToSlot(page, 60);
    await waitForRendered(page, 60);
    expect(await canvasIsNonBlank(page, 60)).toBe(true);

    await returnToLibrary(page);
  });

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

    const levelBefore = await page.getByTestId("pdf-zoom-input").inputValue();
    await page.getByTestId("pdf-zoom-in").click();
    await expect(page.getByTestId("pdf-zoom-input")).not.toHaveValue(levelBefore, {
      timeout: 30000,
    });
    await expect.poll(() => canvasIsNonBlank(page, 11), { timeout: 30000 }).toBe(true);

    await scrollToSlot(page, 1);
    await expect.poll(() => canvasIsNonBlank(page, 1), { timeout: 30000 }).toBe(true);
    expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);

    // Cache budget: 8 entries / 320 MiB plus the one oversized-keep-latest page (PERF-3).
    const cache = await bitmapCacheUsage(page);
    expect(cache).not.toBeNull();
    expect(cache!.entries).toBeLessThanOrEqual(8);
    const onePage = await maxSingleBitmapBytes(page, 2);
    expect(cache!.bytes).toBeLessThanOrEqual(320 * 1024 * 1024 + onePage);

    await returnToLibrary(page);
  });

  test("restores the reading position when a PDF is reopened", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    await scrollToSlot(page, 2);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });
    await page.waitForTimeout(1500);
    await returnToLibrary(page);

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

    const pageInput = page.getByTestId("pdf-page-input");
    await pageInput.fill("87");
    await pageInput.press("Enter");

    await waitForRendered(page, 87);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 87 of 100", {
      timeout: 30000,
    });

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

    const rawHeights = [792, 612, 1008, 500, 842, 504];
    for (let pageNumber = 1; pageNumber <= rawHeights.length; pageNumber++) {
      await scrollToSlot(page, pageNumber);
      await waitForRendered(page, pageNumber);
    }

    const fit = await fitFactor(page, 792);
    const expectedHeights = rawHeights.map((height) => Math.floor(height * fit));

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

    for (let i = 1; i < layout.length; i++) {
      expect(
        Math.abs(layout[i].top - layout[i - 1].top - (layout[i - 1].height + 8)),
      ).toBeLessThanOrEqual(1);
    }

    await expect.poll(() => renderedCount(page), { timeout: 10_000 }).toBeLessThan(6);
    await returnToLibrary(page);
  });

  test("navigates to destinations from the document outline", async ({ page }) => {
    await openInReader(page, "A Large Fixture (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 100", {
      timeout: 30000,
    });

    await openReaderNavigation(page);
    await openReaderTab(page, "nav-tab-outline", "nav-outline-item-0");
    expect(await textOf(page, "nav-outline-item-6")).toContain("Part Three");

    await clickUntilEffect(page, "[data-testid=nav-outline-item-6]", async () =>
      (await textOf(page, "pdf-page-indicator")).includes("Page 41 of 100"),
    );
    await waitForRendered(page, 41);
    // Wait out the sheet's exit animation so the fading overlay cannot swallow the header clicks.
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

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
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 3", {
      timeout: 30000,
    });

    await page.getByTestId("reader-nav-trigger").click();
    await openReaderTab(page, "nav-tab-outline", "nav-outline-empty");
    expect(await textOf(page, "nav-outline-empty")).toContain("no outline");

    await page.keyboard.press("Escape");
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

    await returnToLibrary(page);
  });

  test("navigates with virtualized thumbnails in a bounded sidebar", async ({ page }) => {
    await openLargeFixture(page);

    await page.getByTestId("reader-sidebar-toggle").click();
    await expect(page.getByTestId("pdf-thumbnails")).toBeVisible({ timeout: 30000 });

    const restoredPage = Number(
      (await textOf(page, "pdf-page-indicator")).match(/Page (\d+) of 100/)?.[1],
    );
    expect(restoredPage).toBeGreaterThanOrEqual(1);
    await expect.poll(() => thumbnailIsActive(page, restoredPage), { timeout: 30000 }).toBe(true);

    await page.locator('[data-pdf-thumb-slot="50"] button').click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 50 of 100", {
      timeout: 30000,
    });
    await waitForRendered(page, 50);
    expect(await thumbnailIsActive(page, 50)).toBe(true);
    expect(await thumbnailCanvasCount(page)).toBeLessThan(THUMBNAIL_BUDGET_LIMIT);

    await scrollThumbnailsToBottom(page);
    await expect.poll(() => thumbnailState(page, 100), { timeout: 30000 }).toBe("rendered");
    expect(await thumbnailCanvasCount(page)).toBeLessThan(THUMBNAIL_BUDGET_LIMIT);

    await scrollToSlot(page, 70);
    await expect.poll(() => thumbnailIsActive(page, 70), { timeout: 30000 }).toBe(true);
    await expect.poll(() => thumbnailState(page, 70), { timeout: 30000 }).toBe("rendered");
    expect(await canvasIsNonBlank(page, 70, "pdf-thumbnail")).toBe(true);

    await page.getByTestId("reader-sidebar-toggle").click();
    await page.getByTestId("pdf-thumbnails").waitFor({ state: "detached", timeout: 30000 });

    await returnToLibrary(page);
  });

  test("finds page text and navigates to the matching page", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    // Earlier specs leave a saved position past page 1, so scroll to page 1 before waiting for its render.
    await expect
      .poll(async () => (await slotStates(page)).length, { timeout: 30000 })
      .toBeGreaterThan(0);
    await scrollToSlot(page, 1);
    await waitForRendered(page, 1);

    await page.getByTestId("reader-search").click();
    const searchInput = page.getByTestId("reader-search-input");
    await expect(searchInput).toBeVisible({ timeout: 30000 });
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

    await page.getByTestId("reader-search-match").click();
    await expect.poll(() => currentPageNumber(page), { timeout: 30000 }).toBe(2);
    await expect(page.getByTestId("reader-search-overlay")).toBeHidden({ timeout: 30000 });

    await returnToLibrary(page);
  });
});
