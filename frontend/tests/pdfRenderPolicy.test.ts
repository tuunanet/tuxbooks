import { describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_CANVAS_BYTES,
  MAX_RENDER_DIMENSION,
  MAX_RENDER_PIXELS,
  MAX_RENDER_PIXELS_HARD,
  capByBytes,
  effectiveRenderRatio,
  renderBufferBytes,
} from "@/components/reader/pdf/pdfRenderPolicy";

/**
 * Letter page in PDF page units (the docs/PERFORMANCE.md reference page);
 * `effectiveRenderRatio` takes page units + render scale.
 */
const LETTER = { width: 612, height: 792 } as const;

/** Fit-width reference conditions: page units plus the layout scale. */
function fitWidth(contentWidth: number): { scale: number; cssWidth: number; cssHeight: number } {
  const scale = contentWidth / LETTER.width;
  return { scale, cssWidth: LETTER.width * scale, cssHeight: LETTER.height * scale };
}

/** Fit width multiplied by a zoom level (the reader's `fitScale × zoom`). */
function fitWidthZoom(
  contentWidth: number,
  zoom: number,
): { scale: number; cssWidth: number; cssHeight: number } {
  const base = fitWidth(contentWidth);
  return {
    scale: base.scale * zoom,
    cssWidth: base.cssWidth * zoom,
    cssHeight: base.cssHeight * zoom,
  };
}

/** 4K window maximized: ~3816 px of content area after window chrome. */
const CONTENT_4K = fitWidth(3816);
/** 1080p window maximized: ~1904 px of content area. */
const CONTENT_1080P = fitWidth(1904);

describe("effectiveRenderRatio (PERF-1)", () => {
  it("is inert at 4K dpr 1: the CSS floor keeps the page at layout sharpness", () => {
    const { scale, cssWidth, cssHeight } = CONTENT_4K;
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 1);
    // The CSS page (18.85 MP) exceeds the soft budget, but dpr 1 means the
    // CSS-resolution floor and the soft tier agree: ratio 1, within the
    // hard budget.
    expect(ratio).toBe(1);
    expect(cssWidth * cssHeight * ratio * ratio).toBeLessThanOrEqual(MAX_RENDER_PIXELS_HARD);
    expect(cssWidth * ratio).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    expect(cssHeight * ratio).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
  });

  it.each([1.5, 2])(
    "degrades 4K dpr %s to CSS resolution (soft tier exceeded, hard budget holds)",
    (dpr) => {
      const { scale, cssWidth, cssHeight } = CONTENT_4K;
      const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, dpr);
      // The soft budget (2**24) is smaller than the 4K CSS page, but the
      // CSS-resolution floor kicks in before the ratio drops below 1: the
      // page stays at layout sharpness, never blurrier.
      expect(ratio).toBe(1);
      expect(ratio).toBeLessThan(dpr);
      const bufferPixels = cssWidth * cssHeight * ratio * ratio;
      expect(bufferPixels).toBeGreaterThan(MAX_RENDER_PIXELS);
      expect(bufferPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS_HARD);
      expect(cssWidth * ratio).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
      expect(cssHeight * ratio).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    },
  );

  it("pins a dpr-2 page smaller than 4K CSS at the soft budget (2**24)", () => {
    // Bench geometry class: a ~2600px content area fits the letter page at
    // ~4.25x (CSS ~9.1 MP). The soft tier binds: half the pixels of the
    // hard cap, dpr downscaled to the ratio.
    const { scale, cssWidth, cssHeight } = fitWidth(2600);
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 2);
    expect(ratio).toBeGreaterThan(1);
    const bufferPixels = cssWidth * cssHeight * ratio * ratio;
    expect(bufferPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1e-6);
    expect(bufferPixels).toBeGreaterThan(MAX_RENDER_PIXELS * 0.99);
  });

  it("digs into the hard budget only under zoom past the CSS floor", () => {
    // 200% zoom at 4K: the CSS page itself is 74.5 MP, so the CSS floor
    // cannot hold and the hard PERF-1 budget takes over.
    const { scale, cssWidth, cssHeight } = fitWidthZoom(3816, 2);
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 1);
    const bufferPixels = cssWidth * cssHeight * ratio * ratio;
    expect(bufferPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS_HARD + 1e-6);
    expect(bufferPixels).toBeGreaterThan(MAX_RENDER_PIXELS_HARD * 0.99);
  });

  it.each([1, 1.5, 2])("is inert below the threshold (1100×720 window, dpr %s)", (dpr) => {
    const { scale } = fitWidth(1064);
    expect(effectiveRenderRatio(LETTER.width, LETTER.height, scale, dpr)).toBe(dpr);
  });

  it("honors the per-dimension budget even when the area budget would not bind", () => {
    // A tall page: the area budget alone would allow more than the 5000 px
    // per-side cap; the dimension term must win.
    const ratio = effectiveRenderRatio(1000, 10000, 1, 2, { maxDimension: 5000 });
    expect(ratio).toBe(0.5);
    expect(10000 * ratio).toBe(5000);
  });

  it("honors the area budget even when the dimension budget would not bind", () => {
    const ratio = effectiveRenderRatio(1000, 1000, 1, 4, { maxPixels: 4 * 1000 * 1000 });
    expect(ratio).toBe(2);
    expect(1000 * 1000 * ratio * ratio).toBe(4 * 1000 * 1000);
  });

  it.each([
    ["zero width", 0, 792, 1, 2],
    ["zero height", 612, 0, 1, 2],
    ["zero scale", 612, 792, 0, 2],
    ["zero dpr", 612, 792, 1, 0],
  ])("falls back to 1 for unmeasurable geometry (%s)", (_label, width, height, scale, dpr) => {
    expect(effectiveRenderRatio(width, height, scale, dpr)).toBe(1);
  });
});

describe("render window byte budget (PERF-4)", () => {
  it("estimates RGBA buffer bytes from CSS size and ratio", () => {
    expect(renderBufferBytes(100, 50, 1)).toBe(100 * 50 * 4);
    expect(renderBufferBytes(100, 50, 2)).toBe(100 * 50 * 4 * 4);
  });

  it("keeps >= 3 capped 4K canvases at dpr 1 within 256 MB", () => {
    const { scale, cssWidth, cssHeight } = CONTENT_4K;
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 1);
    const bytes = renderBufferBytes(cssWidth, cssHeight, ratio);
    const order = Array.from({ length: 8 }, (_, index) => index);
    const kept = capByBytes(order, () => bytes, MAX_ACTIVE_CANVAS_BYTES);
    expect(kept.length).toBeGreaterThanOrEqual(3);
    // And the budget itself is respected by the kept set.
    expect(kept.length * bytes).toBeLessThanOrEqual(MAX_ACTIVE_CANVAS_BYTES);
  });

  it("keeps all 8 canvases at 1080p: the count cap governs, not bytes", () => {
    const { scale, cssWidth, cssHeight } = CONTENT_1080P;
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 1);
    const bytes = renderBufferBytes(cssWidth, cssHeight, ratio);
    const order = Array.from({ length: 8 }, (_, index) => index);
    // The full render window fits the byte budget at 1080p; the reader's
    // count cap (8) remains the effective limit.
    expect(order.length * bytes).toBeLessThanOrEqual(MAX_ACTIVE_CANVAS_BYTES);
    expect(capByBytes(order, () => bytes, MAX_ACTIVE_CANVAS_BYTES)).toHaveLength(8);
  });

  it("always keeps the anchor even when it alone exceeds the budget", () => {
    // Anchor-keep is a capByBytes guarantee, independent of the policy's
    // current tier sizes: a page whose buffer alone overflows the budget
    // must still render (the reader is on it).
    const oversized = MAX_ACTIVE_CANVAS_BYTES + 1;
    const kept = capByBytes([0, 1, 2], () => oversized, MAX_ACTIVE_CANVAS_BYTES);
    expect(kept).toEqual([0]);
  });

  it("keeps a prefix: the first byte-overflowing item ends the window", () => {
    const sizes = [10, 20, 30, 40, 50];
    const kept = capByBytes(sizes, (bytes) => bytes, 60);
    expect(kept).toEqual([10, 20, 30]);
  });
});
