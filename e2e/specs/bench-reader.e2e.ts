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
  returnToLibrary,
  scrollToSlot,
  textOf,
  waitForRendered,
  firstPdfCanvas,
} from "./helpers.js";
import { artifactsDir } from "../setup/environment.js";
import { benchBookTitles, benchPdfFixture } from "../setup/fixtures.js";

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
 * Deterministic budget assertions still hold here — they are policy, not
 * timing: PERF-1 buffer caps, PERF-3 cache occupancy after an oscillation,
 * and the PERF-4 derived live-canvas byte bound.
 */

const PDF_WALK_PAGES = 16;
const DRAG_FRAMES = 240;
const PDF_DRAG_PX_PER_FRAME = 48;
const EPUB_DRAG_PX_PER_FRAME = 40;

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

test.describe("reader performance benchmark", () => {
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
        const before = await textOf(page, "pdf-zoom-level");
        const after = await interactionLatency(
          page,
          () => button.click(),
          async () => (await textOf(page, "pdf-zoom-level")) !== before,
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
    writeReport();
    appendTrend();
  });
});
