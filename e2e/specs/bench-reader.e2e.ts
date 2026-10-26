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
  recordScenario,
  readBenchReport,
  type BenchEnvironment,
  type BenchReport,
  type FrameStats,
  type PdfRapidScrollResult,
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
 * Each scenario persists its own section into bench-results.json as soon as
 * it has collected its numbers (e2e/setup/bench-report.ts), so a scenario
 * that fails late — or a worker restart — no longer wipes the results
 * already collected.
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
 * Rapid-scroll pass (issue tuxbooks-x27.1): the fast continuous wheel
 * gesture the white-slot complaint is about. Constants mirror the baseline
 * capture in docs/research/pdf-viewer-perf-findings.md — 260 wheel events
 * of 600 px over ~9.0 s, sampled every 25 ms.
 */
const RAPID_WHEEL_EVENTS = 260;
const RAPID_WHEEL_PX_PER_EVENT = 600;
const RAPID_WHEEL_CADENCE_MS = 34.5;
const RAPID_SAMPLE_MS = 25;
/** Post-stop bound until the suite calls stop-to-sharp "never" (null). */
const RAPID_STOP_TIMEOUT_MS = 30_000;
/** Hard bound on a sampler's life, so a wedged scenario leaks no sampling. */
const RAPID_MAX_LIFETIME_MS = 60_000;

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
 * What the browser-side rapid-scroll sampler reports back; the Node side
 * adds the scenario's start page and per-event pixel constant.
 */
type RapidSampled = Omit<PdfRapidScrollResult, "startPage" | "pxPerWheelEvent">;

interface RapidHandle {
  stop(): void;
  done: Promise<RapidSampled>;
}

const reportFile = path.join(artifactsDir, "bench-results.json");

/** p-value of a sample list (0.5 = median); -1 when empty. */
function percentile(values: number[] | undefined, p: number): number {
  if (!values || values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function frameStats(frames: number[] | undefined): FrameStats {
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

function summarize(label: string, stats?: FrameStats | null): string {
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

/** The scenario sections, looked up once per reporting pass. */
function scenarioSections(report: BenchReport) {
  return {
    walk: report.scenarios["pdf-page-walk"],
    pdfDrag: report.scenarios["pdf-scroll-drag"],
    interaction: report.scenarios["pdf-interaction"],
    rapid: report.scenarios["pdf-rapid-scroll"],
    chapter: report.scenarios["epub-chapter-change"],
    epubDrag: report.scenarios["epub-scroll-drag"],
  };
}

/** The one-line trend record, derived from the persisted report sections. */
function trendRecord(report: BenchReport) {
  const { walk, pdfDrag, interaction, rapid, chapter, epubDrag } = scenarioSections(report);
  return {
    timestamp: report.timestamp,
    window: report.environment.window,
    devicePixelRatio: report.environment.devicePixelRatio,
    pdf: {
      firstRenderLatencyMs: walk?.firstRenderLatencyMs ?? null,
      renderP50: percentile(walk?.renderMs, 0.5),
      renderP95: percentile(walk?.renderMs, 0.95),
      pageTurnP50: percentile(interaction?.pageTurnLatencyMs, 0.5),
      pageTurnP95: percentile(interaction?.pageTurnLatencyMs, 0.95),
      zoomP50: percentile(interaction?.zoomLatencyMs, 0.5),
      zoomP95: percentile(interaction?.zoomLatencyMs, 0.95),
      wheelSettleP50: percentile(interaction?.wheelSettleMs, 0.5),
      bigJumpP50: percentile(interaction?.bigJumpLatencyMs, 0.5),
      dragP95: pdfDrag?.drag?.p95 ?? null,
      dragDroppedPct: pdfDrag?.drag?.pctOver16 ?? null,
      liveCanvasBytes: walk?.liveCanvases?.bytes ?? null,
      rapidRenderingSharePct: rapid?.renderStateSharePct.rendering ?? null,
      rapidWhiteStreakMs: rapid?.longestWhiteStreakMs ?? null,
      rapidStopToSharpMs: rapid?.stopToSharpMs ?? null,
    },
    epub: {
      firstRenderLatencyMs: chapter?.firstRenderLatencyMs ?? null,
      chapterChangeP50: percentile(chapter?.chapterChangeLatencyMs, 0.5),
      chapterChangeP95: percentile(chapter?.chapterChangeLatencyMs, 0.95),
      dragP95: epubDrag?.drag?.p95 ?? null,
      dragDroppedPct: epubDrag?.drag?.pctOver16 ?? null,
    },
  };
}

/**
 * Trend record: one JSON line per run appended to bench-trend.jsonl so
 * run-over-run drift (machine noise vs real regression) is visible without
 * any CI gate. Thresholds stay opt-in via BENCH_ENFORCE_P95_MS — CI timing
 * assertions are policy-excluded (docs/PERFORMANCE.md), and a threshold
 * that fires on machine variance is worse than none. Built from the
 * persisted report, so a worker restart mid-run cannot zero the line.
 */
function appendTrend(report: BenchReport): void {
  const record = trendRecord(report);
  const { pdfDrag, epubDrag } = scenarioSections(report);
  mkdirSync(artifactsDir, { recursive: true });
  const trendFile = path.join(artifactsDir, "bench-trend.jsonl");
  writeFileSync(trendFile, `${JSON.stringify(record)}\n`, { flag: "a" });
  console.log(`[bench] trend appended to ${trendFile}`);

  const enforcedP95 = Number(process.env.BENCH_ENFORCE_P95_MS ?? "");
  if (Number.isFinite(enforcedP95) && enforcedP95 > 0) {
    for (const [label, stats] of [
      ["pdf drag", pdfDrag?.drag],
      ["epub drag", epubDrag?.drag],
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

/** Console summaries of the persisted report (the file itself is written per scenario). */
function logReport(report: BenchReport): void {
  const { walk, pdfDrag, rapid, epubDrag } = scenarioSections(report);
  console.log(`[bench] report persisted to ${reportFile}`);
  if (pdfDrag) {
    console.log(`[bench] ${summarize("pdf drag frame ms", pdfDrag.drag)}`);
    console.log(`[bench] ${summarize("pdf idle frame ms", pdfDrag.idle)}`);
    console.log(
      `[bench] ${summarize("pdf render->blit during drag", frameStats(pdfDrag.drag?.renderMsDuringDrag))}`,
    );
  }
  if (epubDrag) {
    console.log(`[bench] ${summarize("epub drag frame ms", epubDrag.drag)}`);
    console.log(`[bench] ${summarize("epub idle frame ms", epubDrag.idle)}`);
    console.log(
      `[bench] epub drag: wall=${epubDrag.drag?.wallMs}ms distance=${epubDrag.drag?.distancePx}px jumps=${epubDrag.drag?.sectionJumps}`,
    );
    if (epubDrag.measure !== null) console.log(`[bench] epub measure cap: ${epubDrag.measure}`);
  }
  if (walk && walk.renderMs.length > 0) {
    console.log(`[bench] ${summarize("pdf page-walk render->blit ms", frameStats(walk.renderMs))}`);
  }
  if (rapid) {
    console.log(
      `[bench] pdf rapid scroll: wheelEvents=${rapid.wheelEvents} ` +
        `distance=${rapid.distancePx.toFixed(0)}px motion=${rapid.motionMs.toFixed(0)}ms ` +
        `samples=${rapid.samples} ` +
        `rendering=${rapid.renderStateSharePct.rendering}% ` +
        `unloaded=${rapid.renderStateSharePct.unloaded}% ` +
        `rendered=${rapid.renderStateSharePct.rendered}% ` +
        `whiteStreak=${rapid.longestWhiteStreakMs.toFixed(0)}ms ` +
        `stopToSharp=${rapid.stopToSharpMs === null ? "never" : `${rapid.stopToSharpMs.toFixed(0)}ms`}`,
    );
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
 * Install the rapid-scroll sampler (issue tuxbooks-x27.1): every 25 ms it
 * records the `data-render-state` of the slot under the viewport's top edge
 * — the page the reader is looking at — plus wheel arrivals and scroll
 * movement. Motion is the observed window from the first to the last
 * position change, so the distribution is measured over motion, not over
 * the settled time before the first wheel event.
 */
const startRapidScrollSampler = (page: Page): Promise<void> =>
  page.evaluate(
    ({ sampleMs, stopTimeoutMs, lifetimeMs }) => {
      const globals = globalThis as typeof globalThis & { __tuxbooksBenchRapid?: RapidHandle };
      // A previous failed scenario's sampler must not keep ticking.
      globals.__tuxbooksBenchRapid?.stop();
      const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
      if (!container) throw new Error("reader-content not found");

      interface Tick {
        t: number;
        state: string;
      }
      const ticks: Tick[] = [];
      let finished = false;
      let stopped = false;
      let stopRequestedAt = 0;
      let wheelEvents = 0;
      let lastTop = container.scrollTop;
      const startTop = lastTop;
      const installedAt = performance.now();
      let lastChangeAt = performance.now();
      let motionStartAt = -1;
      let motionEndAt = -1;
      let resolveDone!: (value: RapidSampled) => void;
      const done = new Promise<RapidSampled>((resolve) => {
        resolveDone = resolve;
      });
      const onWheel = () => {
        wheelEvents += 1;
      };
      window.addEventListener("wheel", onWheel, { passive: true });

      // Every slot intersecting the reader viewport, in document order:
      // the walk covers the slots above the viewport first, so the first
      // entry is the topmost visible one — the page under the viewport's
      // top edge, what the reader is looking at.
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

      // The interval handle is a parameter: finish() is declared before the
      // interval exists, and the interval's own callback passes its handle
      // in when it decides to stop.
      const finish = (interval: number, sharpAt: number, timedOut: boolean): void => {
        if (finished) return;
        finished = true;
        window.clearInterval(interval);
        window.removeEventListener("wheel", onWheel);
        const motionTicks = ticks.filter(
          (tick) => tick.t >= motionStartAt && tick.t <= motionEndAt,
        );
        const renderStates = { rendering: 0, unloaded: 0, rendered: 0, error: 0 };
        for (const tick of motionTicks) {
          if (tick.state in renderStates) {
            renderStates[tick.state as keyof typeof renderStates] += 1;
          }
        }
        const share = (count: number): number =>
          motionTicks.length === 0 ? 0 : Number(((count / motionTicks.length) * 100).toFixed(1));
        // Each sample stands for one interval of time, so a run of N white
        // samples spans N × sampleMs (the baseline's 336 samples = 8,400 ms).
        let longestWhiteStreakMs = 0;
        let whiteSince = -1;
        const lastT = motionTicks[motionTicks.length - 1]?.t ?? 0;
        for (const tick of [...motionTicks, { t: lastT, state: "closed" }]) {
          const white = tick.state === "rendering" || tick.state === "unloaded";
          if (white && whiteSince < 0) whiteSince = tick.t;
          if (!white && whiteSince >= 0) {
            longestWhiteStreakMs = Math.max(longestWhiteStreakMs, tick.t - whiteSince + sampleMs);
            whiteSince = -1;
          }
        }
        resolveDone({
          wheelEvents,
          distancePx: lastTop - startTop,
          motionMs: motionStartAt >= 0 ? motionEndAt - motionStartAt : 0,
          samples: motionTicks.length,
          renderStates,
          renderStateSharePct: {
            rendering: share(renderStates.rendering),
            unloaded: share(renderStates.unloaded),
            rendered: share(renderStates.rendered),
            error: share(renderStates.error),
          },
          longestWhiteStreakMs,
          stopToSharpMs: motionStartAt >= 0 && !timedOut ? sharpAt - motionEndAt : null,
        });
      };

      const timer = window.setInterval(() => {
        const now = performance.now();
        // Hard bound: a scenario that dies before finish() was awaited must
        // not keep sampling (layout reads at 40 Hz) through later scenarios
        // in the same app session.
        if (now - installedAt > lifetimeMs) {
          finish(timer, now, true);
          return;
        }
        const top = container.scrollTop;
        if (top !== lastTop) {
          if (motionStartAt < 0) motionStartAt = now;
          motionEndAt = now;
          lastChangeAt = now;
          lastTop = top;
        }
        ticks.push({ t: now, state: visibleStates()[0] ?? "" });
        if (!stopped || now - lastChangeAt < sampleMs) return;
        if (visibleStates().every((state) => state === "rendered")) {
          finish(timer, now, false);
        } else if (now - stopRequestedAt > stopTimeoutMs) {
          finish(timer, now, true);
        }
      }, sampleMs);

      globals.__tuxbooksBenchRapid = {
        stop() {
          stopped = true;
          stopRequestedAt = performance.now();
        },
        done,
      };
    },
    {
      sampleMs: RAPID_SAMPLE_MS,
      stopTimeoutMs: RAPID_STOP_TIMEOUT_MS,
      lifetimeMs: RAPID_MAX_LIFETIME_MS,
    },
  );

/**
 * End the motion phase and wait for stop-to-sharp: resolves once every
 * visible slot is `rendered`, or once the post-stop bound passes.
 */
const finishRapidScroll = (page: Page): Promise<RapidSampled> =>
  page.evaluate(() => {
    const globals = globalThis as typeof globalThis & { __tuxbooksBenchRapid?: RapidHandle };
    const handle = globals.__tuxbooksBenchRapid;
    if (!handle) throw new Error("rapid-scroll sampler was never started");
    handle.stop();
    return handle.done;
  });

test.describe("reader performance benchmark", () => {
  /**
   * Reference conditions are a maximized window (docs/PERFORMANCE.md); an
   * explicit `just bench-reader WxH` argument overrides for targeted
   * geometries. The applied size is what the report records. Sizing goes
   * through the renderer's window.resizeTo — the real OS window is what
   * the reader lays out against. Idempotent; called at each scenario start.
   */
  async function prepareBenchEnvironment(page: Page): Promise<BenchEnvironment> {
    const environment: BenchEnvironment = {
      userAgent: await page.evaluate(() => navigator.userAgent),
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
      window: { width: null, height: null },
      pdfRenderInfo: null,
    };
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
    const applied = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.outerHeight,
    }));
    environment.window = { width: applied.width, height: applied.height };
    console.log(
      `[bench] window ${applied.width}x${applied.height} dpr ${environment.devicePixelRatio}`,
    );
    return environment;
  }

  test("pdf: page-walk render→blit latency from mid-book with budget checks", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);
    test.skip(!existsSync(benchPdfFixture), "gitignored real-book fixture absent on this machine");

    const environment = await prepareBenchEnvironment(page);

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
    const firstRenderLatencyMs = Date.now() - firstRenderStart;
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of", {
      timeout: 30_000,
    });
    const pdfRenderInfo = await page.evaluate(
      () =>
        document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-render-info") ??
        null,
    );

    const total = Number((await textOf(page, "pdf-page-indicator")).match(/of (\d+)/)![1]);
    // Walk from the middle of the book: front matter and the ToC are the
    // least representative pages in the document.
    const startPage = Math.max(1, Math.floor(total / 2));
    await scrollToSlot(page, startPage);
    await waitForRendered(page, startPage, 60_000);

    const renderMs: number[] = [];
    const buffers: { page: number; bufferPx: number; maxSide: number }[] = [];
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
        renderMs.push(sample.ms);
        buffers.push({
          page: pageNumber,
          bufferPx: sample.bufferPx,
          maxSide: sample.maxSide,
        });
      }
    }

    const memory = await pdfSurfaceMemory(page);
    const onePage = await maxSingleBitmapBytes(page, 1);
    const liveCanvases = {
      count: memory.pageCanvases,
      bytes: memory.pageBytes,
      onePageBound: onePage,
    };

    // PERF-3 (deterministic attribute): one down-up oscillation must
    // retain ≥ 2 buffers in the bitmap cache.
    const down = Math.min(walkTo + 1, total);
    await scrollToSlot(page, down);
    await waitForRendered(page, down, 60_000);
    await scrollToSlot(page, walkTo);
    await waitForRendered(page, walkTo, 60_000);
    const cacheAfterOscillation = await bitmapCacheUsage(page);

    // Persist before the budget asserts: a failed scenario still leaves its
    // numbers on disk.
    recordScenario(
      reportFile,
      "pdf-page-walk",
      {
        startPage,
        firstRenderLatencyMs,
        renderMs,
        buffers,
        cacheAfterOscillation,
        liveCanvases,
      },
      { ...environment, pdfRenderInfo },
    );

    // PERF-1 (deterministic): every walked buffer stays under the caps.
    expect(buffers.length).toBeGreaterThan(0);
    for (const buffer of buffers) {
      expect(buffer.bufferPx).toBeLessThanOrEqual(2 ** 25);
      expect(buffer.maxSide).toBeLessThanOrEqual(8192);
    }

    // PERF-4 (derived from slot/canvas state): live canvases within the
    // count cap and the per-window byte bound.
    expect(memory.pageCanvases).toBeLessThanOrEqual(8);
    expect(memory.pageBytes).toBeLessThanOrEqual(8 * onePage);

    expect(cacheAfterOscillation).not.toBeNull();
    expect(cacheAfterOscillation!.entries).toBeGreaterThanOrEqual(2);

    await returnToLibrary(page);
  });

  test("pdf: scrollbar-drag frame timing through mid-book content", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);

    const environment = await prepareBenchEnvironment(page);

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
    recordScenario(
      reportFile,
      "pdf-scroll-drag",
      {
        idle: frameStats(idle),
        drag: {
          ...frameStats(drag.frames),
          wallMs: drag.wallMs,
          distancePx: drag.distancePx,
          renderMsDuringDrag: drag.renderMs,
        },
      },
      environment,
    );
    expect(drag.frames.length).toBeGreaterThan(DRAG_FRAMES / 2);
    expect(drag.distancePx).toBeGreaterThan(0);

    await returnToLibrary(page);
  });

  test("pdf: rapid scroll render-state distribution and stop-to-sharp", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);
    test.skip(!existsSync(benchPdfFixture), "gitignored real-book fixture absent on this machine");

    const environment = await prepareBenchEnvironment(page);

    await openInReader(page, benchBookTitles.pdf);
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toContainText("of", {
      timeout: 30_000,
    });
    const total = Number((await textOf(page, "pdf-page-indicator")).match(/of (\d+)/)![1]);
    const startPage = Math.max(1, Math.floor(total / 2));
    await scrollToSlot(page, startPage);
    await waitForRendered(page, startPage, 60_000);

    // Real wheel input over the content area — the gesture the white-slot
    // complaint is about, unlike the synthetic scrollTop drag above.
    const box = await page.locator('[data-testid="reader-content"]').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    await startRapidScrollSampler(page);
    const startedAt = Date.now();
    for (let event = 0; event < RAPID_WHEEL_EVENTS; event++) {
      await page.mouse.wheel(0, RAPID_WHEEL_PX_PER_EVENT);
      // Absolute pacing: the CDP round trip of each dispatch must not
      // stretch the pass, or the scroll speed — and with it the baseline —
      // drifts.
      const dueAt = startedAt + (event + 1) * RAPID_WHEEL_CADENCE_MS;
      const waitMs = dueAt - Date.now();
      if (waitMs > 0) await page.waitForTimeout(waitMs);
    }
    const sampled = await finishRapidScroll(page);

    // Persist before the liveness asserts: a failed scenario still leaves
    // its numbers on disk.
    recordScenario(
      reportFile,
      "pdf-rapid-scroll",
      {
        startPage,
        wheelEvents: sampled.wheelEvents,
        pxPerWheelEvent: RAPID_WHEEL_PX_PER_EVENT,
        distancePx: sampled.distancePx,
        motionMs: sampled.motionMs,
        samples: sampled.samples,
        renderStates: sampled.renderStates,
        renderStateSharePct: sampled.renderStateSharePct,
        longestWhiteStreakMs: sampled.longestWhiteStreakMs,
        stopToSharpMs: sampled.stopToSharpMs,
      },
      environment,
    );

    // Deterministic input and liveness checks only; the timing numbers are
    // reported and compared against the recorded baseline by hand.
    expect(sampled.wheelEvents).toBeGreaterThanOrEqual(RAPID_WHEEL_EVENTS);
    expect(sampled.distancePx).toBeGreaterThan(0);
    expect(sampled.samples).toBeGreaterThan(0);
    expect(sampled.stopToSharpMs).not.toBeNull();

    await returnToLibrary(page);
  });

  test("pdf: rapid page-turn and zoom interaction latency", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);
    test.skip(!existsSync(benchPdfFixture), "gitignored real-book fixture absent on this machine");

    const environment = await prepareBenchEnvironment(page);

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

    const pageTurnLatencyMs: number[] = [];
    const zoomLatencyMs: number[] = [];
    const wheelSettleMs: number[] = [];
    const bigJumpLatencyMs: number[] = [];

    // Rapid page turning: the toolbar's next/prev buttons, one sample each —
    // the interaction a reader repeats most. Turn down five pages, then up.
    for (let i = 0; i < 5; i++) {
      const before = await indicatorPage();
      const after = await interactionLatency(
        page,
        () => page.getByTestId("pdf-next").click(),
        async () => (await indicatorPage()) === before + 1,
      );
      pageTurnLatencyMs.push(after);
    }
    for (let i = 0; i < 3; i++) {
      const before = await indicatorPage();
      const after = await interactionLatency(
        page,
        () => page.getByTestId("pdf-prev").click(),
        async () => (await indicatorPage()) === before - 1,
      );
      pageTurnLatencyMs.push(after);
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
        zoomLatencyMs.push(after);
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
      (environment.window.width ?? 1280) / 2,
      (environment.window.height ?? 800) / 2,
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
      wheelSettleMs.push(Date.now() - start);
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
      bigJumpLatencyMs.push(after);
    }

    recordScenario(
      reportFile,
      "pdf-interaction",
      { pageTurnLatencyMs, zoomLatencyMs, wheelSettleMs, bigJumpLatencyMs },
      environment,
    );

    console.log(`[bench] ${summarize("pdf page-turn latency", frameStats(pageTurnLatencyMs))}`);
    console.log(`[bench] ${summarize("pdf zoom latency", frameStats(zoomLatencyMs))}`);
    console.log(`[bench] wheel settle ms: ${wheelSettleMs.map((ms) => ms.toFixed(0)).join(", ")}`);
    console.log(`[bench] ${summarize("pdf big-jump nav latency", frameStats(bigJumpLatencyMs))}`);

    await returnToLibrary(page);
  });

  test("epub: chapter-change interaction latency", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);

    const environment = await prepareBenchEnvironment(page);

    const openStart = Date.now();
    await openInReader(page, benchBookTitles.epub);
    const host = page.locator("div[data-epub-host]");
    await host.waitFor({ state: "attached", timeout: 30_000 });
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30_000 });
    const firstRenderLatencyMs = Date.now() - openStart;

    // Chapter changes through the contents drawer: open drawer → click TOC
    // entry → engine lands on the section. TOC entry indices are not spine
    // section indices in a real book, so the latency is measured to a
    // section CHANGE from the pre-click value; entries that resolve to the
    // section we are already in are skipped, not failed.
    const chapterChangeLatencyMs: number[] = [];
    const sectionNow = async () =>
      page.evaluate(
        () =>
          document
            .querySelector("[data-testid=epub-reader] [data-epub-host]")
            ?.getAttribute("data-epub-section") ?? null,
      );
    // Query per iteration by index, up to the first 8 entries, until 3
    // changes have been sampled.
    for (let index = 0; index < 8 && chapterChangeLatencyMs.length < 3; index++) {
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
          chapterChangeLatencyMs.push(ms);
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
    // Persist before the sample-count assert: a failed scenario still
    // leaves its partial numbers on disk.
    recordScenario(
      reportFile,
      "epub-chapter-change",
      { firstRenderLatencyMs, chapterChangeLatencyMs },
      environment,
    );
    expect(chapterChangeLatencyMs.length).toBeGreaterThanOrEqual(3);
    console.log(
      `[bench] ${summarize("epub chapter-change latency", frameStats(chapterChangeLatencyMs))}`,
    );

    await returnToLibrary(page);
  });

  test("epub: scrolled-flow scrollbar-drag frame timing from mid-book", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);

    const environment = await prepareBenchEnvironment(page);

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
    const measure = await page.evaluate(
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
    recordScenario(
      reportFile,
      "epub-scroll-drag",
      {
        flow: "scrolled",
        measure,
        idle: frameStats(idle),
        drag: {
          ...frameStats(drag.frames),
          wallMs: drag.wallMs,
          distancePx: drag.distancePx,
          sectionJumps: drag.sectionJumps,
        },
      },
      environment,
    );
    expect(drag.frames.length).toBeGreaterThan(DRAG_FRAMES / 2);

    await returnToLibrary(page);
  });

  test.afterAll(() => {
    // The file is the source of truth (written per scenario): summaries and
    // the trend line read it back, so a worker restart cannot zero them.
    const report = readBenchReport(reportFile);
    if (report === null) return;
    logReport(report);
    appendTrend(report);
  });
});
