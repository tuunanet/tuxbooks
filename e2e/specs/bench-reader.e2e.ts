import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  bitmapCacheUsage,
  closeReaderNavigation,
  maxSingleBitmapBytes,
  openInReader,
  openReaderNavigation,
  pdfSurfaceMemory,
  returnToLibrary,
  scrollToSlot,
  textOf,
  waitForRendered,
} from "./helpers.js";
import { artifactsDir } from "../setup/environment.js";
import { benchBookTitles, benchPdfFixture } from "../setup/fixtures.js";

/**
 * Reader performance benchmark (docs/performance.md "How to measure").
 *
 * This suite MEASURES and REPORTS; it does not assert timing thresholds —
 * those are manual by policy (E2E asserts deterministic attributes only,
 * and headless timings are unreliable). Run it explicitly and headed:
 * `just bench-reader` maximizes the window on the real display (reference
 * conditions; an explicit `WxH` argument overrides), and it seeds the
 * real-book Agents fixtures, whose image-laden pages make latency
 * measurement meaningful. Both walks start mid-book so the samples cover
 * real content rather than front matter and the ToC.
 *
 * The scroll scenario is a synthetic scrollbar drag: continuous scroll
 * deltas driven per animation frame — the same mutation a dragged scrollbar
 * performs — not discrete page turns, which bypass the continuous-scroll
 * path where the jank lives. While the drag runs, a rAF sampler records
 * frame intervals: main-thread stalls (raster, layout, React commits) show
 * up directly as long frames.
 *
 * Deterministic budget assertions still hold here — they are policy, not
 * timing: PERF-1 buffer caps, PERF-3 cache occupancy after an oscillation,
 * and the PERF-4 derived live-canvas byte bound.
 */

const PDF_WALK_PAGES = 16;
const DRAG_FRAMES = 240;
const PDF_DRAG_PX_PER_FRAME = 48;
const EPUB_DRAG_PX_PER_FRAME = 40;

/** wdio.conf's mocha timeout (120 s) is too tight for a measured walk. */
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

interface FrameStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** Share of frames slower than 16.7 ms (dropped vs 60 fps), 30 fps, 20 fps. */
  pctOver16: number;
  pctOver32: number;
  pctOver50: number;
}

interface BenchReport {
  timestamp: string;
  environment: {
    userAgent: string;
    devicePixelRatio: number;
    window: { width: number | null; height: number | null };
    pdfRenderInfo: string | null;
  };
  pdf: {
    startPage: number;
    firstRenderLatencyMs: number | null;
    renderMs: number[];
    pageTurnLatencyMs: number[];
    zoomLatencyMs: number[];
    bigJumpLatencyMs: number[];
    buffers: { page: number; bufferPx: number; maxSide: number }[];
    cacheAfterOscillation: { entries: number; bytes: number } | null;
    liveCanvases: { count: number; bytes: number; onePageBound: number } | null;
    idle: FrameStats | null;
    drag:
      (FrameStats & { wallMs: number; distancePx: number; renderMsDuringDrag: number[] }) | null;
  };
  epub: {
    flow: "scrolled";
    measure: string | null;
    firstRenderLatencyMs: number | null;
    chapterChangeLatencyMs: number[];
    idle: FrameStats | null;
    drag: (FrameStats & { wallMs: number; distancePx: number; sectionJumps: number }) | null;
  };
}

const report: BenchReport = {
  timestamp: new Date().toISOString(),
  environment: {
    userAgent: "",
    devicePixelRatio: 1,
    window: { width: null, height: null },
    pdfRenderInfo: null,
  },
  pdf: {
    startPage: 0,
    firstRenderLatencyMs: null,
    renderMs: [],
    pageTurnLatencyMs: [],
    zoomLatencyMs: [],
    bigJumpLatencyMs: [],
    buffers: [],
    cacheAfterOscillation: null,
    liveCanvases: null,
    idle: null,
    drag: null,
  },
  epub: {
    flow: "scrolled",
    measure: null,
    firstRenderLatencyMs: null,
    chapterChangeLatencyMs: [],
    idle: null,
    drag: null,
  },
};

/** p-value of a sample list (0.5 = median); -1 when empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return -1;
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
 * WebDriver round trip — consistent across runs, so it is comparable
 * run-over-run in the trend file, not a pure app figure.
 */
async function interactionLatency(
  action: () => Promise<void>,
  effect: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<number> {
  const start = Date.now();
  await action();
  await browser.waitUntil(effect, {
    timeout: timeoutMs,
    timeoutMsg: "interaction never took effect",
  });
  return Date.now() - start;
}

/**
 * Trend record: one JSON line per run appended to bench-trend.jsonl so
 * run-over-run drift (machine noise vs real regression) is visible without
 * any CI gate. Thresholds stay opt-in via BENCH_ENFORCE_P95_MS — CI timing
 * assertions are policy-excluded (docs/performance.md), and a threshold
 * that fires on machine variance is worse than none.
 */
function appendTrend(): void {
  const record = {
    timestamp: report.timestamp,
    window: report.environment.window,
    devicePixelRatio: report.environment.devicePixelRatio,
    pdf: {
      firstRenderLatencyMs: report.pdf.firstRenderLatencyMs,
      renderP50: percentile(report.pdf.renderMs, 0.5),
      renderP95: percentile(report.pdf.renderMs, 0.95),
      pageTurnP50: percentile(report.pdf.pageTurnLatencyMs, 0.5),
      pageTurnP95: percentile(report.pdf.pageTurnLatencyMs, 0.95),
      zoomP50: percentile(report.pdf.zoomLatencyMs, 0.5),
      zoomP95: percentile(report.pdf.zoomLatencyMs, 0.95),
      bigJumpP50: percentile(report.pdf.bigJumpLatencyMs, 0.5),
      dragP95: report.pdf.drag?.p95 ?? null,
      dragDroppedPct: report.pdf.drag?.pctOver16 ?? null,
      liveCanvasBytes: report.pdf.liveCanvases?.bytes ?? null,
    },
    epub: {
      firstRenderLatencyMs: report.epub.firstRenderLatencyMs,
      chapterChangeP50: percentile(report.epub.chapterChangeLatencyMs, 0.5),
      chapterChangeP95: percentile(report.epub.chapterChangeLatencyMs, 0.95),
      dragP95: report.epub.drag?.p95 ?? null,
      dragDroppedPct: report.epub.drag?.pctOver16 ?? null,
    },
  };
  mkdirSync(artifactsDir, { recursive: true });
  const trendFile = path.join(artifactsDir, "bench-trend.jsonl");
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

function writeReport(): void {
  mkdirSync(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, "bench-results.json");
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[bench] report written to ${file}`);
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
}

/**
 * Position change probe for the EPUB phase. The shell percent is
 * integer-grained, so the probe also reads the vendored paginator's current
 * in-section page: `foliate-view` keeps its renderer as a JS property, and
 * this probe runs in the same JS realm, so closed shadow roots don't hide
 * it. Read-only — the paginator itself is never reconfigured (PERF-7).
 */
const epubPositionProbe = (): Promise<string> =>
  browser.execute(() => {
    const percent = document.querySelector("[data-testid=reader-position]")?.textContent ?? "";
    try {
      const view = document.querySelector("[data-epub-host] foliate-view") as
        | (Element & {
            renderer?: {
              page?: number;
              start?: number;
              getAttribute?: (name: string) => string | null;
            };
          })
        | null;
      const renderer = view?.renderer;
      return `${percent}|${renderer?.page ?? "?"}|${renderer?.start ?? "?"}|${renderer?.getAttribute?.("flow") ?? "?"}`;
    } catch {
      return percent;
    }
  });

/**
 * Synthetic scrollbar drag: `pxPerFrame` continuous scroll deltas per ~16ms
 * tick — the same mutation a dragged scrollbar performs — while single-shot
 * rAF samples record frame cadence (main-thread stalls surface as long
 * deltas between consecutive frame timestamps). PDF drives the shell's
 * scroll container directly. EPUB scrolled flow re-anchors every tick via
 * the paginator's public `scrollToAnchor(fraction)`, which assigns the raw
 * scroll offset and lets foliate's expansion pipeline follow the drag —
 * `scrollBy` alone is clamped to the already-laid-out window (±1 viewport)
 * and would degenerate into discrete section turns. A drag stalled at a
 * section end turns to the next section, like a reader crossing into it.
 *
 * Serialized-callback constraint (see pdfSurfaceMemory in helpers.ts): no
 * named function bindings inside — the transpiler's `__name` retention
 * helpers do not exist in the page realm. One flat interval tick does
 * everything; each tick schedules exactly one anonymous rAF sample.
 */
const dragScroll = (
  format: "pdf" | "epub",
  maxFrames: number,
  pxPerFrame: number,
): Promise<DragResult> =>
  browser.execute(
    async (fmt, max, px) => {
      const container = document.querySelector("[data-testid=reader-content]");
      const view = document.querySelector("[data-epub-host] foliate-view") as
        | (Element & {
            renderer?: {
              scrollToAnchor?: (anchor: number) => Promise<void>;
              next?: () => void;
              start?: number;
              viewSize?: number;
            };
          })
        | null;
      const renderer = fmt === "epub" ? (view?.renderer ?? null) : null;
      const startedAt = performance.now();
      const stamps: number[] = [];
      const renderMs: number[] = [];
      let distancePx = 0;
      let last = startedAt;
      let count = 0;
      let stalls = 0;
      let lastPos = renderer?.start ?? 0;
      let jumps = 0;
      const distance = await new Promise<number>((resolve) => {
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
            const pos = renderer?.start ?? 0;
            if (Math.abs(pos - lastPos) < 1) {
              stalls += 1;
              if (stalls >= 12 && renderer?.next) {
                renderer.next();
                jumps += 1;
                stalls = 0;
              }
            } else {
              stalls = 0;
              distancePx += Math.abs(pos - lastPos);
              lastPos = pos;
            }
            const viewSize = renderer?.viewSize ?? 0;
            if (viewSize > 0) {
              // Fraction of the section: raw offset assignment, unclamped —
              // foliate expands the rendered window to follow the drag.
              renderer?.scrollToAnchor?.((pos + px) / viewSize);
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
    format,
    maxFrames,
    pxPerFrame,
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
const sampleIdleFrames = (maxFrames: number): Promise<number[]> =>
  browser.execute(async (max) => {
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

describe("reader performance benchmark", () => {
  before(async () => {
    report.environment.userAgent = await browser.execute(() => navigator.userAgent);
    report.environment.devicePixelRatio = await browser.execute(() => window.devicePixelRatio);
    // Reference conditions are a maximized window (docs/performance.md); an
    // explicit `just bench-reader WxH` argument overrides for targeted
    // geometries. The applied size is what the report records. Sizing goes
    // through the renderer's window.resizeTo — chromedriver ≥ 152 removed
    // the CDP endpoint both the maximize shortcut and the W3C window-rect
    // command used, while Electron's renderer resize keeps working.
    const requested = process.env.BENCH_WINDOW_SIZE ?? "";
    const match = /^(\d+)x(\d+)$/.exec(requested);
    if (match) {
      await browser.execute((w, h) => window.resizeTo(w, h), Number(match[1]), Number(match[2]));
    } else {
      await browser.execute(() =>
        window.resizeTo(window.screen.availWidth, window.screen.availHeight),
      );
    }
    await browser.waitUntil(
      async () => {
        // getWindowSize also routes through the removed CDP endpoint — read
        // the applied size from the renderer.
        const size = await browser.execute(() => ({
          width: window.innerWidth,
          height: window.outerHeight,
        }));
        const target = match
          ? { width: Number(match[1]), height: Number(match[2]) }
          : await browser.execute(() => ({
              width: window.screen.availWidth,
              height: window.screen.availHeight,
            }));
        return (
          Math.abs(size.width - target.width) <= 8 && Math.abs(size.height - target.height) <= 8
        );
      },
      { timeout: 10_000, timeoutMsg: "bench window never reached its requested size" },
    );
    // The applied size from the renderer (same reason as above).
    const applied = await browser.execute(() => ({
      width: window.innerWidth,
      height: window.outerHeight,
    }));
    report.environment.window = { width: applied.width, height: applied.height };
    console.log(
      `[bench] window ${applied.width}x${applied.height} dpr ${report.environment.devicePixelRatio}`,
    );
  });

  it("pdf: page-walk render→blit latency from mid-book with budget checks", async function () {
    if (!existsSync(benchPdfFixture)) {
      this.skip(); // gitignored real-book fixture absent on this machine
    }
    this.timeout(BENCH_TEST_TIMEOUT_MS);

    // First-render latency: launch-to-first-page on the real-book fixture
    // (open + engine init + first page bitmap) — the cold-open cost a
    // reader feels when opening a book.
    const firstRenderStart = Date.now();
    await openInReader(benchBookTitles.pdf);
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30_000 });
    try {
      await waitForRendered(1, 90_000);
    } catch (err) {
      // Diagnose from artifacts: which page is the reader actually on, and
      // what state are the first slots in?
      const probe = await browser.execute(() => ({
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
    await browser.waitUntil(
      async () => /Page \d+ of \d+/.test(await textOf("pdf-page-indicator")),
      { timeout: 30_000, timeoutMsg: "bench pdf never reported its page count" },
    );
    report.environment.pdfRenderInfo = await browser.execute(
      () =>
        document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-render-info") ??
        null,
    );

    const total = Number((await textOf("pdf-page-indicator")).match(/of (\d+)/)![1]);
    // Walk from the middle of the book: front matter and the ToC are the
    // least representative pages in the document.
    const startPage = Math.max(1, Math.floor(total / 2));
    report.pdf.startPage = startPage;
    await scrollToSlot(startPage);
    await waitForRendered(startPage, 60_000);

    const walkTo = Math.min(startPage + PDF_WALK_PAGES, total);
    for (let page = startPage; page <= walkTo; page++) {
      await scrollToSlot(page);
      await waitForRendered(page, 60_000);
      const sample = await browser.execute((target) => {
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
      }, page);
      if (sample && sample.ms >= 0) {
        report.pdf.renderMs.push(sample.ms);
        report.pdf.buffers.push({ page, bufferPx: sample.bufferPx, maxSide: sample.maxSide });
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
    const memory = await pdfSurfaceMemory();
    const onePage = await maxSingleBitmapBytes(1);
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
    await scrollToSlot(down);
    await waitForRendered(down, 60_000);
    await scrollToSlot(walkTo);
    await waitForRendered(walkTo, 60_000);
    const cache = await bitmapCacheUsage();
    report.pdf.cacheAfterOscillation = cache;
    expect(cache).not.toBeNull();
    expect(cache!.entries).toBeGreaterThanOrEqual(2);

    await returnToLibrary();
  });

  it("pdf: scrollbar-drag frame timing through mid-book content", async function () {
    this.timeout(BENCH_TEST_TIMEOUT_MS);

    await openInReader(benchBookTitles.pdf);
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30_000 });
    await browser.waitUntil(
      async () => /Page \d+ of \d+/.test(await textOf("pdf-page-indicator")),
      { timeout: 30_000, timeoutMsg: "bench pdf never reported its page count" },
    );
    const total = Number((await textOf("pdf-page-indicator")).match(/of (\d+)/)![1]);
    await scrollToSlot(Math.max(1, Math.floor(total / 2)));
    await waitForRendered(Math.max(1, Math.floor(total / 2)), 60_000);

    const drag = await dragScroll("pdf", DRAG_FRAMES, PDF_DRAG_PX_PER_FRAME);
    const idle = await sampleIdleFrames(60);
    report.pdf.idle = frameStats(idle);
    report.pdf.drag = {
      ...frameStats(drag.frames),
      wallMs: drag.wallMs,
      distancePx: drag.distancePx,
      renderMsDuringDrag: drag.renderMs,
    };
    expect(drag.frames.length).toBeGreaterThan(DRAG_FRAMES / 2);
    expect(drag.distancePx).toBeGreaterThan(0);

    await returnToLibrary();
  });

  it("pdf: rapid page-turn and zoom interaction latency", async function () {
    if (!existsSync(benchPdfFixture)) {
      this.skip(); // gitignored real-book fixture absent on this machine
    }
    this.timeout(BENCH_TEST_TIMEOUT_MS);

    await openInReader(benchBookTitles.pdf);
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30_000 });
    await browser.waitUntil(
      async () => /Page \d+ of \d+/.test(await textOf("pdf-page-indicator")),
      { timeout: 30_000, timeoutMsg: "bench pdf never reported its page count" },
    );
    const total = Number((await textOf("pdf-page-indicator")).match(/of (\d+)/)![1]);
    const startPage = Math.max(1, Math.floor(total / 2));
    await scrollToSlot(startPage);
    await waitForRendered(startPage, 60_000);

    const indicatorPage = async () =>
      Number((await textOf("pdf-page-indicator")).match(/Page (\d+)/)?.[1]);

    // Rapid page turning: the toolbar's next/prev buttons, one sample each —
    // the interaction a reader repeats most. Turn down five pages, then up.
    for (let i = 0; i < 5; i++) {
      const before = await indicatorPage();
      const after = await interactionLatency(
        () => $("[data-testid=pdf-next]").click(),
        async () => (await indicatorPage()) === before + 1,
      );
      report.pdf.pageTurnLatencyMs.push(after);
    }
    for (let i = 0; i < 3; i++) {
      const before = await indicatorPage();
      const after = await interactionLatency(
        () => $("[data-testid=pdf-prev]").click(),
        async () => (await indicatorPage()) === before - 1,
      );
      report.pdf.pageTurnLatencyMs.push(after);
    }

    // Zoom in/out: each step relayouts and re-renders the window; the
    // observable effect is the zoom label (geometry streams in after). The
    // buttons disable at the ends of the zoom ladder — stop there.
    const zoomSteps = async (direction: "in" | "out"): Promise<void> => {
      for (let i = 0; i < 2; i++) {
        const button = await $(`[data-testid=pdf-zoom-${direction}]`);
        if ((await button.getAttribute("disabled")) !== null) break;
        const before = await textOf("pdf-zoom-level");
        const after = await interactionLatency(
          () => button.click(),
          async () => (await textOf("pdf-zoom-level")) !== before,
        );
        report.pdf.zoomLatencyMs.push(after);
      }
    };
    await zoomSteps("in");
    await zoomSteps("out");

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
        () => scrollToSlot(target),
        async () => (await indicatorPage()) === target,
      );
      report.pdf.bigJumpLatencyMs.push(after);
    }

    console.log(
      `[bench] ${summarize("pdf page-turn latency", frameStats(report.pdf.pageTurnLatencyMs))}`,
    );
    console.log(`[bench] ${summarize("pdf zoom latency", frameStats(report.pdf.zoomLatencyMs))}`);
    console.log(
      `[bench] ${summarize("pdf big-jump nav latency", frameStats(report.pdf.bigJumpLatencyMs))}`,
    );

    await returnToLibrary();
  });

  it("epub: chapter-change interaction latency", async function () {
    this.timeout(BENCH_TEST_TIMEOUT_MS);

    const openStart = Date.now();
    await openInReader(benchBookTitles.epub);
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30_000, timeoutMsg: "bench epub engine never became ready" },
    );
    report.epub.firstRenderLatencyMs = Date.now() - openStart;

    // Chapter changes through the contents drawer: open drawer → click TOC
    // entry → engine lands on the section. TOC entry indices are not spine
    // section indices in a real book, so the latency is measured to a
    // section CHANGE from the pre-click value; entries that resolve to the
    // section we are already in are skipped, not failed.
    const sectionNow = async () =>
      browser.execute(
        () =>
          document
            .querySelector("[data-testid=epub-reader] [data-epub-host]")
            ?.getAttribute("data-epub-section") ?? null,
      );
    // Element handles go stale across drawer close/reopen cycles — query
    // per iteration by index, up to the first 8 entries, until 3 changes
    // have been sampled.
    for (let index = 0; index < 8 && report.epub.chapterChangeLatencyMs.length < 3; index++) {
      await openReaderNavigation();
      const item = await $(`[data-testid=toc-item-${index}]`);
      if (!(await item.isExisting())) break;
      const before = await sectionNow();
      const changed = await interactionLatency(
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
        await $("[data-testid=reader-nav]")
          .waitForExist({ reverse: true, timeout: 10_000 })
          .catch(() => {});
      } else {
        await closeReaderNavigation();
      }
    }
    expect(report.epub.chapterChangeLatencyMs.length).toBeGreaterThanOrEqual(3);
    console.log(
      `[bench] ${summarize("epub chapter-change latency", frameStats(report.epub.chapterChangeLatencyMs))}`,
    );

    await returnToLibrary();
  });

  it("epub: scrolled-flow scrollbar-drag frame timing from mid-book", async function () {
    this.timeout(BENCH_TEST_TIMEOUT_MS);

    await openInReader(benchBookTitles.epub);
    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
      { timeout: 30_000, timeoutMsg: "bench epub engine never became ready" },
    );

    // Continuous layout: fresh sessions default to paginated (the
    // preference is not persisted), and this suite measures scrolling.
    await $("[data-testid=appearance-trigger]").click();
    await $("[data-testid=appearance-content]").waitForDisplayed({ timeout: 10_000 });
    const layoutItems = await $$("[data-testid=pref-layout] button");
    expect(layoutItems).toHaveLength(2);
    const label = await browser.execute(
      (element) => (element as HTMLElement).textContent,
      layoutItems[1] as unknown as HTMLElement,
    );
    expect(label).toBe("Scrolling");
    await layoutItems[1].click();
    await browser.keys(["Escape"]);
    // The flow lands on the renderer as an attribute (same-realm probe —
    // the shadow root is closed).
    await browser.waitUntil(async () => (await epubPositionProbe()).endsWith("|scrolled"), {
      timeout: 10_000,
      timeoutMsg: "epub never switched to scrolled flow",
    });

    // PERF-12: the scrolled reading surface must be measure-capped.
    // Deterministic DOM attribute — timing assertions stay out of E2E.
    await browser.waitUntil(async () => await $("div[data-epub-measure=capped]").isExisting(), {
      timeout: 10_000,
      timeoutMsg: "scrolled reading surface was not measure-capped (PERF-12)",
    });
    report.epub.measure = await browser.execute(
      () => document.querySelector<HTMLElement>("[data-epub-measure]")?.style.maxWidth ?? "",
    );

    // Jump to the middle of the book through the engine's own fraction
    // navigation: front matter and the ToC are the least representative
    // content, and in scrolled flow the engine (not the shell container)
    // owns scrolling. The pre-jump probe is captured first: goToFraction
    // scrolls synchronously through the engine, so "changed" is measured
    // against where the restored session had put us.
    const beforeJump = await epubPositionProbe();
    await browser.execute(async () => {
      const view = document.querySelector("[data-epub-host] foliate-view") as
        (Element & { goToFraction?: (frac: number) => Promise<void> }) | null;
      await view?.goToFraction?.(0.5);
    });
    await browser.waitUntil(async () => (await epubPositionProbe()) !== beforeJump, {
      timeout: 10_000,
      timeoutMsg: "epub never landed on the mid-book position",
    });

    const drag = await dragScroll("epub", DRAG_FRAMES, EPUB_DRAG_PX_PER_FRAME);
    const idle = await sampleIdleFrames(60);
    report.epub.idle = frameStats(idle);
    report.epub.drag = {
      ...frameStats(drag.frames),
      wallMs: drag.wallMs,
      distancePx: drag.distancePx,
      sectionJumps: drag.sectionJumps,
    };
    expect(drag.frames.length).toBeGreaterThan(DRAG_FRAMES / 2);

    await returnToLibrary();
  });

  after(() => {
    writeReport();
    appendTrend();
  });
});
