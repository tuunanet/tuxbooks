/**
 * Pure PDF render-policy math — no React, no DOM, no engine. The reader
 * rasterizes each page into an offscreen buffer at `displayed CSS size ×
 * effective ratio`; this module decides that ratio, and the render window's
 * byte budget.
 *
 * Buffer policy (PERF-1, docs/PERFORMANCE.md): a page's backing store never
 * exceeds `MAX_RENDER_PIXELS_HARD` (2²⁵) in total or `MAX_RENDER_DIMENSION`
 * on a side; the ratio prefers devicePixelRatio, degrades to the preferred
 * `MAX_RENDER_PIXELS` (2²⁴) tier first, then to CSS resolution, and only
 * digs into the hard budget under zoom. Beyond the ratio the canvas CSS
 * size stays at the displayed size and CSS upscales — the same policy as
 * the PDF.js viewer's `maxCanvasPixels` (the cap the budgets were pinned
 * against). At common window sizes
 * the ratio equals dpr and the caps are inert.
 *
 * Live-canvas policy (PERF-4, docs/PERFORMANCE.md): the pages allowed to
 * keep a mounted canvas are bounded by bytes as well as count, using the
 * same capped ratio for the per-page estimate.
 */

/**
 * Preferred pixel budget for one page's backing store (16.7 MP). The ratio
 * degrades from devicePixelRatio to this tier before anything else — at the
 * 4K reference dpr 2 this halves the per-page buffer (and with it the
 * per-frame raster/compositing work) versus the hard cap.
 */
export const MAX_RENDER_PIXELS = 2 ** 24;

/**
 * Hard pixel budget for one page's backing store (33.5 MP, PERF-1 and the
 * official PDF.js viewer's `maxCanvasPixels`). Only reached once the ratio
 * would otherwise drop below CSS resolution — i.e. under zoom past the CSS
 * floor — never at fit width.
 */
export const MAX_RENDER_PIXELS_HARD = 2 ** 25;

/** Hard per-side budget for one page's backing store, in device pixels. */
export const MAX_RENDER_DIMENSION = 8192;

/** Byte budget for simultaneously mounted page canvases (PERF-4). */
export const MAX_ACTIVE_CANVAS_BYTES = 256 * 1024 * 1024;

export interface RenderRatioOptions {
  maxPixels?: number;
  maxDimension?: number;
  hardMaxPixels?: number;
}

/**
 * The ratio (device pixels per CSS pixel) to rasterize a page at, via a
 * two-tier degradation ladder:
 *
 * 1. full devicePixelRatio (the caps are inert at common sizes),
 * 2. the soft pixel budget (`maxPixels`, 2²⁴) — the preferred
 *    quality/speed tradeoff,
 * 3. CSS resolution (ratio 1) — never blurrier than the layout itself while
 *    the hard budget allows,
 * 4. the hard budget (`hardMaxPixels`, 2²⁵ — PERF-1) under zoom.
 *
 * Invariants: ratio ≤ dpr; buffer px ≤ hardMaxPixels; sides ≤
 * maxDimension. Ratio < dpr exactly when a tier binds. Unmeasurable
 * geometry falls back to 1 (same contract as `fitWidthScale`: callers
 * never scale to zero).
 */
export function effectiveRenderRatio(
  width: number,
  height: number,
  scale: number,
  dpr: number,
  options: RenderRatioOptions = {},
): number {
  const {
    maxPixels = MAX_RENDER_PIXELS,
    maxDimension = MAX_RENDER_DIMENSION,
    hardMaxPixels = MAX_RENDER_PIXELS_HARD,
  } = options;
  if (!(width > 0) || !(height > 0) || !(scale > 0) || !(dpr > 0)) return 1;
  const area = width * height * scale * scale;
  const areaSoft = Math.sqrt(maxPixels / area);
  const areaHard = Math.sqrt(hardMaxPixels / area);
  const dimensionRatio = Math.min(maxDimension / (width * scale), maxDimension / (height * scale));
  const candidate = Math.min(dpr, areaSoft, dimensionRatio);
  const floor = Math.min(1, areaHard, dimensionRatio);
  return Math.min(dpr, Math.max(candidate, floor));
}

/** RGBA bytes a render buffer occupies at the given CSS size and ratio. */
export function renderBufferBytes(width: number, height: number, ratio: number): number {
  return width * height * ratio * ratio * 4;
}

/**
 * Longest prefix of `items` whose cumulative `byteOf` values fit `maxBytes`.
 * The first item (the anchor / closest page) is always kept even when it
 * alone exceeds the budget, mirroring the bitmap cache's keep-the-last rule
 * — the page under the reading position must never starve.
 */
export function capByBytes<T>(items: T[], byteOf: (item: T) => number, maxBytes: number): T[] {
  const kept: T[] = [];
  let total = 0;
  for (const [index, item] of items.entries()) {
    const bytes = byteOf(item);
    if (index > 0 && total + bytes > maxBytes) break;
    kept.push(item);
    total += bytes;
  }
  return kept;
}
