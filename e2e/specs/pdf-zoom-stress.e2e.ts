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
 * Regression guard for the 2026-09-20 renderer crash: roughly a minute of
 * fast Ctrl+wheel zooming out from deep zoom under Smart Dark froze the app
 * and then segfaulted the renderer (exit 139). The captured log showed the
 * engine recycling its MuPDF worker between nearly every render — the Smart
 * Dark region path reported every fast-path render as a display-list bypass
 * (`recovered`), and each bypass terminates and reopens the worker. With the
 * swaps racing in-flight rasters, readers stalled and crashed.
 *
 * The contract (docs/PDF.md): worker recycling is budget-based (180 Smart
 * Dark renders); only a genuine display-list bypass escapes the worker
 * early. This loop drives the churn — Smart Dark, deep zoom (region
 * rendering), rapid wheel bursts at commit cadence, wobble, scroll jumps —
 * and asserts the reader converges after every round while the recycle
 * count stays near zero. Renderer aliveness is probed throughout: a crashed
 * renderer rejects evaluate.
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

test.describe("PDF Smart Dark zoom churn", () => {
  test("survives rapid Ctrl+wheel churn at deep zoom without recycling workers", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    let recycleCount = 0;
    page.on("console", (message) => {
      if (message.text().includes("recycled MuPDF worker")) recycleCount += 1;
    });

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
      // settles into a commit whose re-render can overlap a worker swap if
      // the engine ever recycles per render again.
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

    // The contract: fast-path region renders never recycle the worker. A
    // genuine display-list bypass (fixture pages with unrecordable content)
    // may escape a worker once — dozens per session is the regression.
    expect(recycleCount).toBeLessThanOrEqual(1);
    await expectRendererAlive(page);
  });

  // The exact book of the 2026-09-20 crash report: page 35's mesh shadings
  // corrupt a Smart Dark worker's wasm heap (node repro: replays "succeed"
  // then the heap dies on a later free). The throw is state-dependent and
  // did not fire in this harness, so the engine's escape-on-throw CONTRACT
  // is pinned at the fake-worker seam (pdfWorkerRecycle.test.ts); this spec
  // is the real-book guard: the reader must keep converging through the
  // churn and the renderer must stay alive. Needs the fetched corpus
  // (just fetch-ebooks); skipped when GeoTopo.pdf is not on disk.
  test("recovers GeoTopo page 35 under Smart Dark zoom churn", async ({ page }) => {
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
    // successive scales, driving the device path that corrupts the heap.
    // The anchor may drift to neighbouring pages while zooming (the
    // cursor point stays fixed, the shown page can change), so every round
    // asserts on whatever page the reader finally shows.
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

    // The page the reader ends on must be sharp and the renderer alive:
    // a thrown render escapes the worker instead of leaving the reader
    // stuck on failed pages.
    const shown = await shownPage(page);
    await waitForRendered(page, shown, 60_000);
    expect(await canvasIsNonBlank(page, shown)).toBe(true);
    await expectRendererAlive(page);
  });
});
