import fs from "node:fs";
import path from "node:path";

import { expect, test, type ElectronApplication, type Page } from "../fixtures/electron-app.js";
import { artifactsDir } from "../setup/environment.js";

import {
  firstPdfCanvas,
  bitmapCacheUsage,
  canvasIsNonBlank,
  currentPageNumber,
  epubHostCount,
  maxSingleBitmapBytes,
  openInReader,
  pdfSurfaceMemory,
  renderedCount,
  returnToLibrary,
  scrollToSlot,
  waitForRendered,
} from "./helpers.js";

/**
 * Milestone 9 reader-lifecycle hardening, on the real binary: document
 * switching (including across formats), rapid repeated open/close, closing
 * while renders are in flight, rapid navigation inputs, window resizes, and
 * the memory bounds behind all of it. Every reading-position expectation is
 * derived from the live indicator — the seeded library accumulates state
 * across specs, so nothing may assume a fresh book.
 */

/** Mirrors PdfBitmapCache's configured bounds (320 MiB / 8 entries). */
const CACHE_MAX_ENTRIES = 8;
const CACHE_MAX_BYTES = 320 * 1024 * 1024;

/** The bounded render budget's regression ceiling (matches pdf-reader spec). */
const RENDER_BUDGET_LIMIT = 15;

async function openLargePdf(page: Page): Promise<void> {
  await openInReader(page, "A Large Fixture (PDF)");
  await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
  await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 100", {
    timeout: 30000,
  });
}

/** Opens the EPUB and waits for the engine host to report ready. */
async function openReadyEpub(page: Page): Promise<void> {
  await openInReader(page, "A Minimal Book (EPUB)");
  const host = page.locator("div[data-epub-host]");
  await host.waitFor({ state: "attached", timeout: 30000 });
  await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
}

/** Renderer ResizeObserver-loop notifications the main process has logged. */
function resizeLoopCount(): number {
  try {
    const log = fs.readFileSync(path.join(artifactsDir, "electron-main.log"), "utf8");
    return (log.match(/ResizeObserver loop completed with undelivered notifications/g) ?? [])
      .length;
  } catch {
    return 0;
  }
}

test.describe("tuxbooks reader lifecycle hardening", () => {
  test("switches between document types without carrying state over", async ({ page }) => {
    await openReadyEpub(page);
    expect(await epubHostCount(page)).toBe(1);
    await returnToLibrary(page);

    await openInReader(page, "A Minimal Manual (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 3", {
      timeout: 30000,
    });
    expect(await epubHostCount(page)).toBe(0);
    await returnToLibrary(page);

    await openReadyEpub(page);
    expect(await epubHostCount(page)).toBe(1);
    await returnToLibrary(page);
  });

  test("survives rapid repeated open/close across books", async ({ page }) => {
    for (let round = 0; round < 2; round++) {
      await openReadyEpub(page);
      await returnToLibrary(page);
      await openInReader(page, "A Minimal Manual (PDF)");
      await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
      await returnToLibrary(page);
    }

    await openLargePdf(page);
    const page_number = await currentPageNumber(page);
    expect(page_number).not.toBeNull();
    await waitForRendered(page, page_number!);
    expect(await canvasIsNonBlank(page, page_number!)).toBe(true);
    expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);
    await returnToLibrary(page);
  });

  test("recovers from closing the reader while pages are still rendering", async ({ page }) => {
    await openLargePdf(page);

    // Close before any render is awaited: in-flight renders must cancel and unwind.
    await scrollToSlot(page, 95);
    await returnToLibrary(page);

    await openLargePdf(page);
    const page_number = await currentPageNumber(page);
    expect(page_number).not.toBeNull();
    await waitForRendered(page, page_number!);
    expect(await canvasIsNonBlank(page, page_number!)).toBe(true);
    await returnToLibrary(page);
  });

  test("keeps canvas and cache memory bounded across repeated sessions", async ({ page }) => {
    for (let round = 0; round < 3; round++) {
      await openLargePdf(page);

      // A different deep region each round, so no session reuses the
      // previous one's canvases.
      const target = 20 + round * 25;
      await scrollToSlot(page, target);
      await waitForRendered(page, target);

      const memory = await pdfSurfaceMemory(page);
      expect(memory.pageCanvases).toBeLessThan(RENDER_BUDGET_LIMIT);
      // Live canvases are capped by policy (8), not an absolute MB count that
      // depends on window size.
      const onePageBound = await maxSingleBitmapBytes(page, 1);
      expect(memory.pageBytes).toBeLessThanOrEqual(8 * onePageBound);

      const cache = await bitmapCacheUsage(page);
      expect(cache).not.toBeNull();
      expect(cache!.entries).toBeLessThanOrEqual(CACHE_MAX_ENTRIES);
      // The byte budget allows the newest page even when oversized (no zoom here).
      expect(cache!.bytes).toBeLessThanOrEqual(CACHE_MAX_BYTES + onePageBound);

      await returnToLibrary(page);
    }

    await openReadyEpub(page);
    expect(await epubHostCount(page)).toBe(1);
    await returnToLibrary(page);
    expect(await epubHostCount(page)).toBe(0);
  });

  test("keeps rapid navigation inputs converging on a rendered page", async ({ page }) => {
    await openLargePdf(page);

    await page.keyboard.press("Home");
    await expect.poll(() => currentPageNumber(page), { timeout: 30000 }).toBe(1);
    for (let i = 0; i < 4; i++) {
      await page.getByTestId("pdf-next").click();
    }
    await expect.poll(() => currentPageNumber(page), { timeout: 30000 }).toBe(5);
    await waitForRendered(page, 5);
    expect(await canvasIsNonBlank(page, 5)).toBe(true);

    // Re-drive the final click once: a programmatic scroll can be lost under load.
    await page.getByTestId("reader-sidebar-toggle").click();
    await expect(page.getByTestId("pdf-thumbnails")).toBeVisible({ timeout: 30000 });
    for (const target of [50, 20, 70]) {
      await page.locator(`[data-pdf-thumb-slot="${target}"] button`).click();
    }
    await page.locator('[data-pdf-thumb-slot="70"] button').click();
    await expect.poll(() => currentPageNumber(page), { timeout: 30000 }).toBe(70);
    await waitForRendered(page, 70);
    expect(await canvasIsNonBlank(page, 70)).toBe(true);

    await page.getByTestId("reader-sidebar-toggle").click();
    await page.getByTestId("pdf-thumbnails").waitFor({ state: "detached", timeout: 30000 });
    await returnToLibrary(page);
  });

  test("keeps the current page rendered through window resizes", async ({ page, electronApp }) => {
    const getBounds = (app: ElectronApplication) =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    const setBounds = (app: ElectronApplication, bounds: unknown) =>
      app.evaluate(({ BrowserWindow }, b) => {
        BrowserWindow.getAllWindows()[0]!.setBounds(b as never);
      }, bounds);

    const original = await getBounds(electronApp);
    try {
      await openLargePdf(page);
      await scrollToSlot(page, 30);
      await waitForRendered(page, 30);
      expect(await canvasIsNonBlank(page, 30)).toBe(true);

      // Shrink within the window minimum: the anchor re-lands by fraction, so 29-31.
      await setBounds(electronApp, { x: 10, y: 10, width: 860, height: 600 });
      await expect
        .poll(
          async () => {
            const page_number = await currentPageNumber(page);
            return page_number !== null && page_number >= 29 && page_number <= 31;
          },
          { timeout: 30000 },
        )
        .toBe(true);
      const page_number = (await currentPageNumber(page))!;
      await waitForRendered(page, page_number);
      expect(await canvasIsNonBlank(page, page_number)).toBe(true);
      expect(await renderedCount(page)).toBeLessThan(RENDER_BUDGET_LIMIT);
    } finally {
      // The session is shared by every spec: restore the initial geometry.
      await setBounds(electronApp, original);
    }
    await returnToLibrary(page);
  });

  test("closing an EPUB does not loop the toolkit's resize observers", async ({ page }) => {
    // Regression: without a synchronous frame detach, Chromium logs a resize loop.
    const before = resizeLoopCount();
    await openReadyEpub(page);
    await returnToLibrary(page);
    await page.waitForTimeout(1500);
    expect(resizeLoopCount() - before).toBe(0);
  });
});
