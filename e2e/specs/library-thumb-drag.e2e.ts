import { expect, test, type Page } from "../fixtures/electron-app.js";
import { prepareBenchEnvironment } from "../setup/bench-helpers.js";
import {
  GRID_SELECTOR,
  LIST_SELECTOR,
  dragThumb,
  importLibrary,
  MAX_MID_DRAG_HEIGHT_EVENTS,
  readContainer,
  THUMB_DRIFT_TOLERANCE_PX,
} from "./library-thumb-harness.js";

/**
 * Regression test for tuxbooks-y9s: on the 10,000-book All Books Grid, a
 * held native scrollbar-thumb drag diverges from the cursor's y position
 * over long scrolls — the thumb lags the cursor by hundreds of track px and
 * can stop following entirely mid-drag.
 *
 * Mechanism (established by the instrumented loop this spec grew out of):
 * the virtualizer reserves unmeasured rows at `estimateSize` and corrects
 * them through `measureElement` as the drag's render window reaches them.
 * Every correction rewrites the total size, i.e. the scroll container's
 * scrollHeight, and Chromium's in-flight thumb drag loses deltas on each
 * geometry change — bursty half-rate tracking, then a dead drag. With
 * settled geometry (no corrections mid-drag) the same drag tracks the
 * cursor to within model noise, so the fix is to settle the total size:
 * the learned estimate ratio in LibraryView re-prices the unmeasured
 * suffix as rows measure, and the corrections stop compounding.
 *
 * Both directions the user reported are covered, on both views: the Grid
 * downward (fresh library), the Grid upward after a jump to the bottom of
 * a freshly-mounted view (remounted via navigation, so the virtualizer's
 * measurement cache starts empty), and the List downward through rows
 * never measured in that view.
 *
 * The drag drives trusted input (Playwright mouse, the browser's input
 * pipeline) through Chromium's classic scrollbar, like the reader's
 * thumb-drag capture. A static-overlay control runs the same input on
 * fixed content in the same window; it tracks within a few px and proves
 * the harness and input path whenever the grid assertion fails.
 *
 * Run it explicitly: `just test-e2e-library-thumb` (opt-in, Xvfb, never
 * CI). Fixed window via BENCH_WINDOW_SIZE in the recipe, so the track
 * geometry is deterministic.
 */

test.describe.serial("10,000-book scrollbar thumb drag (tuxbooks-y9s)", () => {
  // One app per file, tests in order: the import lands once; later tests skip.
  let importedOnce = false;

  test("grid thumb stays under the cursor through a full-track downward drag", async ({ page }) => {
    test.setTimeout(900_000);

    await prepareBenchEnvironment(page);
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "All Books", exact: true })).toBeVisible();

    await importLibrary(page);

    // Select All Books only after import: an empty library has no LibraryView.
    await page.getByRole("button", { name: "All Books", exact: true }).click();
    await expect(page.getByTestId("library-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("book-grid")).toBeVisible();
    await page.waitForTimeout(1_000);
    importedOnce = true;

    const result = await dragThumb(page, GRID_SELECTOR, 1, 0);
    assertThumbTracked(result, "downward (grid)");
  });

  test("grid thumb stays under the cursor through a full-track upward drag", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(!importedOnce, "runs after the downward drag in the same session");

    // A list round trip remounts the grid, so the measurement cache starts empty.
    await page.getByRole("radio", { name: "List view" }).click();
    await expect(page.getByTestId("book-list")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("radio", { name: "Grid view" }).click();
    await expect(page.getByTestId("book-grid")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);

    await jumpToBottom(page, GRID_SELECTOR);
    const start = await readContainer(page, GRID_SELECTOR);

    const result = await dragThumb(page, GRID_SELECTOR, -1, start.scrollTop);
    assertThumbTracked(result, "upward (grid)");
  });

  test("list thumb stays under the cursor through a full-track downward drag", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(!importedOnce, "runs after the downward drag in the same session");

    // Switch views so every list row is measured here; Radix items are role=radio.
    await page.getByRole("radio", { name: "List view" }).click();
    await expect(page.getByTestId("book-list")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await page.evaluate((sel) => {
      const list = document.querySelector<HTMLElement>(sel);
      if (list) list.scrollTop = 0;
    }, LIST_SELECTOR);

    const result = await dragThumb(page, LIST_SELECTOR, 1, 0);
    assertThumbTracked(result, "downward (list)");
  });
});

/** Instant jump: no intermediate mounting, so unmeasured rows stay unmeasured. */
async function jumpToBottom(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const container = document.querySelector<HTMLElement>(sel);
    if (!container) throw new Error(`scroll container not found: ${sel}`);
    container.scrollTop = container.scrollHeight;
  }, selector);
  await page.waitForTimeout(1_000);
}

/** Shared assertion + evidence logging for one drag. */
function assertThumbTracked(
  result: Awaited<ReturnType<typeof dragThumb>>,
  direction: string,
): void {
  console.log(
    `[library-thumb-drag:${direction}] gap=${result.gapTrackPx.toFixed(0)} track px ` +
      `finalError=${result.finalErrorPx.toFixed(0)} px traveled=${result.traveledPx.toFixed(0)} px ` +
      `scrollHeight ${result.startScrollHeight.toFixed(0)} -> ${result.endScrollHeight.toFixed(0)} ` +
      `heightEventsDuringDrag=${result.heightEventsDuringDrag} ` +
      `heightDeltaPx=${result.heightDeltaPx.toFixed(0)} ` +
      `appWritesDuringDrag=${result.appWriteCount} ` +
      `appWriteDeltaSum=${result.appWriteDeltaSum.toFixed(0)} ` +
      `thumbUnderCursorAtEnd=${result.thumbUnderCursorAtEnd} ` +
      `controlGapPx=${result.controlGapPx.toFixed(1)}`,
  );

  expect(Math.abs(result.traveledPx)).toBeGreaterThan(50_000);
  expect(result.controlGapPx, "static control must track the cursor").toBeLessThan(30);

  // Bound absorbs model noise (~11 track px), not the 369-512 px regression.
  expect(
    result.gapTrackPx,
    `thumb drifted ${result.gapTrackPx.toFixed(0)} track px from the cursor on the ${direction} drag ` +
      `(scroll error ${result.finalErrorPx.toFixed(0)} px over ${result.traveledPx.toFixed(0)} px; ` +
      `${result.heightEventsDuringDrag} scroll-height corrections mid-drag, ` +
      `net ${result.heightDeltaPx.toFixed(0)} px; ` +
      `${result.appWriteCount} app scrollTop writes, net ${result.appWriteDeltaSum.toFixed(0)} px)`,
  ).toBeLessThanOrEqual(THUMB_DRIFT_TOLERANCE_PX);

  // No geometry correction may land mid-drag; the slack absorbs one reflow.
  expect(
    result.heightEventsDuringDrag,
    `${result.heightEventsDuringDrag} scroll-height corrections landed mid-drag ` +
      `(net ${result.heightDeltaPx.toFixed(0)} px) — total size must stay frozen while scrolling`,
  ).toBeLessThanOrEqual(MAX_MID_DRAG_HEIGHT_EVENTS);
}
