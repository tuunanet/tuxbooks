import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";
import {
  frameStats,
  prepareBenchEnvironment,
  sampleIdleFrames,
  summarize,
} from "../setup/bench-helpers.js";
import { recordScenario } from "../setup/bench-report.js";
import { artifactsDir } from "../setup/environment.js";
import { LIBRARY_BENCH_BOOK_COUNT, libraryBenchCorpusDir } from "../setup/fixtures.js";

/**
 * Headed, opt-in measurement for the 10,000-book All Books Grid report
 * (tuxbooks-ht9). Run `just bench-library`; E2E setup generates the
 * gitignored corpus with scripts/make-epub-corpus.py and the spec imports it
 * through the real bulk path.
 *
 * The scroll scenario writes continuous scroll-position deltas from one end
 * of the library to the other while a rAF sampler records frame cadence. It
 * measures the scroll-driven rendering and virtualization work, not trusted
 * input dispatch. This suite records timings without imposing a
 * machine-independent budget. BENCH_ENFORCE_P95_MS adds a local pass/fail
 * threshold during development.
 */
const BENCH_TEST_TIMEOUT_MS = 900_000;
const SCROLL_TICKS = 600;
const IDLE_FRAMES = 60;

const reportFile = path.join(artifactsDir, "bench-results.json");

interface GridScrollSample {
  frames: number[];
  wallMs: number;
  distancePx: number;
  /** Highest mounted-card count observed at a scroll tick. */
  maxObservedMountedCards: number;
  finalScrollTop: number;
  finalAvailableScrollPx: number;
}

/** Drive a full-library programmatic scroll and sample browser frame cadence. */
async function measureGridScroll(page: Page, maxTicks: number): Promise<GridScrollSample> {
  return page.evaluate(async (max) => {
    const grid = document.querySelector<HTMLElement>('[data-testid="book-grid"]');
    if (!grid) throw new Error("All Books Grid scroll container not found");

    grid.scrollTop = 0;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const initialAvailable = grid.scrollHeight - grid.clientHeight;
    if (initialAvailable <= 0) throw new Error("All Books Grid is not scrollable");
    const stepPx = initialAvailable / max;
    const startedAt = performance.now();
    const stamps: number[] = [];
    let last = startedAt;
    let count = 0;
    let distancePx = 0;
    let maxObservedMountedCards = 0;

    await new Promise<void>((resolve) => {
      // Register faster than the frame clock to avoid aliasing 16 ms ticks
      // against a 16.7 ms display cadence.
      const sampler = window.setInterval(() => {
        requestAnimationFrame((now) => {
          if (now > last) {
            stamps.push(now - last);
            last = now;
          }
        });
      }, 8);
      const timer = window.setInterval(() => {
        const before = grid.scrollTop;
        const available = grid.scrollHeight - grid.clientHeight;
        grid.scrollTop = Math.min(available, before + stepPx);
        distancePx += Math.abs(grid.scrollTop - before);
        maxObservedMountedCards = Math.max(
          maxObservedMountedCards,
          document.querySelectorAll('[data-testid="book-card"]').length,
        );
        count += 1;
        if (count >= max) {
          window.clearInterval(timer);
          window.clearInterval(sampler);
          resolve();
        }
      }, 16);
    });

    return {
      frames: stamps,
      wallMs: performance.now() - startedAt,
      distancePx,
      maxObservedMountedCards,
      finalScrollTop: grid.scrollTop,
      // The virtualizer's realized height can differ from its initial
      // estimate, so the end state is checked against the final geometry.
      finalAvailableScrollPx: grid.scrollHeight - grid.clientHeight,
    };
  }, maxTicks);
}

test.describe("10,000-book All Books performance", () => {
  test("measures a full Grid-view scroll", async ({ page }) => {
    test.setTimeout(BENCH_TEST_TIMEOUT_MS);

    const environment = await prepareBenchEnvironment(page);
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "All Books", exact: true })).toBeVisible();

    const report = (await page.evaluate(
      (dir) => window.tuxbooks!.invoke("import_paths", { paths: [dir] }),
      libraryBenchCorpusDir,
    )) as Record<string, number>;
    expect(report).toMatchObject({ imported: LIBRARY_BENCH_BOOK_COUNT, skipped: 0 });

    // An empty library renders the empty state rather than LibraryView, so
    // select All Books only once the imported books have landed.
    await page.getByRole("button", { name: "All Books", exact: true }).click();
    await expect(page.getByTestId("library-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("library-stats")).toHaveText(
      `${LIBRARY_BENCH_BOOK_COUNT} books`,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("book-grid")).toBeVisible();

    const idle = frameStats(await sampleIdleFrames(page, IDLE_FRAMES));
    const sample = await measureGridScroll(page, SCROLL_TICKS);
    const scroll = { ...frameStats(sample.frames), ...sample };
    recordScenario(
      reportFile,
      "library-grid-scroll",
      {
        bookCount: LIBRARY_BENCH_BOOK_COUNT,
        idle,
        scroll: {
          n: scroll.n,
          p50: scroll.p50,
          p95: scroll.p95,
          max: scroll.max,
          pctOver16: scroll.pctOver16,
          pctOver32: scroll.pctOver32,
          pctOver50: scroll.pctOver50,
          wallMs: sample.wallMs,
          distancePx: sample.distancePx,
          maxObservedMountedCards: sample.maxObservedMountedCards,
        },
      },
      environment,
    );
    console.log(`[bench] ${summarize("library idle frame ms", idle)}`);
    console.log(`[bench] ${summarize("library Grid scroll frame ms", scroll)}`);
    console.log(
      `[bench] library Grid distance=${Math.round(sample.distancePx)}px ` +
        `wall=${Math.round(sample.wallMs)}ms maxObservedMountedCards=${sample.maxObservedMountedCards}`,
    );

    expect(sample.maxObservedMountedCards).toBeGreaterThan(0);
    expect(sample.frames.length).toBeGreaterThan(SCROLL_TICKS / 2);
    expect(sample.distancePx).toBeGreaterThan(0);
    expect(sample.finalScrollTop).toBeGreaterThan(sample.finalAvailableScrollPx * 0.95);

    const enforcedP95 = Number(process.env.BENCH_ENFORCE_P95_MS ?? "");
    if (Number.isFinite(enforcedP95) && enforcedP95 > 0) {
      expect(
        scroll.p95,
        `Grid scroll p95 ${scroll.p95}ms exceeds BENCH_ENFORCE_P95_MS=${enforcedP95}ms`,
      ).toBeLessThanOrEqual(enforcedP95);
    }
  });
});
