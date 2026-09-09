import { describe, expect, it } from "vitest";
import { normalizePdfOutline, type RawPdfOutline } from "@/lib/pdf/pdfOutline";

/** Builds a raw MuPDF outline entry (0-based pages). */
function raw(
  title: string,
  page: number | null | undefined,
  items?: RawPdfOutline[],
): RawPdfOutline {
  return { title, page, items };
}

describe("normalizePdfOutline", () => {
  it("returns an empty list for documents without an outline", () => {
    expect(normalizePdfOutline(null)).toEqual([]);
    expect(normalizePdfOutline(undefined)).toEqual([]);
    expect(normalizePdfOutline("bogus" as never)).toEqual([]);
  });

  it("converts 0-based engine pages to 1-based pages", () => {
    expect(normalizePdfOutline([raw("Part One", 40)])).toEqual([
      { title: "Part One", page: 41, items: [] },
    ]);
  });

  it("renders external-link entries inert (page null)", () => {
    expect(normalizePdfOutline([raw("Website", null)])).toEqual([
      { title: "Website", page: null, items: [] },
    ]);
    expect(normalizePdfOutline([raw("Website", undefined)])).toEqual([
      { title: "Website", page: null, items: [] },
    ]);
  });

  it("degrades negative page markers to inert rows", () => {
    expect(normalizePdfOutline([raw("Gone", -1)])).toEqual([
      { title: "Gone", page: null, items: [] },
    ]);
  });

  it("preserves nesting depth-first", () => {
    const outline = normalizePdfOutline([
      raw("Part One", 0, [raw("Section A", 0), raw("Section B", 10, [raw("Subsection", 11)])]),
    ]);
    expect(outline[0]?.title).toBe("Part One");
    expect(outline[0]?.page).toBe(1);
    expect(outline[0]?.items[1]?.page).toBe(11);
    expect(outline[0]?.items[1]?.items[0]?.title).toBe("Subsection");
    expect(outline[0]?.items[1]?.items[0]?.page).toBe(12);
  });

  it("skips malformed entries and non-string titles", () => {
    const outline = normalizePdfOutline([
      null,
      42,
      { title: 7, page: 1 },
      { title: "Ok", page: 2, items: [null, { title: "Kid", page: 3 }] },
    ] as never);
    expect(outline).toHaveLength(2);
    expect(outline[0]).toEqual({ title: "", page: 2, items: [] });
    expect(outline[1]?.items).toEqual([{ title: "Kid", page: 4, items: [] }]);
  });
});
