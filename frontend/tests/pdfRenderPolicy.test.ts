import { describe, expect, it } from "vite-plus/test";

import {
  MAX_ACTIVE_CANVAS_BYTES,
  MAX_RENDER_DIMENSION,
  MAX_RENDER_PIXELS,
  MAX_RENDER_PIXELS_HARD,
  capByBytes,
  effectiveRenderRatio,
  needsRegionRender,
  presentationPagePlan,
  regionRenderRatio,
  regionRenderRatioForPage,
  renderBufferBytes,
  retentionRing,
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
      // The CSS-resolution floor binds before the ratio drops below 1: never blurrier.
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
    const { scale, cssWidth, cssHeight } = fitWidth(2600);
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 2);
    expect(ratio).toBeGreaterThan(1);
    const bufferPixels = cssWidth * cssHeight * ratio * ratio;
    expect(bufferPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1e-6);
    expect(bufferPixels).toBeGreaterThan(MAX_RENDER_PIXELS * 0.99);
  });

  it("digs into the hard budget only under zoom past the CSS floor", () => {
    // At 200% zoom the CSS page is 74.5 MP, so the hard PERF-1 budget takes over.
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
  it("keeps >= 3 capped 4K canvases at dpr 1 within 256 MB", () => {
    const { scale, cssWidth, cssHeight } = CONTENT_4K;
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 1);
    const bytes = renderBufferBytes(cssWidth, cssHeight, ratio);
    const order = Array.from({ length: 8 }, (_, index) => index);
    const kept = capByBytes(order, () => bytes, MAX_ACTIVE_CANVAS_BYTES);
    expect(kept.length).toBeGreaterThanOrEqual(3);
    expect(kept.length * bytes).toBeLessThanOrEqual(MAX_ACTIVE_CANVAS_BYTES);
  });

  it("keeps all 8 canvases at 1080p: the count cap governs, not bytes", () => {
    const { scale, cssWidth, cssHeight } = CONTENT_1080P;
    const ratio = effectiveRenderRatio(LETTER.width, LETTER.height, scale, 1);
    const bytes = renderBufferBytes(cssWidth, cssHeight, ratio);
    const order = Array.from({ length: 8 }, (_, index) => index);
    expect(order.length * bytes).toBeLessThanOrEqual(MAX_ACTIVE_CANVAS_BYTES);
    expect(capByBytes(order, () => bytes, MAX_ACTIVE_CANVAS_BYTES)).toHaveLength(8);
  });

  it("always keeps the anchor even when it alone exceeds the budget", () => {
    // Anchor-keep is unconditional: a page whose buffer alone overflows still renders.
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

describe("retentionRing", () => {
  it("keeps rendered candidates within three of the visible range, closest first", () => {
    expect(retentionRing([10, 11], [15, 7, 10, 12, 9, 13, 11])).toEqual([9, 12, 13, 7]);
  });

  it("drops candidates beyond the depth", () => {
    // Boundary: depth 3 keeps, depth 4 drops (matches MAX_PRELOADED_PAGES).
    expect(retentionRing([5], [8, 9])).toEqual([8]);
    expect(retentionRing([5], [])).toEqual([]);
  });

  it("retains nothing before visibility tracking starts", () => {
    // An empty visible set must not mean "keep the whole document".
    expect(retentionRing([], [1, 2, 3])).toEqual([]);
  });

  it("never invents pages: only offered candidates come back", () => {
    expect(retentionRing([5], [6])).toEqual([6]);
    expect(retentionRing([5], [50, 60])).toEqual([]);
  });

  it("counts each candidate once even when offered twice", () => {
    expect(retentionRing([1], [4, 4, 3, 3])).toEqual([3, 4]);
  });

  it("honors a custom depth", () => {
    expect(retentionRing([10], [12, 14], 5)).toEqual([12, 14]);
    expect(retentionRing([10], [12, 14], 0)).toEqual([]);
  });
});

describe("presentationPagePlan", () => {
  it("reproduces the layout's rounded slot", () => {
    const scale = 768 / 792;
    expect(presentationPagePlan(LETTER, scale, 1)).toEqual({ width: 593, height: 768, ratio: 1 });
  });

  it("tracks devicePixelRatio without changing the slot geometry", () => {
    const scale = 768 / 792;
    expect(presentationPagePlan(LETTER, scale, 2).ratio).toBe(2);
    expect(presentationPagePlan(LETTER, scale, 2).width).toBe(593);
  });

  it("fits a landscape page to the area width", () => {
    const landscape = { width: 1224, height: 612 } as const;
    const scale = (1224 - 24) / 1224;
    expect(presentationPagePlan(landscape, scale, 1)).toEqual({
      width: 1200,
      height: 600,
      ratio: 1,
    });
  });
});

describe("needsRegionRender", () => {
  it("is false when the whole-page ratio reaches the device ratio", () => {
    expect(needsRegionRender(LETTER.width, LETTER.height, 1, 1)).toBe(false);
    expect(needsRegionRender(LETTER.width, LETTER.height, 1.5, 2)).toBe(false);
  });

  it("is true once a budget tier pushes the ratio below the device ratio", () => {
    expect(needsRegionRender(LETTER.width, LETTER.height, 100, 1)).toBe(true);
    expect(needsRegionRender(LETTER.width, LETTER.height, 100, 2)).toBe(true);
  });
});

describe("regionRenderRatio", () => {
  it("targets the device ratio for a viewport-sized region", () => {
    expect(regionRenderRatio(1000, 700, 2)).toBe(2);
    expect(regionRenderRatio(1000, 700, 1)).toBe(1);
  });

  it("clamps to the hard dimension budget for an oversized region", () => {
    expect(regionRenderRatio(20000, 1000, 2)).toBeCloseTo(8192 / 20000, 10);
  });

  it("falls back to 1 for unmeasurable inputs", () => {
    expect(regionRenderRatio(0, 700, 2)).toBe(1);
    expect(regionRenderRatio(1000, 700, 0)).toBe(1);
  });
});

describe("regionRenderRatioForPage", () => {
  const plot = { width: 279.5, height: 248.5 } as const;
  const region = { width: 2536, height: 2236 } as const;

  it("caps the device scale so a page-sized shading stays inside the budget", () => {
    // PDFium allocates a page-sized shading buffer at the device scale, not the clip's:
    // an uncapped 43× scale high-waters the WASM heap, so the cap holds it under 22.
    for (const scale of [11, 21.5, 43, 100]) {
      const ratio = regionRenderRatioForPage(
        plot.width,
        plot.height,
        region.width,
        region.height,
        scale,
        2,
      );
      const deviceScale = scale * ratio;
      const pageDevicePixels = plot.width * deviceScale * (plot.height * deviceScale);
      expect(pageDevicePixels, `scale ${scale}`).toBeLessThanOrEqual(MAX_RENDER_PIXELS_HARD * 1.02);
      expect(deviceScale, `scale ${scale}`).toBeLessThanOrEqual(22);
    }
  });

  it("keeps the plain region ratio while the page fits the budget", () => {
    expect(
      regionRenderRatioForPage(plot.width, plot.height, region.width, region.height, 1, 2),
    ).toBe(2);
  });
});
