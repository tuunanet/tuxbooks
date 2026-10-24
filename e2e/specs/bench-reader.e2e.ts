import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import {
  bitmapCacheUsage,
  closeReaderNavigation,
  maxSingleBitmapBytes,
  openInReader,
  openReaderNavigation,
  pdfSurfaceMemory,
  inputValueOf,
  returnToLibrary,
  scrollToSlot,
  textOf,
  waitForRendered,
  firstPdfCanvas,
} from "./helpers.js";
import { artifactsDir } from "../setup/environment.js";
import { benchBookTitles, benchPdfFixture } from "../setup/fixtures.js";
import {
  emptyReport,
  readReport,
  TREND_FILE_NAME,
  updateReport,
  type BenchFrameStats,
  type BenchReport,
  type RapidScrollResult,
  type RenderStateShare,
} from "../setup/bench-report.js";

/**
 * Reader performance benchmark (docs/PERFORMANCE.md "How to measure").
 *
 * This suite MEASURES and REPORTS; it does not assert timing thresholds —
 * those are manual by policy (E2E asserts deterministic attributes only,
 * and headless timings are unreliable). Run it explicitly and headed:
 * `just bench-reader` maximizes the window on the real display (reference
 * conditions; an explicit `WxH` argument overrides), and it seeds the
 * free-corpus fixtures (just fetch-ebooks), whose 117-page PDF and
 * image-laden EPUB make latency measurement meaningful. Both walks start
 * mid-book so the samples cover
 * real content rather than front matter and the ToC.
 *
 * The scroll scenario is a synthetic scrollbar drag: continuous scroll
 * deltas driven per animation frame — the same mutation a dragged scrollbar
 * performs — not discrete page turns, which bypass the continuous-scroll
 * path where the jank lives. While the drag runs, a rAF sampler records
 * frame intervals: main-thread stalls (raster, layout, React commits) show
 * up directly as long frames. All measurement runs browser-side; Playwright
 * is only the input/automation layer and its API time is never counted as
 * reader performance.
 *
 * The rapid-scroll scenario is the other half of the scroll picture. Real
 * wheel input at flick pace, a 25 ms sampler of the render state under the
 * viewport centre, and two numbers out of it. The distribution of render
 * states while the document moves says how much of the motion the reader
 * spends showing white placeholders, and stop-to-sharp is the time from the
 * last wheel event until every visible slot is rendered. Both are measured
 * browser-side, so the automation round trip never lands in them.
 *
 * The report persists per scenario, not once at the end. A Playwright
 * worker restart re-instantiates this module with an empty report, and a
 * single end-of-run write would leave the restarted worker's survivors
 * overwriting the numbers the earlier scenarios already collected. Each
 * scenario merges into `bench-results.json` as it finishes
 * (setup/bench-report.ts), so the file holds every scenario that completed.
 *
 * Deterministic budget assertions still hold here — they are policy, not
 * timing: PERF-1 buffer caps, PERF-3 cache occupancy after an oscillation,
 * and the PERF-4 derived live-canvas byte bound.
 */

const PDF_WALK_PAGES = 16;
const DRAG_FRAMES = 240;
const PDF_DRAG_PX_PER_FRAME = 48;
const EPUB_DRAG_PX_PER_FRAME = 40;

/**
 * Rapid-scroll motion, paced to the recorded baseline
 * (docs/research/pdf-viewer-perf-findings.md: 260 wheel events of 600 px
 * every ~35 ms, ~9 s, ~17,300 px/s over about 43 pages of GeoTopo). The
 * pacing delay is what makes the pace a reference condition rather than
 * whatever the automation round trip happens to allow; the wheel itself
 * travels Chromium's input pipeline, so the reader sees the event a
 * physical wheel produces.
 */
const RAPID_SCROLL_WHEEL_EVENTS = 260;
const RAPID_SCROLL_WHEEL_PX = 600;
const RAPID_SCROLL_WHEEL_INTERVAL_MS = 35;
/** Render-state sample period during motion, matching the capture's 25 ms. */
const RAPID_SCROLL_SAMPLE_MS = 25;
/** Stop-to-sharp gives up (and reports -1) well past any healthy settle. */
const RAPID_SCROLL_SHARP_TIMEOUT_MS = 30_000;

/** The config's per-test bound is too tight for a measured walk. */
const BENCH_TEST_TIMEOUT_MS = 900_000;

interface DragResult {
  /** rAF frame intervals (ms) after the first frame. */
  frames: number[];
  /** Per-canvas last render→blit durations harvested during the drag. */
  renderMs: number[];
  wallMs: number;
  distancePx: number;
  /** EPUB only: engine section turns forced when the drag hit a section end. */
  sectionJumps: number;
}

/**
 * What the rapid-scroll sampler collected while the document was moving.
 * Timestamps are `performance.now()` values taken in the page, so every
 * interval derived from them excludes the automation layer.
 */
interface ScrollSamplerResult {
  samples: { at: number; state: string }[];
  /** Wheel events the page actually received, counted from its own listener. */
  wheelCount: number;
  firstWheelAt: number;
  lastWheelAt: number;
  distancePx: number;
}

const report: BenchReport = emptyReport();

/** p-value of a sample list (0.5 = median); -1 when empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** Share of `count` in `total`, in percent; -1 when nothing was sampled. */
function sharePct(count: number, total: number): number {
  return total === 0 ? -1 : Number(((count / total) * 100).toFixed(1));
}

function frameStats(frames: number[] | undefined): BenchFrameStats {
  const values = frames ?? [];
  const over = (limit: number) =>
    values.length === 0 ? 0 : (values.filter((f) => f > limit).length / values.length) * 100;
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : -1,
    pctOver16: Number(over(16.7).toFixed(1)),
    pctOver32: Number(over(32).toFixed(1)),
    pctOver50: Number(over(50).toFixed(1)),
  };
}

function summarize(label: string, stats?: BenchFrameStats | null): string {
  const s = stats ?? { n: 0, p50: -1, p95: -1, max: -1, pctOver16: 0, pctOver32: 0, pctOver50: 0 };
  return (
    `${label}: n=${s.n}` +
    ` p50=${s.p50}` +
    ` p95=${s.p95}` +
    ` max=${s.max}` +
    ` >16.7ms:${s.pctOver16}%` +
    ` >32ms:${s.pctOver32}%` +
    ` >50ms:${s.pctOver50}%`
  );
}

/**
 * Interaction latency: automation-visible time from a reader interaction
 * (click) to its observable effect (indicator/state change). Includes the
 * automation round trip — consistent across runs, so it is comparable
 * run-over-run in the trend file, not a pure app figure.
 */
async function interactionLatency(
  page: Page,
  action: () => Promise<void>,
  effect: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<number> {
  const start = Date.now();
  await action();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await effect()) return Date.now() - start;
    await page.waitForTimeout(50);
  }
  throw new Error("interaction never took effect");
}

/**
 * Trend record: one JSON line per run appended to bench-trend.jsonl so
 * run-over-run drift (machine noise vs real regression) is visible without
 * any CI gate. Thresholds stay opt-in via BENCH_ENFORCE_P95_MS — CI timing
 * assertions are policy-excluded (docs/PERFORMANCE.md), and a threshold
 * that fires on machine variance is worse than none.
 */
function appendTrend(): void {
  // Build the record from the merged report on disk, not from this
  // instance's memory. After a Playwright worker restart the surviving
  // instance only knows its own sections, and reading its empty ones wrote
  // -1s into the trend line, the same wipe the report file no longer
  // suffers (docs/research/pdf-viewer-perf-findings.md). `commitReport`
  // runs first in afterAll, so the file already holds every scenario.
  const merged = readReport(artifactsDir) ?? report;
  const record = {
    timestamp: merged.timestamp,
    window: merged.environment.window,
    devicePixelRatio: merged.environment.devicePixelRatio,
    pdf: {
      firstRenderLatencyMs: merged.pdf.firstRenderLatencyMs,
      renderP50: percentile(merged.pdf.renderMs, 0.5),
      renderP95: percentile(merged.pdf.renderMs, 0.95),
      pageTurnP50: percentile(merged.pdf.pageTurnLatencyMs, 0.5),
      pageTurnP95: percentile(merged.pdf.pageTurnLatencyMs, 0.95),
      zoomP50: percentile(merged.pdf.zoomLatencyMs, 0.5),
      zoomP95: percentile(merged.pdf.zoomLatencyMs, 0.95),
      wheelSettleP50: percentile(merged.pdf.wheelSettleMs, 0.5),
      bigJumpP50: percentile(merged.pdf.bigJumpLatencyMs, 0.5),
      dragP95: merged.pdf.drag?.p95 ?? null,
      dragDroppedPct: merged.pdf.drag?.pctOver16 ?? null,
      liveCanvasBytes: merged.pdf.liveCanvases?.bytes ?? null,
      // Rapid scroll: how much of the motion shows white, and how long the
      // reader takes to go sharp once the motion stops.
      rapidScrollRenderedSharePct: merged.pdf.rapidScroll?.renderStates?.renderedSharePct ?? null,
      rapidScrollLongestWhiteMs: merged.pdf.rapidScroll?.renderStates?.longestWhiteStreakMs ?? null,
      rapidScrollStopToSharpMs: merged.pdf.rapidScroll?.stopToSharpMs ?? null,
    },
    epub: {
      firstRenderLatencyMs: merged.epub.firstRenderLatencyMs,
      chapterChangeP50: percentile(merged.epub.chapterChangeLatencyMs, 0.5),
      chapterChangeP95: percentile(merged.epub.chapterChangeLatencyMs, 0.95),
      dragP95: merged.epub.drag?.p95 ?? null,
      dragDroppedPct: merged.epub.drag?.pctOver16 ?? null,
    },
  };
  mkdirSync(artifactsDir, { recursive: true });
  const trendFile = path.join(artifactsDir, TREND_FILE_NAME);
  writeFileSync(trendFile, `${JSON.stringify(record)}\n`, { flag: "a" });
  console.log(`[bench] trend appended to ${trendFile}`);

  const enforcedP95 = Number(process.env.BENCH_ENFORCE_P95_MS ?? "");
  if (Number.isFinite(enforcedP95) && enforcedP95 > 0) {
    for (const [label, stats] of [
      ["pdf drag", report.pdf.drag],
      ["epub drag", report.epub.drag],
    ] as const) {
      if (stats && stats.p95 > enforcedP95) {
        throw new Error(
          `[bench] ${label} p95 frame time ${stats.p95}ms exceeds the enforced budget ` +
            `${enforcedP95}ms (BENCH_ENFORCE_P95_MS). Compare with bench-trend.jsonl before raising it.`,
        );
      }
    }
  }
}

/**
 * Persist the report so far. The suite calls it after every scenario,
 * through `test.afterEach`, which runs whether the scenario passed or
 * failed. The merge in setup/bench-report.ts folds this instance's numbers
 * into whatever earlier scenarios already wrote, so a scenario that fails,
 * or a worker restart that re-instantiates this module, cannot take the
 * completed scenarios' numbers out of the file.
 */
function commitReport(): void {
  const file = updateReport(artifactsDir, report);
  console.log(`[bench] report merged into ${file}`);
}

function logReportSummary(): void {
  if (report.pdf.drag) {
    console.log(`[bench] ${summarize("pdf drag frame ms", report.pdf.drag)}`);
    console.log(`[bench] ${summarize("pdf idle frame ms", report.pdf.idle ?? undefined)}`);
    console.log(
      `[bench] ${summarize("pdf render->blit during drag", frameStats(report.pdf.drag.renderMsDuringDrag))}`,
    );
  }
  if (report.epub.drag) {
    console.log(`[bench] ${summarize("epub drag frame ms", report.epub.drag)}`);
    console.log(`[bench] ${summarize("epub idle frame ms", report.epub.idle ?? undefined)}`);
    console.log(
      `[bench] epub drag: wall=${report.epub.drag.wallMs}ms distance=${report.epub.drag.distancePx}px jumps=${report.epub.drag.sectionJumps}`,
    );
    if (report.epub.measure !== null)
      console.log(`[bench] epub measure cap: ${report.epub.measure}`);
  }
  if (report.pdf.renderMs.length > 0) {
    console.log(
      `[bench] ${summarize("pdf page-walk render->blit ms", frameStats(report.pdf.renderMs))}`,
    );
  }
  if (report.pdf.rapidScroll) {
    const rapid = report.pdf.rapidScroll;
    const states = rapid.renderStates;
    if (states) {
      console.log(
        `[bench] pdf rapid scroll: ${rapid.wheelEvents} wheel events, ` +
          `${rapid.distancePx}px in ${rapid.motionMs.toFixed(0)}ms; ` +
          `render states n=${states.samples} rendered=${states.renderedSharePct}% ` +
          `rendering=${states.renderingSharePct}% white=${states.white} ` +
          `longest white streak=${states.longestWhiteStreakMs}ms`,
      );
    }
    console.log(`[bench] pdf stop-to-sharp: ${rapid.stopToSharpMs}ms`);
  }
}

/**
 * Position change probe for the EPUB phase: shell percent, the engine's
 * pinned in-section fraction/section attributes, and the flow layout —
 * all deterministic DOM attributes on the reading surface (docs/EPUB.md
 * testability contract), so the probe survives engine swaps. Read-only.
 */
const epubPositionProbe = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const percent = document.querySelector("[data-testid=reader-position]")?.textContent ?? "";
    const host = document.querySelector("[data-epub-host]");
    const reader = document.querySelector("[data-testid=epub-reader]");
    const fraction = host?.getAttribute("data-epub-fraction") ?? "?";
    const section = host?.getAttribute("data-epub-section") ?? "?";
    const flow = reader?.getAttribute("data-layout") ?? "?";
    return `${percent}|${fraction}|${section}|${flow}`;
  });

/**
 * Synthetic scrollbar drag: `pxPerFrame` continuous scroll deltas per ~16ms
 * tick — the same mutation a dragged scrollbar performs — while single-shot
 * rAF samples record frame cadence (main-thread stalls surface as long
 * deltas between consecutive frame timestamps). PDF drives the shell's
 * scroll container directly. EPUB scrolled flow drives whichever element
 * actually scrolls — the section frame's inner scrolling document in the
 * Readium engine — assigning raw scroll offsets so the drag follows content
 * continuously. A drag stalled at a section end turns to the next section
 * through the window-level page-turn shortcut, like a reader crossing into
 * it.
 */
const dragScroll = (
  page: Page,
  format: "pdf" | "epub",
  maxFrames: number,
  pxPerFrame: number,
): Promise<DragResult> =>
  page.evaluate(
    async ({ fmt, max, px }) => {
      const container = document.querySelector("[data-testid=reader-content]");
      const epubScroll = (): { el: Element | null; pos: number } => {
        for (const frame of document.querySelectorAll<HTMLIFrameElement>(
          "[data-epub-host] iframe",
        )) {
          try {
            const doc = frame.contentDocument;
            const scroller = doc?.scrollingElement ?? null;
            if (doc && scroller && scroller.scrollHeight > scroller.clientHeight + 4) {
              return { el: scroller, pos: scroller.scrollTop };
            }
          } catch {
            continue;
          }
        }
        return { el: null, pos: 0 };
      };
      const startedAt = performance.now();
      const stamps: number[] = [];
      const renderMs: number[] = [];
      let distancePx = 0;
      let last = startedAt;
      let count = 0;
      let stalls = 0;
      let lastPos = fmt === "epub" ? epubScroll().pos : 0;
      let jumps = 0;
      await new Promise<number>((resolve) => {
        // Sampler at 8 ms: registration must be faster than the frame clock
        // or a 16 ms tick beats against 16.7 ms frames and biases deltas to
        // double intervals. Duplicate same-frame registrations are filtered
        // by the monotonic check below.
        const sampler = window.setInterval(() => {
          requestAnimationFrame((now) => {
            if (now > last) {
              stamps.push(now - last);
              last = now;
            }
          });
        }, 8);
        const timer = window.setInterval(() => {
          if (fmt === "pdf") {
            if (container) {
              const before = container.scrollTop;
              container.scrollTop = before + px;
              distancePx += Math.abs(container.scrollTop - before);
            }
            if (count % 4 === 0) {
              document.querySelectorAll("[data-testid=pdf-canvas]").forEach((canvas) => {
                const attr = canvas.getAttribute("data-pdf-render-ms") ?? "";
                const value = Number(attr.split(";").filter(Boolean).pop());
                if (!Number.isNaN(value)) renderMs.push(value);
              });
            }
          } else {
            const scroller = epubScroll();
            if (scroller.el === null || Math.abs(scroller.pos - lastPos) < 1) {
              stalls += 1;
              if (stalls >= 12) {
                // Section end: turn through the window-level page-turn
                // shortcut (the engine owns these combos while an EPUB is
                // open).
                window.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
                );
                jumps += 1;
                stalls = 0;
              }
            } else {
              stalls = 0;
              distancePx += Math.abs(scroller.pos - lastPos);
              lastPos = scroller.pos;
            }
            const el = scroller.el;
            if (el) {
              // Raw offset assignment, unclamped: the drag follows content.
              el.scrollTop = scroller.pos + px;
            }
          }
          count += 1;
          if (count >= max) {
            window.clearInterval(timer);
            window.clearInterval(sampler);
            resolve(distancePx);
          }
        }, 16);
      });
      return {
        frames: stamps,
        renderMs,
        wallMs: performance.now() - startedAt,
        distancePx,
        sectionJumps: jumps,
      };
    },
    { fmt: format, max: maxFrames, px: pxPerFrame },
  );

/**
 * Idle frame-cadence sample: records rAF intervals while nothing scrolls.
 * This is the environment's baseline cadence (compositor + display) — drag
 * deltas are only meaningful relative to it: if idle already runs at
 * ~40 ms, the ceiling is the rendering stack, not scroll jank.
 *
 * Registration cadence must be FASTER than the frame clock (8 ms): a 16 ms
 * interval beats against 16.7 ms frames and lands some ticks in the same
 * frame, biasing deltas to double intervals.
 */
const sampleIdleFrames = (page: Page, maxFrames: number): Promise<number[]> =>
  page.evaluate(async (max) => {
    const stamps: number[] = [];
    let last = performance.now();
    let count = 0;
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        requestAnimationFrame((now) => {
          if (now > last) {
            stamps.push(now - last);
            last = now;
          }
        });
        count += 1;
        if (count >= max) {
          window.clearInterval(timer);
          resolve();
        }
      }, 8);
    });
    return stamps;
  }, maxFrames);

/**
 * Rapid-scroll sampling, browser-side (docs/PERFORMANCE.md "How to measure").
 *
 * One evaluate installs the sampler and leaves it running while the Node
 * side drives real wheel input; the second stops it and measures the settle.
 * Everything lives in the page so the automation round trip stays out of the
 * numbers: the sample timestamps, the wheel-event timestamps, and the
 * stop-to-sharp interval are all `performance.now()` values taken there.
 *
 * Each sample is the render state of the slot under the viewport centre,
 * which is the page the reader is actually looking at. The state comes from
 * the `data-render-state` attribute the reader already publishes, so the
 * probe observes the reader's own account of its state and no internals.
 * The geometry comes from live bounding boxes, which keeps the probe
 * tracking the scroll instead of naming a page number.
 */
const startScrollSampler = (page: Page): Promise<void> =>
  page.evaluate((sampleMs) => {
    interface RapidScrollSampler {
      samples: { at: number; state: string }[];
      wheelCount: number;
      firstWheelAt: number;
      lastWheelAt: number;
      distancePx: number;
      scrollTop: number | null;
      timer: number;
      /** Render state of the slot under the viewport centre. */
      viewportSlotState(): string;
      /** Render states of the slots currently intersecting the viewport. */
      visibleStates(): string[];
    }

    const centreSlot = (): HTMLElement | null => {
      const container = document.querySelector("[data-testid=reader-content]");
      if (!container) return null;
      const box = container.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      for (const slot of document.querySelectorAll<HTMLElement>("[data-pdf-slot]")) {
        const slotBox = slot.getBoundingClientRect();
        if (x >= slotBox.left && x < slotBox.right && y >= slotBox.top && y < slotBox.bottom) {
          return slot;
        }
      }
      return null;
    };

    const sampler: RapidScrollSampler = {
      samples: [],
      wheelCount: 0,
      firstWheelAt: 0,
      lastWheelAt: 0,
      distancePx: 0,
      scrollTop: null,
      timer: 0,
      viewportSlotState: () => centreSlot()?.getAttribute("data-render-state") ?? "no-slot",
      visibleStates: () => {
        const container = document.querySelector("[data-testid=reader-content]");
        if (!container) return [];
        const view = container.getBoundingClientRect();
        const states: string[] = [];
        for (const slot of document.querySelectorAll<HTMLElement>("[data-pdf-slot]")) {
          const box = slot.getBoundingClientRect();
          if (box.bottom > view.top && box.top < view.bottom) {
            states.push(slot.getAttribute("data-render-state") ?? "no-state");
          }
        }
        return states;
      },
    };

    window.addEventListener(
      "wheel",
      () => {
        const now = performance.now();
        sampler.wheelCount += 1;
        if (sampler.firstWheelAt === 0) sampler.firstWheelAt = now;
        sampler.lastWheelAt = now;
      },
      { passive: true },
    );
    sampler.timer = window.setInterval(() => {
      const top = document.querySelector("[data-testid=reader-content]")?.scrollTop ?? 0;
      if (sampler.scrollTop !== null) sampler.distancePx += Math.abs(top - sampler.scrollTop);
      sampler.scrollTop = top;
      sampler.samples.push({ at: performance.now(), state: sampler.viewportSlotState() });
    }, sampleMs);

    (window as unknown as Record<string, unknown>).__benchRapidScroll = sampler;
  }, RAPID_SCROLL_SAMPLE_MS);

/**
 * What `finishScrollSampling` reads back out of the page: the motion, plus
 * the handle fields the page side keeps for itself.
 */
interface StoredScrollSampler extends ScrollSamplerResult {
  timer: number;
  visibleStates(): string[];
}

/** Motion, plus the settle measured after it. */
interface ScrollSettleResult extends ScrollSamplerResult {
  stopToSharpMs: number;
}

/**
 * Stop the sampler and measure stop-to-sharp: the time from the last wheel
 * event to the moment every slot intersecting the viewport reads `rendered`.
 * Measured from the browser-side wheel timestamp rather than from this
 * call's arrival, so the Node round trip that ends the motion never lands
 * in the metric. A slot that errored counts as not sharp, because the
 * contract is "every visible slot rendered". The -1 sentinel says the
 * reader never got there inside the bound.
 *
 * The visible set is deliberate. The same question asked of every mounted
 * slot (overscan included) did not go sharp within a 30 s bound, so at
 * least one mounted slot sits outside `rendered` even once the viewport is
 * sharp. Waiting on those is not the contract, and the recorded baseline
 * says "all visible slots" too.
 */
const finishScrollSampling = (page: Page, sharpTimeoutMs: number): Promise<ScrollSettleResult> =>
  page.evaluate(async (limit) => {
    const sampler = (window as unknown as Record<string, StoredScrollSampler | undefined>)
      .__benchRapidScroll;
    if (!sampler) throw new Error("rapid-scroll sampler was never started");
    window.clearInterval(sampler.timer);

    let stopToSharpMs = -1;
    for (;;) {
      const sinceLastWheel = performance.now() - sampler.lastWheelAt;
      const states = sampler.visibleStates();
      if (states.length > 0 && states.every((state) => state === "rendered")) {
        stopToSharpMs = sinceLastWheel;
        break;
      }
      if (sinceLastWheel > limit) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return {
      samples: sampler.samples,
      wheelCount: sampler.wheelCount,
      firstWheelAt: sampler.firstWheelAt,
      lastWheelAt: sampler.lastWheelAt,
      distancePx: sampler.distancePx,
      stopToSharpMs,
    };
  }, sharpTimeoutMs);

/** Turn the sampler's raw motion into the numbers the bench reports. */
function summarizeRapidScroll(motion: ScrollSettleResult): RapidScrollResult {
  const counts = new Map<string, number>();
  for (const sample of motion.samples) {
    counts.set(sample.state, (counts.get(sample.state) ?? 0) + 1);
  }
  const samples = motion.samples.length;
  const rendered = counts.get("rendered") ?? 0;
  const rendering = counts.get("rendering") ?? 0;
  const unloaded = counts.get("unloaded") ?? 0;

  // The white placeholder is any state that shows no pixels, so the longest
  // white run is the longest stretch of consecutive samples that never
  // reached `rendered`. That run is the reported symptom, "white for
  // seconds".
  let runStartedAt: number | null = null;
  let longestWhiteStreakMs = 0;
  for (const sample of motion.samples) {
    if (sample.state === "rendered") {
      runStartedAt = null;
      continue;
    }
    if (runStartedAt === null) runStartedAt = sample.at;
    longestWhiteStreakMs = Math.max(longestWhiteStreakMs, sample.at - runStartedAt);
  }

  const renderStates: RenderStateShare = {
    samples,
    rendered,
    rendering,
    unloaded,
    white: samples - rendered,
    other: samples - rendered - rendering - unloaded,
    renderedSharePct: sharePct(rendered, samples),
    renderingSharePct: sharePct(rendering, samples),
    longestWhiteStreakMs,
  };

  return {
    wheelEvents: motion.wheelCount,
    distancePx: motion.distancePx,
    // No wheel event ever arrived: both timestamps stay at 0 and the
    // interval would be meaningless, so report a motion window of 0.
    motionMs: motion.firstWheelAt > 0 ? motion.lastWheelAt - motion.firstWheelAt : 0,
    renderStates: samples > 0 ? renderStates : null,
    stopToSharpMs: motion.stopToSharpMs,
  };
}

test.describe("reader performance benchmark", () => {
  /**
   * Persist the report after every scenario, whether it passed or failed.
   * Each commit merges into what is already on disk (setup/bench-report.ts),
   * so the file holds every scenario that finished. A later scenario that
   * fails, or a worker restart that re-instantiates this module with an
   * empty report, cannot take the completed scenarios' numbers with it.
   */
  test.afterEach(() => {
    commitReport();
  });

  /**
   * Reference conditions are a maximized window (docs/PERFORMANCE.md); an
   * explicit `just bench-reader WxH` argument overrides for targeted
   * geometries. The applied size is what the report records. Sizing goes
   * through the renderer's window.resizeTo — the real OS window is what
   * the reader lays out against. Idempotent; called at each scenario start.
   */
  async function prepareBenchEnvironment(page: Page): Promise<void> {
    report.environment.userAgent = await page.evaluate(() => navigator.userAgent);
    report.environment.devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    const requested = process.env.BENCH_WINDOW_SIZE ?? "";
    const match = /^(\d+)x(\d+)$/.exec(requested);
    if (match) {
      await page.evaluate(
        ([w, h]) => window.resizeTo(w!, h!),
        [Number(match[1]), Number(match[2])],
      );
    } else {
      await page.evaluate(() =>
        window.resizeTo(window.screen.availWidth, window.screen.availHeight),
      );
    }
    await expect
      .poll(async () => {
        const target = match
          ? { width: Number(match[1]), height: Number(match[2]) }
          : await page.evaluate(() => ({
              width: window.screen.availWidth,
              height: window.screen.availHeight,
            }));
        // Re-issue the resize each sample: the renderer-applied size can
        // lag the request, and a window that drifted back to its default
        // geometry must be re-driven, not just awaited.
        await page.evaluate(([w, h]) => window.resizeTo(w!, h!), [target.width, target.height]);
        await page.waitForTimeout(200);
        const size = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.outerHeight,
        }));
        // Height tolerance is wider than width: outerHeight includes the WM
        // title bar, and some desktops report an availHeight the granted
        // outer size can never reach by exactly that decoration height
        // (observed: a stable 28px shortfall). The bench needs a big,
        // stable window — the last few title-bar pixels are immaterial.
        const ok =
          Math.abs(size.width - target.width) <= 8 && Math.abs(size.height - target.height) <= 40;
        if (!ok) {
          console.log(`[diag] size=${JSON.stringify(size)} target=${JSON.stringify(target)}`);
        }
        return ok;
      })
      .toBe(true);
    // The applied size from the renderer.
    const applied = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.outerHeight,
    }));
    report.environment.window = { width: applied.width, height: applied.height };
    console.log(
      `[bench] window ${applied.width}x${applied.height} dpr ${report.environment.devicePixelRatio}`,
    );
  }

  test("pdf: page-walk render→blit latency from mid-book with budget checks", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);
    test.skip(!existsSync(benchPdfFixture), "gitignored real-book fixture absent on this machine");

    await prepareBenchEnvironment(page);

    // First-render latency: launch-to-first-page on the real-book fixture
    // (open + engine init + first page bitmap) — the cold-open cost a
    // reader feels when opening a book.
    const firstRenderStart = Date.now();
    await openInReader(page, benchBookTitles.pdf);
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    try {
      await waitForRendered(page, 1, 90_000);
    } catch (err) {
      // Diagnose from artifacts: which page is the reader actually on, and
      // what state are the first slots in?
      const probe = await page.evaluate(() => ({
        indicator: document.querySelector("[data-testid=pdf-page-indicator]")?.textContent ?? "",
        slots: Array.from(document.querySelectorAll("[data-pdf-slot]"))
          .slice(0, 5)
          .map((slot) => ({
            page: slot.getAttribute("data-pdf-slot"),
            state: slot.getAttribute("data-render-state"),
          })),
      }));
      console.log(`[bench] first-render probe: ${JSON.stringify(probe)}`);
      throw err;
    }
    report.pdf.firstRenderLatencyMs = Date.now() - firstRenderStart;
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of", {
      timeout: 30_000,
    });
    report.environment.pdfRenderInfo = await page.evaluate(
      () =>
        document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-render-info") ??
        null,
    );

    const total = Number((await textOf(page, "pdf-page-indicator")).match(/of (\d+)/)![1]);
    // Walk from the middle of the book: front matter and the ToC are the
    // least representative pages in the document.
    const startPage = Math.max(1, Math.floor(total / 2));
    report.pdf.startPage = startPage;
    await scrollToSlot(page, startPage);
    await waitForRendered(page, startPage, 60_000);

    const walkTo = Math.min(startPage + PDF_WALK_PAGES, total);
    for (let pageNumber = startPage; pageNumber <= walkTo; pageNumber++) {
      await scrollToSlot(page, pageNumber);
      await waitForRendered(page, pageNumber, 60_000);
      const sample = await page.evaluate((target) => {
        const canvas = document.querySelector(
          `[data-testid=pdf-canvas][data-pdf-page="${target}"]`,
        ) as HTMLCanvasElement | null;
        if (!canvas) return null;
        const durations = (canvas.getAttribute("data-pdf-render-ms") ?? "")
          .split(";")
          .filter(Boolean)
          .map(Number);
        return {
          ms: durations[durations.length - 1] ?? -1,
          bufferPx: canvas.width * canvas.height,
          maxSide: Math.max(canvas.width, canvas.height),
        };
      }, pageNumber);
      if (sample && sample.ms >= 0) {
        report.pdf.renderMs.push(sample.ms);
        report.pdf.buffers.push({
          page: pageNumber,
          bufferPx: sample.bufferPx,
          maxSide: sample.maxSide,
        });
      }
    }

    // PERF-1 (deterministic): every walked buffer stays under the caps.
    expect(report.pdf.buffers.length).toBeGreaterThan(0);
    for (const buffer of report.pdf.buffers) {
      expect(buffer.bufferPx).toBeLessThanOrEqual(2 ** 25);
      expect(buffer.maxSide).toBeLessThanOrEqual(8192);
    }

    // PERF-4 (derived from slot/canvas state): live canvases within the
    // count cap and the per-window byte bound.
    const memory = await pdfSurfaceMemory(page);
    const onePage = await maxSingleBitmapBytes(page, 1);
    report.pdf.liveCanvases = {
      count: memory.pageCanvases,
      bytes: memory.pageBytes,
      onePageBound: onePage,
    };
    expect(memory.pageCanvases).toBeLessThanOrEqual(8);
    expect(memory.pageBytes).toBeLessThanOrEqual(8 * onePage);

    // PERF-3 (deterministic attribute): one down-up oscillation must
    // retain ≥ 2 buffers in the bitmap cache.
    const down = Math.min(walkTo + 1, total);
    await scrollToSlot(page, down);
    await waitForRendered(page, down, 60_000);
    await scrollToSlot(page, walkTo);
    await waitForRendered(page, walkTo, 60_000);
    const cache = await bitmapCacheUsage(page);
    report.pdf.cacheAfterOscillation = cache;
    expect(cache).not.toBeNull();
    expect(cache!.entries).toBeGreaterThanOrEqual(2);

    await returnToLibrary(page);
  });

  test("pdf: scrollbar-drag frame timing through mid-book content", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);

    await prepareBenchEnvironment(page);

    await openInReader(page, benchBookTitles.pdf);
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of", {
      timeout: 30_000,
    });
    const total = Number((await textOf(page, "pdf-page-indicator")).match(/of (\d+)/)![1]);
    await scrollToSlot(page, Math.max(1, Math.floor(total / 2)));
    await waitForRendered(page, Math.max(1, Math.floor(total / 2)), 60_000);

    const drag = await dragScroll(page, "pdf", DRAG_FRAMES, PDF_DRAG_PX_PER_FRAME);
    const idle = await sampleIdleFrames(page, 60);
    report.pdf.idle = frameStats(idle);
    report.pdf.drag = {
      ...frameStats(drag.frames),
      wallMs: drag.wallMs,
      distancePx: drag.distancePx,
      renderMsDuringDrag: drag.renderMs,
    };
    expect(drag.frames.length).toBeGreaterThan(DRAG_FRAMES / 2);
    expect(drag.distancePx).toBeGreaterThan(0);

    await returnToLibrary(page);
  });

  /**
   * Rapid scroll through mid-book, measuring the reported symptom. Real
   * wheel input at flick pace over the reader content, a 25 ms sample of the
   * render state under the viewport centre while the document moves, then
   * the time until every visible slot is sharp once the motion stops.
   *
   * The recorded baseline (docs/research/pdf-viewer-perf-findings.md,
   * 2026-10-23) is what this scenario reproduces and what a fix is judged
   * against: 98% of the motion spent in `rendering`, an 8,400 ms longest
   * white streak, and 314 ms to sharp after the stop.
   */
  test("pdf: rapid-scroll render-state distribution and stop-to-sharp", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);
    test.skip(!existsSync(benchPdfFixture), "gitignored real-book fixture absent on this machine");

    await prepareBenchEnvironment(page);

    await openInReader(page, benchBookTitles.pdf);
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of", { timeout: 30_000 });
    const total = Number((await textOf(page, "pdf-page-indicator")).match(/of (\d+)/)![1]);
    const startPage = Math.max(1, Math.floor(total / 2));
    await scrollToSlot(page, startPage);
    await waitForRendered(page, startPage, 60_000);

    // The wheel lands where the pointer is, so centre it over the reader
    // content, at the same position the wheel-settle scenario samples from.
    await page.mouse.move(
      (report.environment.window.width ?? 1280) / 2,
      (report.environment.window.height ?? 800) / 2,
    );

    await startScrollSampler(page);
    const startedAt = Date.now();
    for (let event = 0; event < RAPID_SCROLL_WHEEL_EVENTS; event++) {
      await page.mouse.wheel(0, RAPID_SCROLL_WHEEL_PX);
      // Pace the input to the recorded baseline instead of letting the
      // automation round trip set the speed. The distribution is only
      // comparable to the baseline if the scroll runs at the baseline's
      // speed.
      const dueAt = startedAt + (event + 1) * RAPID_SCROLL_WHEEL_INTERVAL_MS;
      const wait = dueAt - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
    }
    const motion = await finishScrollSampling(page, RAPID_SCROLL_SHARP_TIMEOUT_MS);

    // The wheel must actually move the document, or the distribution below
    // describes a stalled reader rather than a scrolling one.
    expect(motion.distancePx).toBeGreaterThan(0);
    expect(motion.samples.length).toBeGreaterThan(0);

    report.pdf.rapidScroll = summarizeRapidScroll(motion);

    await returnToLibrary(page);
  });

  test("pdf: rapid page-turn and zoom interaction latency", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);
    test.skip(!existsSync(benchPdfFixture), "gitignored real-book fixture absent on this machine");

    await prepareBenchEnvironment(page);

    await openInReader(page, benchBookTitles.pdf);
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of", {
      timeout: 30_000,
    });
    const total = Number((await textOf(page, "pdf-page-indicator")).match(/of (\d+)/)![1]);
    const startPage = Math.max(1, Math.floor(total / 2));
    await scrollToSlot(page, startPage);
    await waitForRendered(page, startPage, 60_000);

    const indicatorPage = async () =>
      Number((await textOf(page, "pdf-page-indicator")).match(/Page (\d+)/)?.[1]);

    // Rapid page turning: the toolbar's next/prev buttons, one sample each —
    // the interaction a reader repeats most. Turn down five pages, then up.
    for (let i = 0; i < 5; i++) {
      const before = await indicatorPage();
      const after = await interactionLatency(
        page,
        () => page.getByTestId("pdf-next").click(),
        async () => (await indicatorPage()) === before + 1,
      );
      report.pdf.pageTurnLatencyMs.push(after);
    }
    for (let i = 0; i < 3; i++) {
      const before = await indicatorPage();
      const after = await interactionLatency(
        page,
        () => page.getByTestId("pdf-prev").click(),
        async () => (await indicatorPage()) === before - 1,
      );
      report.pdf.pageTurnLatencyMs.push(after);
    }

    // Zoom in/out: each step relayouts and re-renders the window; the
    // observable effect is the zoom label (geometry streams in after). The
    // buttons disable at the ends of the zoom ladder — stop there.
    const zoomSteps = async (direction: "in" | "out"): Promise<void> => {
      for (let i = 0; i < 2; i++) {
        const button = page.getByTestId(`pdf-zoom-${direction}`);
        if ((await button.getAttribute("disabled")) !== null) break;
        const before = await inputValueOf(page, "pdf-zoom-input");
        const after = await interactionLatency(
          page,
          () => button.click(),
          async () => (await inputValueOf(page, "pdf-zoom-input")) !== before,
        );
        report.pdf.zoomLatencyMs.push(after);
      }
    };
    await zoomSteps("in");
    await zoomSteps("out");

    // Ctrl+wheel gesture settle: the page follows the wheel through a CSS
    // transform preview; the sharp raster commits WHEEL_SETTLE_MS after the
    // last event. Samples run after the preset steps so the gesture starts
    // from a settled layout. Measured: last wheel event → the anchor slot
    // rasterized at the new scale (settle + first sharp raster).
    await page.mouse.move(
      (report.environment.window.width ?? 1280) / 2,
      (report.environment.window.height ?? 800) / 2,
    );
    for (let i = 0; i < 3; i++) {
      // The anchor is the page being read, not the first canvas in DOM order:
      // the render window keeps a neighbour's preview canvas mounted first, so
      // the first canvas is often not the anchor and never re-rasterizes.
      // The settle signal is a new `data-pdf-render-ms` sample on the anchor
      // canvas, not a backing-store width change: above the whole-page budget
      // the canvas is a viewport-clipped region whose pixel width is fixed at
      // the display size, so it never changes with zoom.
      const anchorPage = Number(
        (await textOf(page, "pdf-page-indicator")).match(/Page (\d+)/)?.[1],
      );
      const before = await page.evaluate((target) => {
        const slot = document.querySelector(`[data-pdf-slot="${target}"]`);
        const canvas = slot?.querySelector<HTMLCanvasElement>("[data-testid=pdf-canvas]");
        return {
          renderMs: canvas?.getAttribute("data-pdf-render-ms") ?? "",
          slot: String(target),
        };
      }, anchorPage);
      const start = Date.now();
      await page.keyboard.down("Control");
      for (let tick = 0; tick < 3; tick++) await page.mouse.wheel(0, -120);
      await page.keyboard.up("Control");
      await expect
        .poll(async () => {
          const state = await page.evaluate((target) => {
            const slot = document.querySelector(`[data-pdf-slot="${target}"]`);
            const canvas = slot?.querySelector<HTMLCanvasElement>("[data-testid=pdf-canvas]");
            return {
              rendered: slot?.getAttribute("data-render-state"),
              renderMs: canvas?.getAttribute("data-pdf-render-ms") ?? "",
            };
          }, before.slot);
          return state.rendered === "rendered" && state.renderMs !== before.renderMs;
        })
        .toBe(true);
      report.pdf.wheelSettleMs.push(Date.now() - start);
    }
    // Leave the big-jump walk at a comparable zoom to previous runs. The
    // reset re-anchors the document asynchronously; let it settle before the
    // jump samples, or the pending re-anchor clobbers the first jump back to
    // the top (observed: the scroll lands, then the re-anchor resets it).
    await page.keyboard.press("Control+0");
    await page.waitForTimeout(800);

    // Large-document navigation: long scroll jumps across a third of the
    // document — the virtualization + eviction path under displacement.
    const jumpTargets = [
      startPage,
      Math.max(1, startPage - 30),
      Math.min(total, startPage + 30),
      startPage,
    ];
    for (let i = 1; i < jumpTargets.length; i++) {
      const target = jumpTargets[i]!;
      const after = await interactionLatency(
        page,
        () => scrollToSlot(page, target),
        async () => (await indicatorPage()) === target,
      );
      report.pdf.bigJumpLatencyMs.push(after);
    }

    console.log(
      `[bench] ${summarize("pdf page-turn latency", frameStats(report.pdf.pageTurnLatencyMs))}`,
    );
    console.log(`[bench] ${summarize("pdf zoom latency", frameStats(report.pdf.zoomLatencyMs))}`);
    console.log(
      `[bench] wheel settle ms: ${report.pdf.wheelSettleMs.map((ms) => ms.toFixed(0)).join(", ")}`,
    );
    console.log(
      `[bench] ${summarize("pdf big-jump nav latency", frameStats(report.pdf.bigJumpLatencyMs))}`,
    );

    await returnToLibrary(page);
  });

  test("epub: chapter-change interaction latency", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);

    await prepareBenchEnvironment(page);

    const openStart = Date.now();
    await openInReader(page, benchBookTitles.epub);
    const host = page.locator("div[data-epub-host]");
    await host.waitFor({ state: "attached", timeout: 30_000 });
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30_000 });
    report.epub.firstRenderLatencyMs = Date.now() - openStart;

    // Chapter changes through the contents drawer: open drawer → click TOC
    // entry → engine lands on the section. TOC entry indices are not spine
    // section indices in a real book, so the latency is measured to a
    // section CHANGE from the pre-click value; entries that resolve to the
    // section we are already in are skipped, not failed.
    const sectionNow = async () =>
      page.evaluate(
        () =>
          document
            .querySelector("[data-testid=epub-reader] [data-epub-host]")
            ?.getAttribute("data-epub-section") ?? null,
      );
    // Query per iteration by index, up to the first 8 entries, until 3
    // changes have been sampled.
    for (let index = 0; index < 8 && report.epub.chapterChangeLatencyMs.length < 3; index++) {
      await openReaderNavigation(page);
      const item = page.getByTestId(`toc-item-${index}`);
      if ((await item.count()) === 0) break;
      const before = await sectionNow();
      const changed = await interactionLatency(
        page,
        () => item.click(),
        async () => (await sectionNow()) !== before,
        10_000,
      )
        .then((ms) => {
          report.epub.chapterChangeLatencyMs.push(ms);
          return true;
        })
        .catch(() => false);
      // The drawer closes itself on a successful navigation; a no-op entry
      // leaves it open — normalize either way before the next sample.
      if (changed) {
        await page
          .getByTestId("reader-nav")
          .waitFor({ state: "detached", timeout: 10_000 })
          .catch(() => {});
      } else {
        await closeReaderNavigation(page);
      }
    }
    expect(report.epub.chapterChangeLatencyMs.length).toBeGreaterThanOrEqual(3);
    console.log(
      `[bench] ${summarize("epub chapter-change latency", frameStats(report.epub.chapterChangeLatencyMs))}`,
    );

    await returnToLibrary(page);
  });

  test("epub: scrolled-flow scrollbar-drag frame timing from mid-book", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);

    await prepareBenchEnvironment(page);

    await openInReader(page, benchBookTitles.epub);
    const host = page.locator("div[data-epub-host]");
    await host.waitFor({ state: "attached", timeout: 30_000 });
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30_000 });

    // Continuous layout: fresh sessions default to paginated (the
    // preference is not persisted), and this suite measures scrolling.
    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 10_000 });
    const layoutItems = page.locator('[data-testid="pref-layout"] button');
    expect(await layoutItems.count()).toBe(2);
    const label = await layoutItems.nth(1).textContent();
    expect(label).toBe("Scrolling");
    // The popover's enter/exit animation can swallow the layout click —
    // re-drive it until the flow lands on the reader surface as a pinned
    // attribute (docs/EPUB.md testability contract).
    let applied = false;
    for (let attempt = 0; attempt < 3 && !applied; attempt++) {
      await layoutItems.nth(1).click();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if ((await epubPositionProbe(page)).endsWith("|scrolling")) {
          applied = true;
          break;
        }
        await page.waitForTimeout(250);
      }
    }
    expect(applied).toBe(true);
    await page.keyboard.press("Escape");

    // PERF-12: the scrolled reading surface must be measure-capped.
    // Deterministic DOM attribute — timing assertions stay out of E2E.
    await expect
      .poll(async () => (await page.locator("div[data-epub-measure=capped]").count()) > 0, {
        timeout: 10_000,
      })
      .toBe(true);
    report.epub.measure = await page.evaluate(
      () => document.querySelector<HTMLElement>("[data-epub-measure]")?.style.maxWidth ?? "",
    );

    // Jump deep into the book through the shell's End shortcut (the shell
    // maps the position onto the engine's nearest position): front matter
    // and the ToC are the least representative content. The pre-jump probe
    // is captured first so "changed" is measured against where the restored
    // session had put us.
    const beforeJump = await epubPositionProbe(page);
    await page.keyboard.press("End");
    await expect
      .poll(async () => (await epubPositionProbe(page)) !== beforeJump, { timeout: 10_000 })
      .toBe(true);

    const drag = await dragScroll(page, "epub", DRAG_FRAMES, EPUB_DRAG_PX_PER_FRAME);
    const idle = await sampleIdleFrames(page, 60);
    report.epub.idle = frameStats(idle);
    report.epub.drag = {
      ...frameStats(drag.frames),
      wallMs: drag.wallMs,
      distancePx: drag.distancePx,
      sectionJumps: drag.sectionJumps,
    };
    expect(drag.frames.length).toBeGreaterThan(DRAG_FRAMES / 2);

    await returnToLibrary(page);
  });

  test.afterAll(() => {
    commitReport();
    logReportSummary();
    appendTrend();
  });
});
