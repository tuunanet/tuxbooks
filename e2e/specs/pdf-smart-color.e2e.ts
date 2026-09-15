import { expect, test, type Page } from "../fixtures/electron-app.js";

import {
  currentPageNumber,
  firstPdfCanvas,
  openInReader,
  returnToLibrary,
  waitForRendered,
} from "./helpers.js";

/**
 * Smart PDF coloring (issue #67): the dark theme recolors document content
 * object-aware inside the MuPDF worker — dark page background, light text,
 * chroma-preserving accents — while ordinary raster images keep their
 * original colors. The smart-colors fixture carries one page per case:
 * 1 text-heavy vector page, 2 photo page, 3 scanned (DeviceGray) page,
 * 4 mixed text+small image, 5 full-bleed cover gradient, 6 white-background
 * line-art cover (chromatic accents must preserve it — the AI Engineering
 * regression).
 */

/**
 * Average luminance (0–255) of the page as the screen shows it: the canvas
 * is composited over an opaque white backing (the reader's page wrapper),
 * because in Original mode the page background is CSS, not canvas pixels —
 * the raster carries only the content. Strided over the pixel buffer.
 */
async function averageLuminance(page: Page, pageNumber: number): Promise<number> {
  return page.evaluate((target) => {
    const el = document.querySelector(`[data-testid=pdf-canvas][data-pdf-page="${target}"]`);
    if (!(el instanceof HTMLCanvasElement)) return -1;
    const ctx = el.getContext("2d");
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    let sum = 0;
    let count = 0;
    const stride = 4 * Math.max(1, Math.floor(data.length / 4 / (64 * 64)));
    for (let i = 0; i < data.length; i += stride) {
      const a = data[i + 3] / 255;
      const r = data[i] * a + 255 * (1 - a);
      const g = data[i + 1] * a + 255 * (1 - a);
      const b = data[i + 2] * a + 255 * (1 - a);
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
    }
    return count > 0 ? sum / count : -1;
  }, pageNumber);
}

/**
 * Mean composited RGB of a small patch at a normalized page position.
 * Photo/cover patches are fully opaque, so the compositing is a no-op
 * there and the value is the raster's own color.
 */
async function patchColor(
  page: Page,
  pageNumber: number,
  fx: number,
  fy: number,
): Promise<[number, number, number]> {
  return page.evaluate(
    ([target, x, y]) => {
      const el = document.querySelector(`[data-testid=pdf-canvas][data-pdf-page="${target}"]`);
      if (!(el instanceof HTMLCanvasElement)) return [-1, -1, -1];
      const ctx = el.getContext("2d");
      if (!ctx) return [-1, -1, -1];
      const px = Math.min(el.width - 5, Math.max(0, Math.floor(el.width * x) - 2));
      const py = Math.min(el.height - 5, Math.max(0, Math.floor(el.height * y) - 2));
      const { data } = ctx.getImageData(px, py, 5, 5);
      let r = 0;
      let g = 0;
      let b = 0;
      const count = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        r += data[i] * a + 255 * (1 - a);
        g += data[i + 1] * a + 255 * (1 - a);
        b += data[i + 2] * a + 255 * (1 - a);
      }
      return [r / count, g / count, b / count];
    },
    [pageNumber, fx, fy] as const,
  );
}

/**
 * The slot's "rendered" state can precede the canvas actually holding
 * pixels, so every probe first waits for opaque content — every fixture
 * page paints at least some opaque ink; a blank canvas is fully
 * transparent.
 */
/** A composited patch counts as dark when its luminance is well below mid. */
function isDark(color: [number, number, number]): boolean {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2] < 100;
}

async function waitForPixels(page: Page, pageNumber: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((target) => {
          const el = document.querySelector(`[data-testid=pdf-canvas][data-pdf-page="${target}"]`);
          if (!(el instanceof HTMLCanvasElement)) return 0;
          const ctx = el.getContext("2d");
          if (!ctx) return 0;
          const { data } = ctx.getImageData(0, 0, el.width, el.height);
          let opaque = 0;
          const stride = 4 * Math.max(1, Math.floor(data.length / 4 / (64 * 64)));
          for (let i = 3; i < data.length; i += stride) {
            if (data[i] === 255) opaque += 1;
          }
          return opaque;
        }, pageNumber),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
}

async function goToPage(page: Page, pageNumber: number): Promise<void> {
  // Step one page per poll round until the indicator agrees; each click
  // moves exactly one page, so the target is reached by iteration.
  await expect
    .poll(
      async () => {
        const current = await currentPageNumber(page);
        if (current !== pageNumber && current !== null) {
          await page.getByTestId(current < pageNumber ? "pdf-next" : "pdf-prev").click();
        }
        return currentPageNumber(page);
      },
      { timeout: 30000 },
    )
    .toBe(pageNumber);
  await waitForRendered(page, pageNumber);
  await waitForPixels(page, pageNumber);
}

async function pickTheme(page: Page, label: string): Promise<void> {
  await page.getByTestId("appearance-trigger").click();
  const content = page.getByTestId("appearance-content");
  await expect(content).toBeVisible({ timeout: 30000 });
  await page.getByTestId("pref-theme").getByText(label, { exact: true }).click();
  // Close the popover so the document is fully visible again.
  await page.getByTestId("appearance-trigger").click();
}

test.describe("smart PDF coloring (issue #67)", () => {
  // One test drives the whole matrix: the mode switch must re-render every
  // case page, and the pixel probes need the fixture's geometry anyway.
  test("dark mode recolors text and scans, preserves photos and covers", async ({ page }) => {
    await openInReader(page, "Smart Colors (PDF)");
    const canvas = page.locator("[data-testid=pdf-canvas][data-pdf-page='1']");
    await canvas.waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 6", {
      timeout: 30000,
    });

    // Original-mode baseline, collected per page while that page is the one
    // rendering: white pages, a bright scanned page, and colored raster
    // content on pages 2/5 (the top of the gradient is deep blue).
    await waitForRendered(page, 1);
    await waitForPixels(page, 1);
    const originalText = await averageLuminance(page, 1);
    expect(originalText).toBeGreaterThan(180);

    await goToPage(page, 2);
    const originalPhoto = await patchColor(page, 2, 0.5, 0.2);
    expect(originalPhoto[2]).toBeGreaterThan(originalPhoto[0] + 20); // blue top

    await goToPage(page, 3);
    const originalScan = await averageLuminance(page, 3);
    expect(originalScan).toBeGreaterThan(200);

    await goToPage(page, 4);
    const originalMixed = await averageLuminance(page, 4);
    expect(originalMixed).toBeGreaterThan(180);

    await goToPage(page, 5);
    const originalCover = await patchColor(page, 5, 0.5, 0.2);
    expect(originalCover[2]).toBeGreaterThan(originalCover[0] + 20); // blue top

    await goToPage(page, 6);
    const originalLineArt = {
      average: await averageLuminance(page, 6),
      owl: await patchColor(page, 6, 0.5, 0.594), // inside the dark mass
      accent: await patchColor(page, 6, 0.2, 0.08), // the red logo bar
    };
    expect(originalLineArt.average).toBeGreaterThan(180); // paper-white cover
    expect(isDark(originalLineArt.owl)).toBe(true);
    expect(originalLineArt.accent[0]).toBeGreaterThan(150); // red

    await pickTheme(page, "Smart dark");
    // Smart dark applies no CSS filter — the recoloring is raster-level.
    await expect(page.getByTestId("pdf-document").evaluate((el) => el.style.filter)).resolves.toBe(
      "",
    );
    await waitForRendered(page, 5);
    await waitForPixels(page, 5);

    // The pending-page placeholder follows the dark palette: a page that is
    // still queued/rendering must not flash white before its bitmap blits.
    await expect
      .poll(
        () =>
          page
            .locator("[data-pdf-page-wrapper='5']")
            .evaluate((el) => getComputedStyle(el).backgroundColor),
        { timeout: 30000 },
      )
      .toBe("rgb(16, 16, 19)");

    // Page 5 (cover): recognizable — the same colors as the original
    // render (same scale, deterministic raster), and not inverted.
    const smartCover = await patchColor(page, 5, 0.5, 0.2);
    expect(Math.abs(smartCover[0] - originalCover[0])).toBeLessThanOrEqual(6);
    expect(Math.abs(smartCover[1] - originalCover[1])).toBeLessThanOrEqual(6);
    expect(Math.abs(smartCover[2] - originalCover[2])).toBeLessThanOrEqual(6);
    expect(await averageLuminance(page, 5)).toBeLessThan(200);

    // Page 1 (text-heavy): the white page becomes a dark document
    // background with light text.
    await goToPage(page, 1);
    const smartText = await averageLuminance(page, 1);
    expect(smartText).toBeLessThan(100);
    expect(smartText).toBeLessThan(originalText / 2);

    // Page 2 (photo): the gradient keeps its colors — byte-close to the
    // original render — while the page around it went dark.
    await goToPage(page, 2);
    const smartPhoto = await patchColor(page, 2, 0.5, 0.2);
    expect(Math.abs(smartPhoto[0] - originalPhoto[0])).toBeLessThanOrEqual(6);
    expect(Math.abs(smartPhoto[1] - originalPhoto[1])).toBeLessThanOrEqual(6);
    expect(Math.abs(smartPhoto[2] - originalPhoto[2])).toBeLessThanOrEqual(6);
    expect(await averageLuminance(page, 2)).toBeLessThan(140);

    // Page 3 (scanned): the paper-white scan gets a usable dark treatment
    // instead of staying a bright page.
    await goToPage(page, 3);
    const smartScan = await averageLuminance(page, 3);
    expect(smartScan).toBeLessThan(120);
    expect(smartScan).toBeLessThan(originalScan / 2);

    // Page 4 (mixed): text darkens, small illustration keeps its colors —
    // the page reads dark overall.
    await goToPage(page, 4);
    expect(await averageLuminance(page, 4)).toBeLessThan(120);

    // Page 6 (white-background line-art cover): the chromatic-accent rule
    // preserves it — still a bright page, its dark mass stays dark (not
    // luminance-flipped into a ghost) and the red accent stays red.
    await goToPage(page, 6);
    expect(await averageLuminance(page, 6)).toBeGreaterThan(180);
    const smartLineArtOwl = await patchColor(page, 6, 0.5, 0.594);
    expect(isDark(smartLineArtOwl)).toBe(true);
    const smartLineArtAccent = await patchColor(page, 6, 0.2, 0.08);
    expect(smartLineArtAccent[0]).toBeGreaterThan(150);

    await returnToLibrary(page);
  });

  test("keeps the explicit full-page inversion available", async ({ page }) => {
    await openInReader(page, "Smart Colors (PDF)");
    // The reader restores wherever the previous test left off — any
    // rendered page serves the filter check.
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });

    await pickTheme(page, "Invert");
    await expect
      .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.filter), {
        timeout: 30000,
      })
      .toBe("invert(1) hue-rotate(180deg)");

    await returnToLibrary(page);
  });
});
