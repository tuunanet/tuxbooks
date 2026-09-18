import { describe, expect, it } from "vitest";
import {
  AUTO_FIT_ASPECT_RATIO_RELATION,
  autoFitScale,
  clampOffset,
  clampZoom,
  compensateOffset,
  computePdfScale,
  documentHeight,
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
  stepZoomLevel,
  thumbnailGeometry,
  ZOOM_PRESETS,
  type LayoutSlot,
  type PageSize,
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
  it("contains the page when the area and page aspects are close", () => {
    // Letter page in a 1224×1584 area: both aspects ≈ 1.29, so fit page (2×).
    expect(autoFitScale(1224, 1584, 612, 792)).toBe(2);
  });

  it("fits the width when the area is relatively much wider than the page", () => {
    // areaAspect = 1030/1000 = 1.03, pageAspect = 792/612 ≈ 1.294:
    // relation ≈ 0.796 < 1/1.25, so the width binds.
    expect(autoFitScale(1000, 1030, 612, 792)).toBeCloseTo(1000 / 612, 10);
  });

  it("switches to contain at Okular's aspect threshold", () => {
    expect(AUTO_FIT_ASPECT_RATIO_RELATION).toBe(1.25);
    // areaAspect = 1100/1000 = 1.1 → relation ≈ 0.85, above the threshold.
    expect(autoFitScale(1000, 1100, 612, 792)).toBeCloseTo(fitPageScale(1000, 1100, 612, 792), 10);
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
