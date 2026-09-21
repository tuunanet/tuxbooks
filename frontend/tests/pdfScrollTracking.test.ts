import { describe, expect, it } from "vitest";
import { anchorAtViewportOffset } from "@/components/reader/pdf/hooks/usePdfScrollTracking";
import {
  centerValue,
  displayedSizes,
  documentHeight,
  keepPositionValue,
  layoutSlots,
  PAGE_GAP_PX,
  type PageSize,
} from "@/components/reader/pdf/pdfLayout";

const PAGES: PageSize[] = [
  { pageNumber: 1, width: 612, height: 792 },
  { pageNumber: 2, width: 612, height: 792 },
];

describe("anchorAtViewportOffset", () => {
  it("resolves the page and fraction at a viewport position", () => {
    const slots = layoutSlots(displayedSizes(PAGES, 1));
    // Scroll 900, reading anchor 180px down (25% of a 720px viewport):
    // content offset 1080 sits in page 2, 280px in.
    const info = anchorAtViewportOffset(180, 900, 0, slots);
    expect(info).toEqual({ page: 2, fraction: 280 / 792 });
  });

  it("returns null for an empty document", () => {
    expect(anchorAtViewportOffset(180, 900, 0, [])).toBeNull();
  });
});

describe("pointer-anchored zoom across a scale change", () => {
  it("holds the document point under the pointer fixed", () => {
    const scale = 1;
    const nextScale = 1.2;
    const viewport = 400;
    const pointerOffset = 200;
    const scroll = 100;

    const beforeSlots = layoutSlots(displayedSizes(PAGES, scale), PAGE_GAP_PX);
    const afterSlots = layoutSlots(displayedSizes(PAGES, nextScale), PAGE_GAP_PX);
    const before = anchorAtViewportOffset(pointerOffset, scroll, 0, beforeSlots);
    expect(before).not.toBeNull();

    // The center policy: the point at `scroll + pointerOffset` keeps the same
    // fraction of the content (upper is the raw content extent).
    const oldAdjustment = {
      value: scroll,
      upper: documentHeight(beforeSlots),
      pageSize: viewport,
    };
    const nextScroll = centerValue(
      oldAdjustment,
      documentHeight(afterSlots),
      viewport,
      pointerOffset,
    );
    const after = anchorAtViewportOffset(pointerOffset, nextScroll, 0, afterSlots);

    expect(after?.page).toBe(before?.page);
    // Integer page sizing leaves sub-point drift; the point stays under the
    // pointer within a fraction of a CSS pixel.
    expect(Math.abs((after?.fraction as number) - (before?.fraction as number))).toBeLessThan(
      1 / 792,
    );
  });

  it("does not hold the point under a keep-position re-layout", () => {
    const viewport = 400;
    const pointerOffset = 200;
    const beforeSlots = layoutSlots(displayedSizes(PAGES, 1), PAGE_GAP_PX);
    const afterSlots = layoutSlots(displayedSizes(PAGES, 1.2), PAGE_GAP_PX);
    const before = anchorAtViewportOffset(pointerOffset, 100, 0, beforeSlots);
    const keptScroll = keepPositionValue(
      {
        value: 100,
        upper: documentHeight(beforeSlots),
        pageSize: viewport,
      },
      documentHeight(afterSlots),
      viewport,
    );
    const kept = anchorAtViewportOffset(pointerOffset, keptScroll, 0, afterSlots);
    // Keep-position preserves the relative scroll, not the pointer point.
    expect(kept?.fraction).not.toBeCloseTo(before?.fraction as number, 2);
  });
});
