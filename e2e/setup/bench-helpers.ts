import { expect } from "@playwright/test";
import type { Page } from "playwright";

import type { BenchEnvironment, FrameStats } from "./bench-report.js";

/** p-value of a sample list (0.5 = median); -1 when empty. */
export function percentile(values: number[] | undefined, p: number): number {
  if (!values || values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

export function frameStats(frames: number[] | undefined): FrameStats {
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

export function summarize(label: string, stats?: FrameStats | null): string {
  const s = stats ?? {
    n: 0,
    p50: -1,
    p95: -1,
    max: -1,
    pctOver16: 0,
    pctOver32: 0,
    pctOver50: 0,
  };
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
 * Idle frame cadence is the environment baseline. Scroll deltas are only
 * meaningful relative to it: a slow idle cadence implicates the rendering
 * stack rather than the code being benchmarked.
 *
 * Registration must be faster than the frame clock (8 ms). A 16 ms interval
 * beats against 16.7 ms frames and biases deltas toward double intervals.
 * Playwright serializes only the evaluate callback into the page, so the
 * same registration logic has to live inside each browser-side sampler.
 */
export const sampleIdleFrames = (page: Page, maxFrames: number): Promise<number[]> =>
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
 * Size the real desktop window and record the conditions of this bench run.
 * Reference conditions are a maximized window (docs/PERFORMANCE.md); an
 * explicit `just bench-* WxH` argument overrides for targeted geometries.
 * The applied size is what the report records. Sizing goes through the
 * renderer's window.resizeTo because the real OS window is what the app lays
 * out against.
 */
export async function prepareBenchEnvironment(page: Page): Promise<BenchEnvironment> {
  const environment: BenchEnvironment = {
    userAgent: await page.evaluate(() => navigator.userAgent),
    devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
    window: { width: null, height: null },
    pdfRenderInfo: null,
  };
  const requested = process.env.BENCH_WINDOW_SIZE ?? "";
  const match = /^(\d+)x(\d+)$/.exec(requested);
  if (match) {
    await page.evaluate(([w, h]) => window.resizeTo(w!, h!), [Number(match[1]), Number(match[2])]);
  } else {
    await page.evaluate(() => window.resizeTo(window.screen.availWidth, window.screen.availHeight));
  }
  await expect
    .poll(async () => {
      const target = match
        ? { width: Number(match[1]), height: Number(match[2]) }
        : await page.evaluate(() => ({
            width: window.screen.availWidth,
            height: window.screen.availHeight,
          }));
      // The renderer-applied size can lag the request or drift back to its
      // default geometry, so keep driving it until the window settles.
      await page.evaluate(([w, h]) => window.resizeTo(w!, h!), [target.width, target.height]);
      await page.waitForTimeout(200);
      const size = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.outerHeight,
      }));
      // Outer height includes the WM title bar. Some desktops report an
      // available height that the granted outer size misses by that decoration.
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
