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
import { scaledPixels } from "./pdfLayout";

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

/**
 * The slot geometry and effective ratio one presentation page renders at.
 *
 * Presentation mode fits the page being read (both axes), so every page has
 * its own fit scale. The displayed slot is rounded exactly as the layout
 * rounds it (`scaledPixels`), and the ratio is the same derivation a mounted
 * canvas makes from that geometry. Computing both here lets the presentation
 * preload rasterize a neighbour under exactly the cache key the canvas will
 * look up on arrival, so a step is a blit instead of a fresh raster.
 */
export function presentationPagePlan(
  size: { width: number; height: number },
  scale: number,
  dpr: number,
): { width: number; height: number; ratio: number } {
  const width = scaledPixels(size.width, scale);
  const height = scaledPixels(size.height, scale);
  const ratio = effectiveRenderRatio(
    scale > 0 ? width / scale : width,
    scale > 0 ? height / scale : height,
    scale,
    dpr,
  );
  return { width, height, ratio };
}

/**
 * True when the whole-page raster would fall below the display's device
 * resolution — a budget tier binds, so the page would be CSS-upscaled and its
 * text softened. The reader then renders only the visible region at device
 * resolution instead. Fit width (and anything else where the caps are inert)
 * returns false, so its whole-page path is untouched.
 */
export function needsRegionRender(
  width: number,
  height: number,
  scale: number,
  dpr: number,
  options: RenderRatioOptions = {},
): boolean {
  return effectiveRenderRatio(width, height, scale, dpr, options) < dpr - 1e-9;
}

/**
 * Device-pixels-per-CSS-pixel ratio for a viewport region raster: aims at the
 * display's devicePixelRatio and clamps to the same hard budgets as a page, so
 * a region buffer can never exceed them. A region is a viewport-sized piece,
 * so the caps are inert in practice; they are the safety net.
 */
export function regionRenderRatio(
  width: number,
  height: number,
  dpr: number,
  options: RenderRatioOptions = {},
): number {
  const { maxDimension = MAX_RENDER_DIMENSION, hardMaxPixels = MAX_RENDER_PIXELS_HARD } = options;
  if (!(width > 0) || !(height > 0) || !(dpr > 0)) return 1;
  const hard = Math.sqrt(hardMaxPixels / (width * height));
  const dimensionRatio = Math.min(maxDimension / width, maxDimension / height);
  return Math.max(0.01, Math.min(dpr, hard, dimensionRatio));
}

/**
 * Region ratio additionally capped by the whole-page budget.
 *
 * PDFium allocates internal buffers for page-sized objects (a shading's
 * pattern bitmap, for one) at the render's *device scale*, not the clip's.
 * A large clip at a moderate device scale therefore asks the WASM heap for
 * hundreds of megabytes even though the region buffer is small, and because
 * the emscripten heap never shrinks, the high-water accumulates until the
 * 2 GB ceiling is hit and every later render fails ("Cannot enlarge memory").
 * Capping the region's ratio by the whole-page ratio holds the page's device
 * scale inside the 2^25-pixel budget, which bounds that internal allocation.
 */
export function regionRenderRatioForPage(
  pageUnitWidth: number,
  pageUnitHeight: number,
  regionWidth: number,
  regionHeight: number,
  scale: number,
  dpr: number,
): number {
  return Math.min(
    regionRenderRatio(regionWidth, regionHeight, dpr),
    effectiveRenderRatio(pageUnitWidth, pageUnitHeight, scale, dpr),
  );
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
