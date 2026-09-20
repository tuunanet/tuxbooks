import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  autoFitScale,
  clampOffset,
  clampZoom,
  compensateOffset,
  computePdfScale,
  documentHeight,
  documentMaxPageSize,
  displayedSizes,
  estimatePageSizes,
  fitHeightScale,
  fitPageScale,
  fitWidthScale,
  formatZoomPercent,
  layoutSlots,
  MAX_ZOOM,
  MIN_ZOOM,
  offsetForPage,
  pageAtOffset,
  PAGE_GAP_PX,
  parseZoomPercent,
  regionCovers,
  scaledPixels,
  stepZoomLevel,
  thumbnailGeometry,
  visiblePageRegion,
  wheelZoomScale,
  ZOOM_PRESETS,
  type LayoutSlot,
  type PageSize,
  type Rect,
} from "@/components/reader/pdf/pdfLayout";

const LETTER = { width: 612, height: 792 };

function sizes(entries: [number, number, number][]): PageSize[] {
  return entries.map(([pageNumber, width, height]) => ({ pageNumber, width, height }));
}

describe("fitWidthScale", () => {
  it("maps the reference page width onto the available width", () => {
    expect(fitWidthScale(1224, 612)).toBe(2);
    expect(fitWidthScale(306, 612)).toBe(0.5);
  });

  it("falls back to 1 for unmeasurable dimensions", () => {
    expect(fitWidthScale(0, 612)).toBe(1);
    expect(fitWidthScale(1224, 0)).toBe(1);
  });
});

describe("fitHeightScale", () => {
  it("maps the reference page height onto the available height", () => {
    expect(fitHeightScale(1584, 792)).toBe(2);
    expect(fitHeightScale(396, 792)).toBe(0.5);
  });

  it("falls back to 1 for unmeasurable dimensions", () => {
    expect(fitHeightScale(0, 792)).toBe(1);
    expect(fitHeightScale(1584, 0)).toBe(1);
  });
});

describe("fitPageScale", () => {
  it("lets the binding axis win", () => {
    // A 1224×1584 viewport fits the letter page at 2× on both axes.
    expect(fitPageScale(1224, 1584, 612, 792)).toBe(2);
    // A narrow viewport is width-bound.
    expect(fitPageScale(612, 1584, 612, 792)).toBe(1);
    // A short viewport is height-bound.
    expect(fitPageScale(1224, 396, 612, 792)).toBe(0.5);
  });

  it("falls back to 1 for degenerate page units", () => {
    expect(fitPageScale(1224, 1584, 0, 792)).toBe(1);
    expect(fitPageScale(1224, 1584, 612, 0)).toBe(1);
  });
});

describe("stepZoomLevel", () => {
  it("steps up and down the presets from an exact preset", () => {
    expect(stepZoomLevel(1, 1)).toBe(1.25);
    expect(stepZoomLevel(1.25, 1)).toBe(1.5);
    expect(stepZoomLevel(1.25, -1)).toBe(1);
    expect(stepZoomLevel(1, -1)).toBe(0.75);
  });

  it("snaps an off-preset scale onto the nearest preset before stepping", () => {
    // Zooming out of a fit mode continues from where the page actually is.
    expect(stepZoomLevel(1.2, 1)).toBe(1.25);
    expect(stepZoomLevel(1.2, -1)).toBe(1);
    expect(stepZoomLevel(2.6, 1)).toBe(4);
  });

  it("clamps at both ends of the preset range", () => {
    const floor = ZOOM_PRESETS[0] as number;
    const ceiling = ZOOM_PRESETS[ZOOM_PRESETS.length - 1] as number;
    expect(stepZoomLevel(floor, -1)).toBe(floor);
    expect(stepZoomLevel(ceiling, 1)).toBe(ceiling);
    // Below/above the range still clamps to the end preset.
    expect(stepZoomLevel(0.05, -1)).toBe(MIN_ZOOM);
    expect(stepZoomLevel(500, 1)).toBe(MAX_ZOOM);
  });
});

describe("clampZoom", () => {
  it("clamps onto the supported range", () => {
    expect(clampZoom(0.05)).toBe(MIN_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(500)).toBe(MAX_ZOOM);
  });

  it("resets unmeasurable values to 100%", () => {
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("wheelZoomScale", () => {
  it("multiplies by 1.2 per standard 100px notch, in and out", () => {
    expect(wheelZoomScale(1, -100, 0)).toBeCloseTo(1.2, 12);
    expect(wheelZoomScale(1, 100, 0)).toBeCloseTo(1 / 1.2, 12);
    // Chromium often reports ~±120 per notch; the formula is continuous.
    expect(wheelZoomScale(1, -120, 0)).toBeCloseTo(1.2 ** 1.2, 12);
  });

  it("follows small trackpad deltas continuously", () => {
    expect(wheelZoomScale(1, -10, 0)).toBeCloseTo(1.2 ** 0.1, 12);
    expect(wheelZoomScale(1, -5, 0)).toBeCloseTo(1.2 ** 0.05, 12);
  });

  it("normalizes line and page delta modes first", () => {
    // deltaMode 1 (lines): 5 lines × 16px = 80px.
    expect(wheelZoomScale(1, -5, 1)).toBeCloseTo(1.2 ** 0.8, 12);
    // deltaMode 2 (pages): a quarter viewport of 800px = 200px.
    expect(wheelZoomScale(1, -0.25, 2, 800)).toBeCloseTo(1.2 ** 2, 12);
    // The ±300px cap applies after normalization, not to the raw delta.
    expect(wheelZoomScale(1, -0.5, 2, 800)).toBeCloseTo(1.2 ** 3, 12);
  });

  it("caps one event at three notches (300px of delta)", () => {
    expect(wheelZoomScale(1, -10_000, 0)).toBeCloseTo(1.2 ** 3, 12);
    expect(wheelZoomScale(1, 50_000, 1)).toBeCloseTo(1.2 ** -3, 12);
  });

  it("clamps onto the supported zoom range", () => {
    expect(wheelZoomScale(90, -100, 0)).toBe(MAX_ZOOM);
    expect(wheelZoomScale(0.13, 100, 0)).toBe(MIN_ZOOM);
  });

  it("resets an unmeasurable base scale to 100%", () => {
    expect(wheelZoomScale(0, -100, 0)).toBe(1);
    expect(wheelZoomScale(Number.NaN, -100, 0)).toBe(1);
  });
});

describe("parseZoomPercent", () => {
  it("reads a percentage with or without the sign and accelerator", () => {
    expect(parseZoomPercent("150")).toBe(1.5);
    expect(parseZoomPercent("150%")).toBe(1.5);
    expect(parseZoomPercent(" 12.5 % ")).toBe(0.125);
    expect(parseZoomPercent("&125%")).toBe(1.25);
  });

  it("rejects empty, non-numeric, and non-positive input", () => {
    expect(parseZoomPercent("")).toBeNull();
    expect(parseZoomPercent("  ")).toBeNull();
    expect(parseZoomPercent("fit width")).toBeNull();
    expect(parseZoomPercent("0%")).toBeNull();
    expect(parseZoomPercent("-50")).toBeNull();
  });
});

describe("formatZoomPercent", () => {
  it("shows whole percentages without a trailing decimal", () => {
    expect(formatZoomPercent(1)).toBe("100");
    expect(formatZoomPercent(0.33)).toBe("33");
    expect(formatZoomPercent(2)).toBe("200");
  });

  it("keeps one decimal for off-preset scales", () => {
    expect(formatZoomPercent(0.125)).toBe("12.5");
    expect(formatZoomPercent(1.234)).toBe("123.4");
  });
});

describe("autoFitScale", () => {
  it("fits the width for a portrait page, whatever the area aspect (zoom_for_size_automatic)", () => {
    // doc_height >= doc_width → automatic is the fit-width scale, so a tall
    // area does not switch it to contain the way the old Okular rule did.
    expect(autoFitScale(1000, 1100, 612, 792)).toBeCloseTo(1000 / 612, 10);
    expect(autoFitScale(1224, 1584, 612, 792)).toBe(2);
  });

  it("takes the binding axis for a landscape page", () => {
    // doc_height < doc_width → MIN(fit width, fit height).
    expect(autoFitScale(1000, 744, 841.89, 612)).toBeCloseTo(1000 / 841.89, 10);
    expect(autoFitScale(600, 744, 841.89, 612)).toBeCloseTo(600 / 841.89, 10);
    expect(autoFitScale(2000, 400, 1000, 500)).toBeCloseTo(0.8, 10);
  });

  it("reserves the Papers margin on each side when spacing is given", () => {
    // target.width = 1024 - 2*12 = 1000, target.height = 768 - 2*12 = 744.
    expect(autoFitScale(1024, 768, 612, 792, 12)).toBeCloseTo(1000 / 612, 10);
    expect(autoFitScale(1024, 768, 841.89, 612, 12)).toBeCloseTo(1000 / 841.89, 10);
  });

  it("falls back to 1 for degenerate page units", () => {
    expect(autoFitScale(1224, 1584, 0, 792)).toBe(1);
    expect(autoFitScale(1224, 1584, 612, 0)).toBe(1);
  });
});

describe("computePdfScale", () => {
  const reference = { width: 612, height: 792 };

  it("computes the mode-specific document scale", () => {
    expect(
      computePdfScale(
        { mode: "fit-width", level: 1, reference, presentationPage: null },
        1224,
        1584,
      ),
    ).toBe(2);
    expect(
      computePdfScale(
        { mode: "fit-auto", level: 1, reference, presentationPage: null },
        1224,
        1584,
      ),
    ).toBe(2);
    expect(
      computePdfScale(
        { mode: "fit-page", level: 1, reference, presentationPage: null },
        1224,
        1000,
      ),
    ).toBe(1.2626262626262625);
    expect(
      computePdfScale(
        { mode: "custom", level: 1.5, reference, presentationPage: null },
        1224,
        1584,
      ),
    ).toBe(1.5);
  });

  it("fits the whole current page inside the area in presentation mode, whatever the mode", () => {
    // Mixed-size document: page 2 is landscape — presentation rescales per
    // page from the page being read, and both axes clamp so any page shape
    // stays fully visible.
    const landscape = { width: 1224, height: 612 };
    expect(
      computePdfScale(
        { mode: "fit-width", level: 1, reference, presentationPage: landscape },
        1224,
        612,
      ),
    ).toBe(1);
    expect(
      computePdfScale(
        { mode: "custom", level: 3, reference, presentationPage: landscape },
        1224,
        612,
      ),
    ).toBe(1);
    // A portrait page on the same landscape area is height-bound: 612 / 792.
    const portrait = { width: 612, height: 792 };
    expect(
      computePdfScale(
        { mode: "custom", level: 3, reference, presentationPage: portrait },
        1224,
        612,
      ),
    ).toBe(612 / 792);
    // A page wider than the area is width-bound instead of overflowing.
    const wide = { width: 2448, height: 612 };
    expect(
      computePdfScale({ mode: "fit-auto", level: 1, reference, presentationPage: wide }, 1224, 612),
    ).toBe(0.5);
  });

  it("falls back to 1 before geometry is known", () => {
    expect(
      computePdfScale(
        { mode: "fit-width", level: 1, reference: null, presentationPage: null },
        1224,
        1584,
      ),
    ).toBe(1);
    expect(
      computePdfScale({ mode: "custom", level: 0, reference, presentationPage: null }, 1224, 1584),
    ).toBe(1);
  });
});

/**
 * The committed native oracle (oracle/expected/geometry.json, schema
 * tuxbooks.papers-oracle/2) is the authority for the port. It records what
 * the real Papers `PpsView` computes at a 1024x768 viewport with `spacing`
 * reserved on each side: the three fit scales and the integer page sizes at
 * the fit-width scale. The formulas here must reproduce both.
 */
interface OraclePageSize {
  index: number;
  width: number;
  height: number;
}

interface OracleDocument {
  name: string;
  page_doc_sizes: OraclePageSize[];
  fit_scales: { fit_width: number; fit_page: number; automatic: number };
  page_sizes_fit_width: OraclePageSize[];
}

interface OracleGeometry {
  schema: string;
  viewport: { width: number; height: number };
  spacing: number;
  documents: OracleDocument[];
}

// The test runs with the frontend package as cwd (see the other repo-root
// readers, e.g. tests/security/preloadSurface.test.ts); walk up to the repo
// root for the committed oracle output.
const ORACLE: OracleGeometry = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "..", "oracle", "expected", "geometry.json"), "utf8"),
) as OracleGeometry;

/** Oracle page sizes as this module's PageSize (1-based page numbers). */
function oraclePages(entries: OraclePageSize[]): PageSize[] {
  return entries.map((entry) => ({
    pageNumber: entry.index + 1,
    width: entry.width,
    height: entry.height,
  }));
}

describe("Papers fidelity oracle (oracle/expected/geometry.json)", () => {
  it("carries the expected schema and fixtures", () => {
    expect(ORACLE.schema).toBe("tuxbooks.papers-oracle/2");
    expect(ORACLE.documents.length).toBeGreaterThan(0);
  });

  it("matches the three fit scales on every fixture", () => {
    for (const doc of ORACLE.documents) {
      const documentSize = documentMaxPageSize(oraclePages(doc.page_doc_sizes));
      expect(documentSize, doc.name).not.toBeNull();
      const base = { reference: documentSize, presentationPage: null };
      const { width, height } = ORACLE.viewport;

      expect(
        computePdfScale({ ...base, mode: "fit-width", level: 1 }, width, height, ORACLE.spacing),
        `${doc.name} fit width`,
      ).toBeCloseTo(doc.fit_scales.fit_width, 8);
      expect(
        computePdfScale({ ...base, mode: "fit-page", level: 1 }, width, height, ORACLE.spacing),
        `${doc.name} fit page`,
      ).toBeCloseTo(doc.fit_scales.fit_page, 8);
      expect(
        computePdfScale({ ...base, mode: "fit-auto", level: 1 }, width, height, ORACLE.spacing),
        `${doc.name} automatic`,
      ).toBeCloseTo(doc.fit_scales.automatic, 8);
    }
  });

  it("matches PpsView's whole-pixel page sizes at fit width on every fixture", () => {
    for (const doc of ORACLE.documents) {
      const pages = oraclePages(doc.page_doc_sizes);
      const documentSize = documentMaxPageSize(pages);
      const scale = computePdfScale(
        { mode: "fit-width", level: 1, reference: documentSize, presentationPage: null },
        ORACLE.viewport.width,
        ORACLE.viewport.height,
        ORACLE.spacing,
      );
      const displayed = displayedSizes(pages, scale);
      for (const expected of doc.page_sizes_fit_width) {
        const page = displayed.find((candidate) => candidate.pageNumber === expected.index + 1);
        expect(page, `${doc.name} page ${expected.index + 1}`).toBeDefined();
        expect(page?.width, `${doc.name} page ${expected.index + 1} width`).toBe(expected.width);
        expect(page?.height, `${doc.name} page ${expected.index + 1} height`).toBe(expected.height);
      }
    }
  });

  it("shows no sub-pixel page-size jitter across a zoom sweep", () => {
    const portrait = ORACLE.documents.find((doc) => doc.name === "portrait");
    expect(portrait).toBeDefined();
    const size = portrait?.page_doc_sizes[0];
    expect(size).toBeDefined();
    const page: PageSize = { pageNumber: 1, width: size?.width ?? 0, height: size?.height ?? 0 };

    let previousWidth = 0;
    let rawWasFractional = false;
    for (let i = 0; i <= 500; i++) {
      const scale = 0.12 + (i / 500) * (4 - 0.12);
      if (!Number.isInteger(page.width * scale)) rawWasFractional = true;
      const [displayed] = displayedSizes([page], scale);
      expect(displayed).toBeDefined();
      const width = displayed?.width ?? 0;
      const height = displayed?.height ?? 0;
      expect(Number.isInteger(width)).toBe(true);
      expect(Number.isInteger(height)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(previousWidth);
      previousWidth = width;
    }
    // The sweep did cross fractional raw products, so the integer sizes
    // above are the rounding's doing, not a coincidence.
    expect(rawWasFractional).toBe(true);

    const slots = layoutSlots(displayedSizes([page, { ...page, pageNumber: 2 }], 1.7));
    for (const slot of slots) {
      expect(Number.isInteger(slot.top)).toBe(true);
      expect(Number.isInteger(slot.width)).toBe(true);
      expect(Number.isInteger(slot.height)).toBe(true);
    }
  });
});

describe("estimatePageSizes", () => {
  it("fills the document with the reference size", () => {
    expect(estimatePageSizes(3, LETTER)).toEqual([
      { pageNumber: 1, width: 612, height: 792 },
      { pageNumber: 2, width: 612, height: 792 },
      { pageNumber: 3, width: 612, height: 792 },
    ]);
  });

  it("handles an empty document", () => {
    expect(estimatePageSizes(0, LETTER)).toEqual([]);
  });
});

describe("scaledPixels", () => {
  it("rounds points * scale to whole pixels like (int)(points * scale + 0.5)", () => {
    expect(scaledPixels(612, 2)).toBe(1224);
    expect(scaledPixels(612, 1.5)).toBe(918);
    // 612 * (1000/612) = 1000 exactly; a page one point heavier still rounds.
    expect(scaledPixels(595.276, 1000 / 612)).toBe(973);
    expect(scaledPixels(841.89, 1000 / 612)).toBe(1376);
    // The half-up boundary is what removes the sub-pixel remainder.
    expect(scaledPixels(10, 0.45)).toBe(5);
    expect(scaledPixels(10, 0.44)).toBe(4);
  });
});

describe("displayedSizes", () => {
  it("scales every page by the render scale", () => {
    const scaled = displayedSizes(
      sizes([
        [1, 612, 792],
        [2, 400, 400],
      ]),
      1.5,
    );
    expect(scaled[0]).toEqual({ pageNumber: 1, width: 918, height: 1188 });
    expect(scaled[1]).toEqual({ pageNumber: 2, width: 600, height: 600 });
  });

  it("rounds every displayed dimension to whole pixels", () => {
    // Mixed-size pages at the oracle's single-page fit-width scale: the raw
    // products are fractional, so rounding is observable.
    const scale = 1000 / 612;
    const scaled = displayedSizes(
      sizes([
        [1, 612, 792],
        [2, 595.276, 841.89],
        [3, 419.528, 595.276],
      ]),
      scale,
    );
    expect(scaled).toEqual([
      { pageNumber: 1, width: 1000, height: 1294 },
      { pageNumber: 2, width: 973, height: 1376 },
      { pageNumber: 3, width: 686, height: 973 },
    ]);
  });
});

describe("documentMaxPageSize", () => {
  it("takes each axis' maximum independently (pps_document_get_max_page_size)", () => {
    expect(
      documentMaxPageSize(
        sizes([
          [1, 612, 792],
          [2, 595.276, 841.89],
          [3, 612, 1008],
          [4, 419.528, 595.276],
        ]),
      ),
    ).toEqual({ width: 612, height: 1008 });
  });

  it("returns null for an empty document", () => {
    expect(documentMaxPageSize([])).toBeNull();
  });
});

describe("layoutSlots", () => {
  it("stacks uniform pages with the gap between them", () => {
    const slots = layoutSlots(displayedSizes(estimatePageSizes(3, LETTER), 1));
    expect(slots.map((slot) => slot.top)).toEqual([0, 792 + PAGE_GAP_PX, 2 * (792 + PAGE_GAP_PX)]);
    expect(documentHeight(slots)).toBe(3 * 792 + 2 * PAGE_GAP_PX);
  });

  it("keeps mixed page heights independent", () => {
    const slots = layoutSlots(
      displayedSizes(
        sizes([
          [1, 612, 792],
          [2, 792, 612],
          [3, 420, 595],
        ]),
        1,
      ),
      10,
    );
    expect(slots[0]).toMatchObject({ pageNumber: 1, top: 0, height: 792 });
    expect(slots[1]).toMatchObject({ pageNumber: 2, top: 802, height: 612 });
    expect(slots[2]).toMatchObject({ pageNumber: 3, top: 1424, height: 595 });
    expect(documentHeight(slots)).toBe(1424 + 595);
  });

  it("supports an empty document", () => {
    expect(layoutSlots([])).toEqual([]);
    expect(documentHeight([])).toBe(0);
  });
});

describe("pageAtOffset", () => {
  const slots: LayoutSlot[] = [
    { pageNumber: 1, top: 0, width: 612, height: 792 },
    { pageNumber: 2, top: 800, width: 612, height: 792 },
    { pageNumber: 3, top: 1600, width: 612, height: 792 },
  ];

  it("resolves offsets inside a page and in the gap above the next page", () => {
    expect(pageAtOffset(0, slots)).toBe(1);
    expect(pageAtOffset(791, slots)).toBe(1);
    // Gap offsets (792–799) belong to the page above.
    expect(pageAtOffset(795, slots)).toBe(1);
    expect(pageAtOffset(800, slots)).toBe(2);
    expect(pageAtOffset(1234, slots)).toBe(2);
    expect(pageAtOffset(10_000, slots)).toBe(3);
  });

  it("is monotonic while scrolling down", () => {
    let previous = 0;
    for (let offset = 0; offset <= 2400; offset += 25) {
      const page = pageAtOffset(offset, slots);
      expect(page).not.toBeNull();
      expect(page as number).toBeGreaterThanOrEqual(previous);
      previous = page as number;
    }
  });

  it("returns null for an empty document", () => {
    expect(pageAtOffset(0, [])).toBeNull();
  });
});

describe("offsetForPage", () => {
  it("returns slot tops and null for unknown pages", () => {
    const slots = layoutSlots(displayedSizes(estimatePageSizes(3, LETTER), 1));
    expect(offsetForPage(1, slots)).toBe(0);
    expect(offsetForPage(2, slots)).toBe(800);
    expect(offsetForPage(4, slots)).toBeNull();
  });
});

describe("clampOffset", () => {
  it("keeps the offset inside the scrollable range", () => {
    expect(clampOffset(-5, 600, 2400)).toBe(0);
    expect(clampOffset(1000, 600, 2400)).toBe(1000);
    expect(clampOffset(5000, 600, 2400)).toBe(1800);
  });

  it("handles documents shorter than the viewport", () => {
    expect(clampOffset(100, 600, 400)).toBe(0);
  });
});

describe("compensateOffset", () => {
  const before: LayoutSlot[] = [
    { pageNumber: 1, top: 0, width: 612, height: 792 },
    { pageNumber: 2, top: 800, width: 612, height: 792 },
    { pageNumber: 3, top: 1600, width: 612, height: 792 },
  ];

  it("does not move the offset when pages below changed", () => {
    const after: LayoutSlot[] = [
      { pageNumber: 1, top: 0, width: 612, height: 792 },
      { pageNumber: 2, top: 800, width: 612, height: 900 },
      { pageNumber: 3, top: 1708, width: 612, height: 792 },
    ];
    expect(compensateOffset(1000, before, after)).toBe(1000);
  });

  it("shifts the offset when pages above grew or shrank", () => {
    const after: LayoutSlot[] = [
      { pageNumber: 1, top: 0, width: 612, height: 900 },
      { pageNumber: 2, top: 908, width: 612, height: 792 },
      { pageNumber: 3, top: 1708, width: 612, height: 792 },
    ];
    expect(compensateOffset(1000, before, after)).toBe(1108);
  });

  it("keeps offsets stable when geometry is unchanged", () => {
    expect(
      compensateOffset(
        432,
        before,
        before.map((slot) => ({ ...slot })),
      ),
    ).toBe(432);
  });

  it("handles an empty document", () => {
    expect(compensateOffset(10, [], [])).toBe(10);
  });
});

describe("visiblePageRegion", () => {
  const page: Rect = { top: 100, left: 0, width: 600, height: 800 };
  const viewport: Rect = { top: 300, left: 0, width: 400, height: 400 };

  it("returns the visible intersection in page-local CSS pixels", () => {
    expect(visiblePageRegion(page, viewport, 0)).toEqual({
      top: 200,
      left: 0,
      width: 400,
      height: 400,
    });
  });

  it("expands by overscan but never past the page edges", () => {
    expect(visiblePageRegion(page, viewport, 150)).toEqual({
      top: 50,
      left: 0,
      width: 550,
      height: 700,
    });
  });

  it("returns null when the page is off-screen", () => {
    expect(visiblePageRegion(page, { top: 1000, left: 0, width: 400, height: 400 }, 0)).toBeNull();
    expect(visiblePageRegion(page, { top: 0, left: 700, width: 400, height: 400 }, 0)).toBeNull();
  });

  it("snaps outward to the grid to keep the region stable", () => {
    expect(visiblePageRegion(page, { top: 333, left: 44, width: 100, height: 100 }, 0, 64)).toEqual(
      { top: 192, left: 0, width: 192, height: 192 },
    );
  });
});

describe("regionCovers", () => {
  it("is true only when the rendered region contains the wanted one", () => {
    const rendered: Rect = { top: 0, left: 0, width: 100, height: 100 };
    expect(regionCovers(rendered, { top: 10, left: 10, width: 50, height: 50 })).toBe(true);
    expect(regionCovers(rendered, { top: 10, left: 10, width: 200, height: 50 })).toBe(false);
  });
});

describe("thumbnailGeometry", () => {
  it("preserves the page aspect at the cell width", () => {
    expect(thumbnailGeometry(LETTER, 112)).toEqual({
      width: 112,
      height: (112 * 792) / 612,
    });
    expect(thumbnailGeometry({ width: 792, height: 612 }, 112).height).toBeCloseTo(
      (112 * 612) / 792,
      10,
    );
  });

  it("falls back to a square cell for degenerate page units", () => {
    expect(thumbnailGeometry({ width: 0, height: 792 }, 112)).toEqual({
      width: 112,
      height: 112,
    });
    expect(thumbnailGeometry({ width: 612, height: 0 }, 112)).toEqual({
      width: 112,
      height: 112,
    });
  });
});
