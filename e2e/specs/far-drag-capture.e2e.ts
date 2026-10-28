import { writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { artifactsDir } from "../setup/environment.js";
import { benchBookTitles } from "../setup/fixtures.js";
import { openInReader, returnToLibrary, scrollToSlot, waitForRendered } from "./helpers.js";

/**
 * Native far-scrollbar capture (tuxbooks-ckk).
 *
 * The existing bench's synthetic drag writes scrollTop directly and only
 * measures frame cadence. This capture grabs Chromium's real thumb through
 * trusted Playwright mouse input, drags it to a distant part of the document,
 * releases it, and samples every visible slot until the destination is sharp.
 * It reports the same motion-state shape as the rapid-scroll scenario, but
 * for the uncapped thumb-drag path the earlier investigation never measured.
 *
 * The report is evidence, not a timing gate: a failed stop-to-sharp still
 * lands in artifacts/e2e/<runId>/far-drag-capture.json before the assertion.
 */

const TARGET_FRACTION = 0.9;
const DRAG_STEP_PX = 10;
const MAX_DRAG_STEPS = 16;
const DRAG_STEP_DELAY_MS = 25;
const PROBE_OFFSETS = [0, -4, -8, -12, 4, 8, 12, -16, 16];
const GRAB_MIN_MOVE_PX = 50;
const GRAB_MAX_JUMP_PX = 20_000;
const SAMPLE_MS = 25;
const STOP_TIMEOUT_MS = 30_000;
const WHEEL_BASELINE = {
  renderingSharePct: 98,
  longestWhiteStreakMs: 8400,
  stopToSharpMs: 314,
};
const FAR_DRAG_BOOK_TITLE = process.env.FAR_DRAG_BOOK_TITLE ?? benchBookTitles.pdf;

type Geometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  offsetWidth: number;
  rectTop: number;
  rectLeft: number;
};

type ThumbModel = {
  trackX: number;
  trackTop: number;
  arrowLen: number;
  usable: number;
  thumbLen: number;
  pxPerCursor: number;
};

type Calibration = {
  grabCursorY: number;
  grabScrollTop: number;
  probeOffset: number;
  probes: { offset: number; moved: number }[];
};

type FarSample = {
  t: number;
  scrollTop: number;
  states: string[];
  currentPage: string | null;
  visiblePages: string;
  preloadPages: string;
  renderOrder: string;
  renderPermitted: string;
};

type FarDiagnostic = Omit<FarSample, "states">;

type FarResult = {
  startTop: number;
  endTop: number;
  distancePx: number;
  motionMs: number;
  samples: number;
  totalSamples: number;
  renderStates: { rendering: number; unloaded: number; rendered: number; error: number };
  renderStateSharePct: { rendering: number; unloaded: number; rendered: number; error: number };
  topmostRenderStates: { rendering: number; unloaded: number; rendered: number; error: number };
  topmostRenderStateSharePct: {
    rendering: number;
    unloaded: number;
    rendered: number;
    error: number;
  };
  longestWhiteStreakMs: number;
  stopToSharpMs: number | null;
  timedOut: boolean;
  diagnostics: FarDiagnostic[];
};

type FarGlobals = typeof globalThis & {
  __tuxbooksFarDrag?: {
    stop(): void;
    done: Promise<FarRawResult>;
  };
};

type RenderStateCounts = {
  rendering: number;
  unloaded: number;
  rendered: number;
  error: number;
};

interface FarRawResult {
  ticks: FarSample[];
  motionStartAt: number;
  motionEndAt: number;
  startTop: number;
  stopToSharpMs: number | null;
  timedOut: boolean;
  diagnostics: FarDiagnostic[];
}

function filterMotionTicks(
  ticks: FarSample[],
  motionStartAt: number,
  motionEndAt: number,
): FarSample[] {
  if (motionStartAt < 0 || motionEndAt < 0) return [];
  return ticks.filter((tick) => tick.t >= motionStartAt && tick.t <= motionEndAt);
}

function countRenderStates(ticks: FarSample[]): {
  counts: RenderStateCounts;
  total: number;
} {
  const counts: RenderStateCounts = { rendering: 0, unloaded: 0, rendered: 0, error: 0 };
  let total = 0;
  for (const tick of ticks) {
    for (const state of tick.states) {
      if (state in counts) {
        counts[state as keyof RenderStateCounts] += 1;
        total += 1;
      }
    }
  }
  return { counts, total };
}

function countTopmostRenderStates(ticks: FarSample[]): RenderStateCounts {
  const counts: RenderStateCounts = { rendering: 0, unloaded: 0, rendered: 0, error: 0 };
  for (const tick of ticks) {
    const state = tick.states[0] ?? "";
    if (state in counts) {
      counts[state as keyof RenderStateCounts] += 1;
    }
  }
  return counts;
}

function stateShares(counts: RenderStateCounts, total: number): RenderStateCounts {
  const share = (value: number): number =>
    total === 0 ? 0 : Number(((value / total) * 100).toFixed(1));
  return {
    rendering: share(counts.rendering),
    unloaded: share(counts.unloaded),
    rendered: share(counts.rendered),
    error: share(counts.error),
  };
}

function longestWhiteStreakMs(ticks: FarSample[], sampleMs: number): number {
  let longest = 0;
  let whiteSince = -1;
  const lastT = ticks.at(-1)?.t ?? 0;
  for (const tick of [...ticks, { t: lastT, states: ["closed"] } as FarSample]) {
    const state = tick.states[0] ?? "";
    const white = state === "rendering" || state === "unloaded";
    if (white && whiteSince < 0) whiteSince = tick.t;
    if (!white && whiteSince >= 0) {
      longest = Math.max(longest, tick.t - whiteSince + sampleMs);
      whiteSince = -1;
    }
  }
  return longest;
}

function summarizeFarResult(raw: FarRawResult): FarResult {
  const motionTicks = filterMotionTicks(raw.ticks, raw.motionStartAt, raw.motionEndAt);
  const visible = countRenderStates(motionTicks);
  const topmost = countTopmostRenderStates(motionTicks);
  const endTop = raw.ticks.at(-1)?.scrollTop ?? raw.startTop;
  const hasMotion = raw.motionStartAt >= 0 && raw.motionEndAt >= 0;
  return {
    startTop: raw.startTop,
    endTop,
    distancePx: endTop - raw.startTop,
    motionMs: hasMotion ? raw.motionEndAt - raw.motionStartAt : 0,
    samples: motionTicks.length,
    totalSamples: raw.ticks.length,
    renderStates: visible.counts,
    renderStateSharePct: stateShares(visible.counts, visible.total),
    topmostRenderStates: topmost,
    topmostRenderStateSharePct: stateShares(topmost, motionTicks.length),
    longestWhiteStreakMs: longestWhiteStreakMs(motionTicks, SAMPLE_MS),
    stopToSharpMs: raw.stopToSharpMs,
    timedOut: raw.timedOut,
    diagnostics: raw.diagnostics,
  };
}

async function readContainer(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
    if (!container) throw new Error("PDF scroll container not found");
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
  });
}

/** Maximize through the renderer, matching the bench's reference geometry. */
async function maximizeWindow(page: Page): Promise<void> {
  const target = await page.evaluate(() => ({
    width: window.screen.availWidth,
    height: window.screen.availHeight,
  }));
  await page.evaluate(
    ([width, height]) => window.resizeTo(width!, height!),
    [target.width, target.height],
  );
  await expect
    .poll(async () => {
      await page.evaluate(
        ([width, height]) => window.resizeTo(width!, height!),
        [target.width, target.height],
      );
      await page.waitForTimeout(200);
      return page.evaluate(() => window.innerWidth);
    })
    .toBe(target.width);
}

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
    arrowLen,
    usable,
    thumbLen,
    pxPerCursor: maxScroll / (usable - thumbLen),
  };
}

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

/**
 * Press around the modeled thumb center until a 3 px nudge moves the
 * document by a drag-scaled amount. A track press jumps by pages and is
 * released and restored before the next probe.
 */
async function calibrateAndGrab(page: Page, startScrollTop: number): Promise<Calibration> {
  const geometry = await readContainer(page);
  const model = thumbModel(geometry);
  const modelCenterY = predictedThumbCenterY(model, geometry, startScrollTop);
  const probes: { offset: number; moved: number }[] = [];

  for (const offset of PROBE_OFFSETS) {
    const cursorY = modelCenterY + offset;
    const before = (await readContainer(page)).scrollTop;
    await page.mouse.move(model.trackX, cursorY);
    await page.mouse.down();
    await page.mouse.move(model.trackX, cursorY + 3);
    await page.waitForTimeout(60);
    const after = (await readContainer(page)).scrollTop;
    const moved = Math.abs(after - before);

    if (moved >= GRAB_MIN_MOVE_PX && moved <= GRAB_MAX_JUMP_PX) {
      probes.push({ offset, moved });
      return {
        grabCursorY: cursorY + 3,
        grabScrollTop: after,
        probeOffset: offset,
        probes,
      };
    }

    await page.mouse.up();
    probes.push({ offset, moved });
    if (moved > GRAB_MAX_JUMP_PX) {
      await page.evaluate((top) => {
        const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
        if (container) container.scrollTop = top;
      }, startScrollTop);
      await page.waitForTimeout(250);
    }
  }
  throw new Error(`thumb calibration failed: no probe grabbed (${JSON.stringify(probes)})`);
}

async function startSampler(page: Page): Promise<void> {
  await page.evaluate(
    ({ sampleMs, stopTimeoutMs }) => {
      const globals = globalThis as FarGlobals;
      globals.__tuxbooksFarDrag?.stop();
      const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
      if (!container) throw new Error("PDF scroll container not found");

      const visibleStates = (): string[] => {
        const box = container.getBoundingClientRect();
        const states: string[] = [];
        for (const slot of document.querySelectorAll("[data-pdf-slot]")) {
          const rect = slot.getBoundingClientRect();
          if (rect.bottom > box.top && rect.top < box.bottom) {
            states.push(slot.getAttribute("data-render-state") ?? "");
          }
        }
        return states;
      };

      const readDiagnostics = (): Omit<FarSample, "t" | "scrollTop" | "states"> => {
        const reader = document.querySelector<HTMLElement>("[data-testid=pdf-reader]");
        return {
          currentPage: reader?.getAttribute("data-pdf-current-page") ?? null,
          visiblePages: reader?.getAttribute("data-pdf-visible-pages") ?? "",
          preloadPages: reader?.getAttribute("data-pdf-preload-pages") ?? "",
          renderOrder: reader?.getAttribute("data-pdf-render-order") ?? "",
          renderPermitted: reader?.getAttribute("data-pdf-render-permitted") ?? "",
        };
      };

      const ticks: FarSample[] = [];
      const diagnostics: FarDiagnostic[] = [];
      let lastDiagnosticKey = "";
      const startTop = container.scrollTop;
      let lastTop = startTop;
      let motionStartAt = -1;
      let motionEndAt = -1;
      let stopped = false;
      let stopRequestedAt = 0;
      let finished = false;
      let resolveDone!: (value: FarRawResult) => void;
      const done = new Promise<FarRawResult>((resolve) => {
        resolveDone = resolve;
      });

      const finish = (interval: number, sharpAt: number, timedOut: boolean): void => {
        if (finished) return;
        finished = true;
        window.clearInterval(interval);
        const hasMotion = motionStartAt >= 0 && motionEndAt >= 0;
        resolveDone({
          ticks,
          motionStartAt,
          motionEndAt,
          startTop,
          stopToSharpMs: hasMotion && !timedOut ? sharpAt - motionEndAt : null,
          timedOut,
          diagnostics,
        });
      };

      const timer = window.setInterval(() => {
        const now = performance.now();
        const top = container.scrollTop;
        if (top !== lastTop) {
          if (motionStartAt < 0) motionStartAt = now;
          motionEndAt = now;
          lastTop = top;
        }
        const diagnostic = readDiagnostics();
        const diagnosticKey = JSON.stringify(diagnostic);
        if (diagnosticKey !== lastDiagnosticKey) {
          lastDiagnosticKey = diagnosticKey;
          diagnostics.push({ t: now, scrollTop: top, ...diagnostic });
        }
        ticks.push({ t: now, scrollTop: top, states: visibleStates(), ...diagnostic });
        if (!stopped || now - motionEndAt < sampleMs) return;
        if (visibleStates().every((state) => state === "rendered")) {
          finish(timer, now, false);
        } else if (now - stopRequestedAt > stopTimeoutMs) {
          finish(timer, now, true);
        }
      }, sampleMs);

      globals.__tuxbooksFarDrag = {
        stop() {
          stopped = true;
          stopRequestedAt = performance.now();
        },
        done,
      };
    },
    {
      sampleMs: SAMPLE_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
    },
  );
}

async function stopSampler(page: Page): Promise<FarResult> {
  const raw = await page.evaluate(() => {
    const globals = globalThis as FarGlobals;
    const handle = globals.__tuxbooksFarDrag;
    if (!handle) throw new Error("far-drag sampler was never started");
    handle.stop();
    return handle.done;
  });
  return summarizeFarResult(raw);
}

test.describe("far native scrollbar capture", () => {
  test("drag the thumb to a distant page and measure stop-to-sharp", async ({ page }) => {
    test.setTimeout(180_000);

    await maximizeWindow(page);
    // Arm the existing opt-in zoom telemetry before the reader mounts, so
    // every scroll-frame anchor page and canvas presentation is recorded.
    await page.evaluate(() => {
      const api = (
        globalThis as typeof globalThis & {
          tuxbooksPdfZoomLog?: { enable(): void; clear(): void };
        }
      ).tuxbooksPdfZoomLog;
      api?.enable();
      api?.clear();
    });
    await openInReader(page, FAR_DRAG_BOOK_TITLE);
    await page.evaluate(() => {
      const api = (
        globalThis as typeof globalThis & {
          tuxbooksPdfZoomLog?: { clear(): void };
        }
      ).tuxbooksPdfZoomLog;
      api?.clear();
    });
    await firstCanvas(page);
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of", { timeout: 30_000 });
    await scrollToSlot(page, 1);
    await waitForRendered(page, 1, 60_000);

    const startGeometry = await readContainer(page);
    const calibration = await calibrateAndGrab(page, startGeometry.scrollTop);
    const grabGeometry = await readContainer(page);
    const model = thumbModel(grabGeometry);
    await startSampler(page);

    const maxScroll = grabGeometry.scrollHeight - grabGeometry.clientHeight;
    const targetScrollTop = Math.round(maxScroll * TARGET_FRACTION);
    const rawCursorDelta = (targetScrollTop - grabGeometry.scrollTop) / model.pxPerCursor;
    const usableDrag = model.usable - model.thumbLen;
    const cursorDelta = Math.max(-usableDrag, Math.min(usableDrag, rawCursorDelta));
    const direction = cursorDelta >= 0 ? 1 : -1;
    const stepCount = Math.max(
      1,
      Math.min(MAX_DRAG_STEPS, Math.ceil(Math.abs(cursorDelta) / DRAG_STEP_PX)),
    );
    const stepPx = direction * Math.max(DRAG_STEP_PX, Math.abs(cursorDelta) / stepCount);
    let cursorY = predictedThumbCenterY(model, grabGeometry, grabGeometry.scrollTop);
    for (let step = 0; step < stepCount; step += 1) {
      cursorY += stepPx;
      await page.mouse.move(model.trackX, cursorY);
      // Pace the trusted moves like a hand: a burst of CDP moves can be
      // coalesced by the browser and stop short of the modeled target.
      await page.waitForTimeout(DRAG_STEP_DELAY_MS);
    }

    // Chromium can coalesce a long run of rapid trusted moves. Nudge well
    // past the modeled target and back so the held thumb lands at the same
    // 90% position on every run, regardless of input coalescing.
    const targetCursorY = predictedThumbCenterY(model, grabGeometry, targetScrollTop);
    await page.mouse.move(model.trackX, targetCursorY + direction * 40);
    await page.waitForTimeout(100);
    await page.mouse.move(model.trackX, targetCursorY);
    await page.waitForTimeout(100);

    // Chromium may coalesce the trusted moves. Wait for the scrollbar's own
    // scroll updates to catch up before releasing, so every run measures a
    // genuinely far drag instead of an input-coalesced short one.
    await expect
      .poll(async () => (await readContainer(page)).scrollTop, { timeout: 5_000 })
      .toBeGreaterThan(maxScroll * 0.5);

    await page.mouse.up();

    const result = await stopSampler(page);
    const endGeometry = await readContainer(page);
    const indicator = await page.getByTestId("pdf-page-indicator").textContent();
    const finalSlots = await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
      if (!container) return [];
      const box = container.getBoundingClientRect();
      return [...document.querySelectorAll("[data-pdf-slot]")].flatMap((slot) => {
        const rect = slot.getBoundingClientRect();
        if (rect.bottom <= box.top || rect.top >= box.bottom) return [];
        const page = slot.getAttribute("data-pdf-slot");
        const canvas = slot.querySelector<HTMLCanvasElement>("[data-testid=pdf-canvas]");
        return [
          {
            page,
            state: slot.getAttribute("data-render-state"),
            quality: canvas?.getAttribute("data-pdf-render-quality") ?? null,
            renderMs: canvas?.getAttribute("data-pdf-render-ms") ?? null,
            region: canvas?.getAttribute("data-pdf-render-region") ?? null,
          },
        ];
      });
    });
    const zoomLogRaw = await page.evaluate(() => {
      const api = (
        globalThis as typeof globalThis & {
          tuxbooksPdfZoomLog?: { dump(): string };
        }
      ).tuxbooksPdfZoomLog;
      return api?.dump() ?? null;
    });
    const zoomLog = zoomLogRaw ? JSON.parse(zoomLogRaw) : null;
    if (zoomLog) {
      writeFileSync(
        path.join(artifactsDir, "far-drag-zoom-log.json"),
        `${JSON.stringify(zoomLog, null, 2)}\n`,
      );
    }
    const anchorPages =
      zoomLog?.samples
        ?.map((sample: { anchorPage: number | null }) => sample.anchorPage)
        .filter((page: number | null): page is number => page !== null) ?? [];
    const anchorTransitions = anchorPages.filter(
      (page: number, index: number) => index === 0 || page !== anchorPages[index - 1],
    );
    const report = {
      fixture: FAR_DRAG_BOOK_TITLE,
      targetFraction: TARGET_FRACTION,
      targetScrollTop,
      calibration,
      startScrollTop: grabGeometry.scrollTop,
      endScrollTop: endGeometry.scrollTop,
      thumb: model,
      cursorDelta,
      stepCount,
      indicator,
      finalSlots,
      wheelBaseline: WHEEL_BASELINE,
      deltaFromWheelBaseline: {
        renderingSharePct:
          result.topmostRenderStateSharePct.rendering - WHEEL_BASELINE.renderingSharePct,
        longestWhiteStreakMs: result.longestWhiteStreakMs - WHEEL_BASELINE.longestWhiteStreakMs,
        stopToSharpMs:
          result.stopToSharpMs === null
            ? null
            : result.stopToSharpMs - WHEEL_BASELINE.stopToSharpMs,
      },
      zoomLog: zoomLog
        ? {
            sampleCount: zoomLog.samples?.length ?? 0,
            scrollWrites: zoomLog.writes?.length ?? 0,
            anchorTransitions,
            lastAnchorPage: anchorPages.at(-1) ?? null,
          }
        : null,
      ...result,
    };
    writeFileSync(
      path.join(artifactsDir, "far-drag-capture.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(
      `[far-drag] distance=${result.distancePx.toFixed(0)}px ` +
        `motion=${result.motionMs.toFixed(0)}ms ` +
        `topmostRendering=${result.topmostRenderStateSharePct.rendering}% ` +
        `allVisibleRendering=${result.renderStateSharePct.rendering}% ` +
        `streak=${result.longestWhiteStreakMs.toFixed(0)}ms ` +
        `stopToSharp=${result.stopToSharpMs === null ? "never" : `${result.stopToSharpMs.toFixed(0)}ms`} ` +
        `indicator=${indicator ?? ""}`,
    );

    expect(result.distancePx).toBeGreaterThan(maxScroll * 0.5);
    expect(result.samples).toBeGreaterThan(0);
    expect(result.stopToSharpMs).not.toBeNull();

    await returnToLibrary(page);
  });
});

async function firstCanvas(page: Page): Promise<void> {
  await page
    .locator("[data-testid=pdf-canvas]")
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
}
