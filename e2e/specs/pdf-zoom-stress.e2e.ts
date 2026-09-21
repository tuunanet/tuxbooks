import { existsSync } from "node:fs";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { benchPdfFixture } from "../setup/fixtures.js";
import {
  canvasIsNonBlank,
  firstPdfCanvas,
  openInReader,
  scrollToSlot,
  textOf,
  waitForRendered,
} from "./helpers.js";

/**
 * Zoom-churn guard for the PDF reader: roughly a minute of fast Ctrl+wheel
 * zooming out from deep zoom under Smart dark must not stall the reader or
 * crash the renderer. This loop drives the churn — Smart dark, deep zoom
 * (region rendering), rapid wheel bursts at commit cadence, wobble, scroll
 * jumps — and asserts the reader converges after every round. Renderer
 * aliveness is probed throughout: a crashed renderer rejects evaluate.
 */

/** One fast wheel burst: `notches` ctrl+wheel events, no pacing. */
async function wheelBurst(page: Page, notches: number, deltaY: number): Promise<void> {
  const box = await page.getByTestId("reader-content").boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.down("Control");
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
}

/** The renderer must still answer: a crashed renderer rejects evaluate. */
async function expectRendererAlive(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => 1), { timeout: 10_000 }).toBe(1);
}

/** Current page number from the toolbar indicator. */
async function shownPage(page: Page): Promise<number> {
  return Number((await textOf(page, "pdf-page-indicator")).match(/Page (\d+)/)?.[1]);
}

test.describe("PDF Smart dark zoom churn", () => {
  test("survives rapid Ctrl+wheel churn at deep zoom", async ({ page }) => {
    test.setTimeout(300_000);

    await openInReader(page, "A Large Fixture (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    await scrollToSlot(page, 30);
    await waitForRendered(page, 30);

    // Smart Dark: the report's theme (worker-side recoloring). The page
    // wrapper's placeholder background must flip to the theme color, or the
    // loop would exercise the plain render path instead.
    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("pref-theme").getByText("Smart dark", { exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 10_000 });
    await expect
      .poll(async () =>
        page
          .locator('[data-pdf-page-wrapper="30"]')
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .not.toBe("rgb(255, 255, 255)");

    const input = page.getByTestId("pdf-zoom-input");
    for (let round = 1; round <= 4; round++) {
      const anchor = await shownPage(page);
      // The window crosses into region rendering just above ~825%, so the
      // loop starts at the 10000% clamp and bursts down through region
      // scales — the geometry the crash report churned through.
      await input.fill("10000");
      await input.press("Enter");
      await expect(input).toHaveValue("10000");
      await waitForRendered(page, anchor, 60_000);

      // Ten 1-notch bursts at commit cadence (~260ms apart): every burst
      // settles into a commit whose re-render must coalesce rather than
      // queue a multi-second raster.
      for (let burst = 0; burst < 10; burst++) {
        await wheelBurst(page, 1, 120);
        await page.waitForTimeout(260);
        await expectRendererAlive(page);
      }

      // Scroll churn mid-churn: navigation jumps force fresh renders on
      // whichever worker is current.
      await scrollToSlot(page, Math.max(1, anchor - 2));
      await scrollToSlot(page, Math.min(100, anchor + 2));
      await expectRendererAlive(page);

      // Wobble like a real wheel user: back in, then out.
      await wheelBurst(page, 6, -120);
      await page.waitForTimeout(260);
      await wheelBurst(page, 6, 120);
      await page.waitForTimeout(500);
      await expectRendererAlive(page);

      // The gesture is over: the preview transform must be gone, then the
      // reader settles (scroll reports, re-anchor), and the page it finally
      // shows must converge to a sharp rendered canvas.
      await expect
        .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.transform), {
          timeout: 30_000,
        })
        .toBe("");
      await page.waitForTimeout(800);
      const shown = await shownPage(page);
      await waitForRendered(page, shown, 45_000);
      expect(await canvasIsNonBlank(page, shown)).toBe(true);
    }

    // The contract: the reader converges after every round and the renderer
    // survives the churn.
    await expectRendererAlive(page);
  });

  // A shading-heavy page from the fetched corpus: the reader must keep
  // converging through zoom churn on it and the renderer must stay alive.
  // Needs the fetched corpus (just fetch-ebooks); skipped when GeoTopo.pdf
  // is not on disk.
  test("converges on the GeoTopo shading page under Smart dark zoom churn", async ({ page }) => {
    if (!existsSync(benchPdfFixture)) {
      test.skip(true, "GeoTopo.pdf not fetched (just fetch-ebooks)");
    }
    test.setTimeout(300_000);
    await openInReader(page, "Geometrie und Topologie (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 117", {
      timeout: 30_000,
    });

    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("pref-theme").getByText("Smart dark", { exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 10_000 });

    await scrollToSlot(page, 35);
    await waitForRendered(page, 35, 60_000);

    // Zoom wobble across the shading page: commits re-render its region at
    // successive scales. The anchor may drift to neighbouring pages while
    // zooming (the cursor point stays fixed, the shown page can change), so
    // every round asserts on whatever page the reader finally shows.
    const input = page.getByTestId("pdf-zoom-input");
    for (let round = 1; round <= 8; round++) {
      await input.fill(round % 2 === 0 ? "10000" : "800");
      await input.press("Enter");
      await waitForRendered(page, await shownPage(page), 60_000);
      await wheelBurst(page, 5, 120);
      await page.waitForTimeout(400);
      await expectRendererAlive(page);
      await wheelBurst(page, 4, -120);
      await page.waitForTimeout(600);
      await expectRendererAlive(page);
      await expect
        .poll(() => page.getByTestId("pdf-document").evaluate((el) => el.style.transform), {
          timeout: 30_000,
        })
        .toBe("");
      await page.waitForTimeout(500);
      await waitForRendered(page, await shownPage(page), 60_000);
      process.stdout.write(`geotopo churn round ${round} survived\n`);
    }

    // The page the reader ends on must be sharp and the renderer alive.
    const shown = await shownPage(page);
    await waitForRendered(page, shown, 60_000);
    expect(await canvasIsNonBlank(page, shown)).toBe(true);
    await expectRendererAlive(page);
  });

  // With the thumbnail sidebar open and free-spin zoom over shading-heavy
  // pages 4-7, the renderer must stay alive. Needs the fetched corpus
  // (just fetch-ebooks).
  test("survives Ctrl+wheel churn over the shading pages under Smart dark", async ({ page }) => {
    if (!existsSync(benchPdfFixture)) {
      test.skip(true, "GeoTopo.pdf not fetched (just fetch-ebooks)");
    }
    test.setTimeout(180_000);
    let crashed = false;
    page.on("crash", () => {
      crashed = true;
    });

    await openInReader(page, "Geometrie und Topologie (PDF)");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of 117", {
      timeout: 30_000,
    });

    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("pref-theme").getByText("Smart dark", { exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 10_000 });

    await page.getByTestId("reader-sidebar-toggle").click();
    await expect(page.getByTestId("pdf-thumbnails")).toBeVisible({ timeout: 30_000 });

    const input = page.getByTestId("pdf-zoom-input");
    for (const pageNumber of [4, 5, 6, 7]) {
      await scrollToSlot(page, pageNumber);
      await waitForRendered(page, pageNumber, 30_000);

      // Free-spin in, then out through the region scales, like a fast wheel.
      await wheelBurst(page, 30, -120);
      await page.waitForTimeout(400);
      await wheelBurst(page, 50, 120);
      await page.waitForTimeout(400);

      // A typed jump to the clamp, then a fast spin out of it.
      await input.fill("10000");
      await input.press("Enter");
      await expect(input).toHaveValue("10000");
      await waitForRendered(page, await shownPage(page), 60_000);
      await wheelBurst(page, 45, 120);
      await page.waitForTimeout(500);

      await expectRendererAlive(page);
    }

    expect(crashed).toBe(false);
  });
});
