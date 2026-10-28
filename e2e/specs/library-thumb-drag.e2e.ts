import { readdirSync } from "node:fs";

import { expect, test, type Page } from "../fixtures/electron-app.js";
import { prepareBenchEnvironment } from "../setup/bench-helpers.js";
import {
  LIBRARY_CORPUS_BOOK_COUNT,
  LIBRARY_THUMB_PART_COUNT,
  libraryThumbPartDir,
} from "../setup/fixtures.js";

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

const GRID_SELECTOR = '[data-testid="book-grid"]';
const LIST_SELECTOR = '[data-testid="book-list"]';

/** Drag shape: 10 cursor px per trusted mousemove, down (or up) the track. */
const DRAG_STEP_PX = 10;
const MAX_DRAG_STEPS = 90;

/**
 * Assertion tolerance for "thumb still under the held cursor": half a thumb
 * length plus measured model noise (the static control tracks at ~7 track
 * px, the settled-geometry grid at ~11; the unfixed build diverges
 * 369-512).
 */
const THUMB_MODEL_NOISE_PX = 12;

/** Full drift bound: model noise plus half-thumb slack. */
const THUMB_DRIFT_TOLERANCE_PX = THUMB_MODEL_NOISE_PX * 2;

/** Mechanism guard: scroll-height corrections landing mid-drag (see spec doc). */
const MAX_MID_DRAG_HEIGHT_EVENTS = 8;

/** Calibration probe offsets (CSS px), from the reader's thumb-drag capture. */
const PROBE_OFFSETS = [0, -4, -8, -12, 4, 8, 12, -16, 16];

/**
 * Grab detection, from the reader capture: a probe press counts as a grab
 * when a 3 px nudge moved the document a drag-scaled amount. A track press
 * jumps by screens (tens of thousands of px); a thumb grab on a 10k library
 * (~500 scroll px per cursor px) moves a few thousand.
 */
const GRAB_MAX_JUMP_PX = 20_000;
const GRAB_MIN_MOVE_PX = 50;

/**
 * import_paths is one sidecar RPC with a 60 s runaway guard
 * (electron/main/sidecar.ts REQUEST_TIMEOUT_MS); the corpus generator
 * partitions the thumb corpus for exactly this reason — see the
 * generateLibraryThumbCorpus rationale in setup/environment.ts. Each part
 * imports as one folder call, the shape the app's own folder flow uses.
 */

type Geometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  offsetWidth: number;
  rectTop: number;
  rectLeft: number;
};

type Sample = {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  connected: boolean;
};

type AppWrite = { t: number; from: number; to: number };

type Collected = { samples: Sample[]; appWrites: AppWrite[]; t0: number };

type CaptureGlobals = typeof globalThis & {
  __tuxbooksThumbDrag?: {
    stopAndCollect: () => Collected;
  };
};

/** Geometry of a scroll container by selector. */
async function readContainer(page: Page, selector: string): Promise<Geometry> {
  return page.evaluate((sel) => {
    const container = document.querySelector<HTMLElement>(sel);
    if (!container) throw new Error(`library scroll container not found: ${sel}`);
    const rect = container.getBoundingClientRect();
    return {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      clientWidth: container.clientWidth,
      offsetWidth: container.offsetWidth,
      rectTop: rect.top,
      rectLeft: rect.left,
    };
  }, selector);
}

type ThumbModel = {
  trackX: number;
  trackTop: number;
  trackLen: number;
  arrowLen: number;
  usable: number;
  thumbLen: number;
  pxPerCursor: number;
};

/**
 * Chromium's classic scrollbar model on Linux: square arrow buttons at both
 * track ends, thumb length proportional to the visible fraction of the
 * usable track. pxPerCursor is the drag ratio: scroll px per cursor px.
 */
function thumbModel(geometry: Geometry): ThumbModel {
  const scrollbarWidth = geometry.offsetWidth - geometry.clientWidth;
  if (scrollbarWidth <= 0) throw new Error("no classic scrollbar on the container");
  const trackLen = geometry.clientHeight;
  const arrowLen = scrollbarWidth;
  const usable = trackLen - 2 * arrowLen;
  const maxScroll = geometry.scrollHeight - geometry.clientHeight;
  const thumbLen = Math.max(
    scrollbarWidth,
    (geometry.clientHeight / geometry.scrollHeight) * usable,
  );
  return {
    trackX: geometry.rectLeft + geometry.clientWidth + scrollbarWidth / 2,
    trackTop: geometry.rectTop,
    trackLen,
    arrowLen,
    usable,
    thumbLen,
    pxPerCursor: maxScroll / (usable - thumbLen),
  };
}

/** Predicted thumb center y for a scrollTop, under the given model. */
function predictedThumbCenterY(model: ThumbModel, geometry: Geometry, scrollTop: number): number {
  const maxScroll = geometry.scrollHeight - geometry.clientHeight;
  const fraction = Math.min(1, Math.max(0, scrollTop / maxScroll));
  return (
    model.trackTop +
    model.arrowLen +
    fraction * (model.usable - model.thumbLen) +
    model.thumbLen / 2
  );
}

type Calibration = {
  grabCursorY: number;
  grabScrollTop: number;
};

/**
 * Find and grab the thumb: press at the modeled center shifted by each
 * probe offset, nudge 3 px down, keep the first press that moved the
 * document a drag-scaled amount. Mis-presses are released and track presses
 * restore the start position (before instrumentation, so probe pollution
 * never lands in the drag window). Returns with the button held down.
 */
async function calibrateAndGrab(
  page: Page,
  selector: string,
  startScrollTop: number,
  direction: 1 | -1,
): Promise<Calibration> {
  const geometry = await readContainer(page, selector);
  const model = thumbModel(geometry);
  const modelCenterY = predictedThumbCenterY(model, geometry, startScrollTop);

  for (const offset of PROBE_OFFSETS) {
    const cursorY = modelCenterY + offset;
    const before = (await readContainer(page, selector)).scrollTop;
    await page.mouse.move(model.trackX, cursorY);
    await page.mouse.down();
    // Nudge in the drag direction: at the track end a nudge into the
    // boundary clamps to zero movement and would read as a missed grab.
    await page.mouse.move(model.trackX, cursorY + 3 * direction);
    await page.waitForTimeout(60);
    const after = (await readContainer(page, selector)).scrollTop;
    const moved = (after - before) * direction;

    if (moved >= GRAB_MIN_MOVE_PX && moved <= GRAB_MAX_JUMP_PX) {
      // Keep holding: the drag continues from exactly this press.
      return { grabCursorY: cursorY + 3 * direction, grabScrollTop: after };
    }

    await page.mouse.up();
    if (moved > GRAB_MAX_JUMP_PX) {
      // Track press: the document jumped to the press point. Restore.
      await page.evaluate(
        ([sel, top]) => {
          const container = document.querySelector<HTMLElement>(sel);
          if (container) container.scrollTop = top;
        },
        [selector, startScrollTop] as [string, number],
      );
      await page.waitForTimeout(250);
    }
  }
  throw new Error("thumb calibration failed: no probe grabbed");
}

/**
 * In-page instruments on a scroll container: an 8 ms sampler (one sample
 * per animation frame) and a scrollTop setter patch that records
 * programmatic writes — during a native thumb drag the browser updates the
 * scroll offset inside its input path and never calls the JS setter, so
 * every intercepted write is app-driven.
 */
async function installInstruments(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const container = document.querySelector<HTMLElement>(sel);
    if (!container) throw new Error(`library scroll container not found: ${sel}`);
    const globals = globalThis as CaptureGlobals;

    const protoDesc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (!protoDesc) throw new Error("scrollTop accessor not found");

    const state = {
      t0: performance.now(),
      running: true,
      samples: [] as Sample[],
      appWrites: [] as AppWrite[],
    };

    const sampler = window.setInterval(() => {
      if (!state.running) return;
      requestAnimationFrame(() => {
        if (!state.running) return;
        state.samples.push({
          t: performance.now() - state.t0,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          connected: container.isConnected,
        });
      });
    }, 8);

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get() {
        return protoDesc.get!.call(container);
      },
      set(value: number) {
        const from = protoDesc.get!.call(container);
        if (value !== from) {
          state.appWrites.push({
            t: performance.now() - state.t0,
            from,
            to: value,
          });
        }
        protoDesc.set!.call(container, value);
      },
    });

    globals.__tuxbooksThumbDrag = {
      stopAndCollect() {
        state.running = false;
        window.clearInterval(sampler);
        return {
          samples: state.samples.slice(),
          appWrites: state.appWrites.slice(),
          t0: state.t0,
        };
      },
    };
  }, selector);
}

/**
 * Static-overlay control (diagnosis retained): the same trusted-input drag
 * on a plain absolutely-positioned scroller with FIXED content height in
 * the same window — no React, no virtualizer, no mid-drag geometry changes.
 * It tracks within a few px; if a grid assertion fails while this passes,
 * the divergence is app-caused, not a harness artifact.
 */
/** One trusted mousemove per step along the track; returns the final cursor y. */
async function runDragSteps(
  page: Page,
  trackX: number,
  fromCursorY: number,
  direction: 1 | -1,
  steps: number,
): Promise<number> {
  let cursorY = fromCursorY;
  for (let step = 0; step < steps; step += 1) {
    cursorY += DRAG_STEP_PX * direction;
    await page.mouse.move(trackX, cursorY);
  }
  return cursorY;
}

/** Steps to drag the whole usable track at this geometry. */
function trackSteps(model: ThumbModel): number {
  return Math.min(MAX_DRAG_STEPS, Math.floor((model.usable - model.thumbLen) / DRAG_STEP_PX));
}

async function controlDrag(page: Page): Promise<number> {
  const selector = "#thumb-drag-control";
  await page.evaluate(() => {
    const host =
      document.querySelector<HTMLElement>('[data-testid="book-grid"]') ??
      document.querySelector<HTMLElement>('[data-testid="book-list"]');
    const height = host ? Math.round(host.scrollHeight) : 500_000;
    let el = document.querySelector<HTMLElement>("#thumb-drag-control");
    if (!el) {
      el = document.createElement("div");
      el.id = "thumb-drag-control";
      el.style.cssText =
        "position:fixed;left:0;top:0;width:120px;height:100vh;overflow-y:scroll;z-index:9999;";
      const spacer = document.createElement("div");
      spacer.style.height = `${height}px`;
      el.appendChild(spacer);
      document.body.appendChild(el);
    }
  });
  await page.waitForTimeout(300);

  const calibration = await calibrateAndGrab(page, selector, 0, 1);
  const grabGeometry = await readContainer(page, selector);
  const grabModel = thumbModel(grabGeometry);
  const cursorY = await runDragSteps(
    page,
    grabModel.trackX,
    calibration.grabCursorY,
    1,
    trackSteps(grabModel),
  );
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const endGeometry = await readContainer(page, selector);
  const endModel = thumbModel(endGeometry);
  const endThumbCenterY = predictedThumbCenterY(endModel, endGeometry, endGeometry.scrollTop);
  const gap = Math.abs(cursorY - endThumbCenterY);
  // Tear down: the fixed overlay intercepts real clicks.
  await page.evaluate(() => document.getElementById("thumb-drag-control")?.remove());
  return gap;
}

/** Corpus import through the real bulk path, part directory by part directory. */
async function importLibrary(page: Page): Promise<void> {
  const partDirs = Array.from({ length: LIBRARY_THUMB_PART_COUNT }, (_, part) =>
    libraryThumbPartDir(part),
  );
  const partBookCounts = partDirs.map(
    (dir) => readdirSync(dir).filter((name) => name.endsWith(".epub")).length,
  );
  expect(partBookCounts.reduce((sum, count) => sum + count, 0)).toBe(LIBRARY_CORPUS_BOOK_COUNT);

  let imported = 0;
  let skipped = 0;
  for (const partDir of partDirs) {
    const report = (await page.evaluate(
      (dir) => window.tuxbooks!.invoke("import_paths", { paths: [dir] }),
      partDir,
    )) as Record<string, number>;
    imported += report.imported;
    skipped += report.skipped;
  }
  expect(imported).toBe(LIBRARY_CORPUS_BOOK_COUNT);
  expect(skipped).toBe(0);
}

/**
 * One held thumb drag. direction +1 drags down the track from the top
 * (unmeasured rows ahead below); -1 drags up from the bottom (unmeasured
 * rows ahead above). Returns the measurements the assertions read.
 */
async function dragThumb(
  page: Page,
  selector: string,
  direction: 1 | -1,
  startScrollTop: number,
): Promise<{
  gapTrackPx: number;
  thumbUnderCursorAtEnd: boolean;
  finalErrorPx: number;
  traveledPx: number;
  startScrollHeight: number;
  endScrollHeight: number;
  heightEventsDuringDrag: number;
  heightDeltaPx: number;
  appWriteCount: number;
  appWriteDeltaSum: number;
  controlGapPx: number;
}> {
  const calibration = await calibrateAndGrab(page, selector, startScrollTop, direction);
  await installInstruments(page, selector);
  const grabGeometry = await readContainer(page, selector);
  const grabModel = thumbModel(grabGeometry);

  const cursorY = await runDragSteps(
    page,
    grabModel.trackX,
    calibration.grabCursorY,
    direction,
    trackSteps(grabModel),
  );
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const collected: Collected = await page.evaluate(() => {
    const handle = (globalThis as CaptureGlobals).__tuxbooksThumbDrag;
    if (handle) return handle.stopAndCollect();
    return { samples: [], appWrites: [], t0: 0 };
  });
  const endGeometry = await readContainer(page, selector);
  const endModel = thumbModel(endGeometry);
  const endCursorY = cursorY;

  const endMaxScroll = endGeometry.scrollHeight - endGeometry.clientHeight;
  const cursorTrackFrac = (endCursorY - endModel.trackTop - endModel.arrowLen) / endModel.usable;
  const thumbTrackFrac = endGeometry.scrollTop / endMaxScroll;
  const gapTrackPx = Math.abs(cursorTrackFrac - thumbTrackFrac) * endModel.usable;
  const endThumbCenterY = predictedThumbCenterY(endModel, endGeometry, endGeometry.scrollTop);
  const thumbUnderCursorAtEnd = Math.abs(endCursorY - endThumbCenterY) <= endModel.thumbLen / 2;

  // Frozen-geometry prediction: where the scroll offset would be if the
  // scrollbar geometry at grab time had stayed true through the drag.
  const predictedEndScrollTop =
    calibration.grabScrollTop + (endCursorY - calibration.grabCursorY) * grabModel.pxPerCursor;
  const finalErrorPx = endGeometry.scrollTop - predictedEndScrollTop;
  const traveledPx = endGeometry.scrollTop - calibration.grabScrollTop;

  const dragSamples = collected.samples;
  let heightDeltaPx = 0;
  for (let index = 1; index < dragSamples.length; index += 1) {
    const delta = dragSamples[index].scrollHeight - dragSamples[index - 1].scrollHeight;
    if (delta !== 0) heightDeltaPx += delta;
  }
  const heightEventsDuringDrag = dragSamples.filter(
    (sample, index) => index > 0 && sample.scrollHeight !== dragSamples[index - 1].scrollHeight,
  );
  const appWriteDeltaSum = collected.appWrites.reduce(
    (sum, write) => sum + (write.to - write.from),
    0,
  );

  const controlGapPx = await controlDrag(page);

  return {
    gapTrackPx,
    thumbUnderCursorAtEnd,
    finalErrorPx,
    traveledPx,
    startScrollHeight: grabGeometry.scrollHeight,
    endScrollHeight: endGeometry.scrollHeight,
    heightEventsDuringDrag: heightEventsDuringDrag.length,
    heightDeltaPx,
    appWriteCount: collected.appWrites.length,
    appWriteDeltaSum,
    controlGapPx,
  };
}

test.describe.serial("10,000-book scrollbar thumb drag (tuxbooks-y9s)", () => {
  // The tests share one app + library (one Electron invocation per phase,
  // workers 1) and run in file order: the import lands once in the first
  // test, and later tests skip if it never happened.
  let importedOnce = false;

  test("grid thumb stays under the cursor through a full-track downward drag", async ({ page }) => {
    test.setTimeout(900_000);

    await prepareBenchEnvironment(page);
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "All Books", exact: true })).toBeVisible();

    await importLibrary(page);

    // An empty library renders the empty state rather than LibraryView, so
    // select All Books only once the imported books have landed.
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

    // Navigate away and back: LibraryView unmounts on navigation (the
    // scroll-position map is module-level for exactly this reason), so the
    // virtualizer's measurement cache starts empty — jumping to the bottom
    // then leaves every unmounted row above the viewport unmeasured, which
    // is the upward drag's correction territory.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "All Books", exact: true }).click();
    await expect(page.getByTestId("book-grid")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);

    // Jump to the bottom (instant, no intermediate mounting), settle.
    await jumpToBottom(page, GRID_SELECTOR);
    const start = await readContainer(page, GRID_SELECTOR);

    const result = await dragThumb(page, GRID_SELECTOR, -1, start.scrollTop);
    assertThumbTracked(result, "upward (grid)");
  });

  test("list thumb stays under the cursor through a full-track downward drag", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(!importedOnce, "runs after the downward drag in the same session");

    // The issue covers Grid AND List (tuxbooks-y9s): switch views, which
    // re-prices every row (list rows were never measured in this view), so
    // the drag crosses fresh measurement territory.
    // Radix ToggleGroup items render role=radio, not role=button.
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

  // Harness sanity.
  expect(Math.abs(result.traveledPx)).toBeGreaterThan(50_000);
  expect(result.controlGapPx, "static control must track the cursor").toBeLessThan(30);

  // The regression assertion: the thumb must still be under the held
  // cursor at release. Model noise measured at ~11 track px (control 7.1),
  // so the bound absorbs the model without letting a real divergence
  // through (the unfixed build diverges 369-512 px).
  expect(
    result.gapTrackPx,
    `thumb drifted ${result.gapTrackPx.toFixed(0)} track px from the cursor on the ${direction} drag ` +
      `(scroll error ${result.finalErrorPx.toFixed(0)} px over ${result.traveledPx.toFixed(0)} px; ` +
      `${result.heightEventsDuringDrag} scroll-height corrections mid-drag, ` +
      `net ${result.heightDeltaPx.toFixed(0)} px; ` +
      `${result.appWriteCount} app scrollTop writes, net ${result.appWriteDeltaSum.toFixed(0)} px)`,
  ).toBeLessThanOrEqual(THUMB_DRIFT_TOLERANCE_PX);

  // Mechanism guard: the fix's whole point is that no geometry correction
  // lands during a held drag (mid-drag corrections of any net size break
  // Chromium's drag tracking: 36-48 events on the unfixed build vs 0
  // fixed). The slack absorbs one incidental reflow; a regression back to
  // per-row correction cascades fails here with a direct message.
  expect(
    result.heightEventsDuringDrag,
    `${result.heightEventsDuringDrag} scroll-height corrections landed mid-drag ` +
      `(net ${result.heightDeltaPx.toFixed(0)} px) — total size must stay frozen while scrolling`,
  ).toBeLessThanOrEqual(MAX_MID_DRAG_HEIGHT_EVENTS);
}
