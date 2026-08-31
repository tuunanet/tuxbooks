import { describe, expect, it } from "vitest";
import {
  clampOffset,
  compensateOffset,
  documentHeight,
  displayedSizes,
  estimatePageSizes,
  layoutSlots,
  offsetForPage,
  pageAtOffset,
  PAGE_GAP_PX,
  type LayoutSlot,
  type PageSize,
} from "@/components/reader/pdf/pdfLayout";

const LETTER = { width: 612, height: 792 };

function sizes(entries: [number, number, number][]): PageSize[] {
  return entries.map(([pageNumber, width, height]) => ({ pageNumber, width, height }));
}

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
