import { describe, expect, it, vi } from "vitest";
import { normalizePdfOutline, type PdfOutlineSource } from "@/lib/pdf/pdfOutline";

/** Builds an outline source from pdfjs-shaped raw data. */
function makeSource(raw: unknown, pageIndexFor = (num: number) => num - 1): PdfOutlineSource {
  return {
    getOutline: vi.fn(async () => raw),
    getDestination: vi.fn(async () => [{ num: 2, gen: 0 }, "/XYZ"]),
    getPageIndex: vi.fn(async (ref: { num: number }) => pageIndexFor(ref.num)),
  };
}

const dest = (page: number): unknown => [{ num: page, gen: 0 }, "/XYZ", null, null, null];

describe("normalizePdfOutline", () => {
  it("returns an empty list for documents without an outline", async () => {
    expect(await normalizePdfOutline(makeSource(null))).toEqual([]);
    expect(await normalizePdfOutline(makeSource(undefined))).toEqual([]);
    expect(await normalizePdfOutline(makeSource("bogus"))).toEqual([]);
  });

  it("resolves explicit destinations to 1-based pages", async () => {
    const source = makeSource([{ title: "Part One", dest: dest(41), items: [] }]);
    expect(await normalizePdfOutline(source)).toEqual([{ title: "Part One", page: 41, items: [] }]);
    expect(source.getPageIndex).toHaveBeenCalledWith({ num: 41, gen: 0 });
  });

  it("resolves named destinations through the document", async () => {
    const source = makeSource([{ title: "Chapter", dest: "chapter-2", items: [] }]);
    expect(await normalizePdfOutline(source)).toEqual([{ title: "Chapter", page: 2, items: [] }]);
    expect(source.getDestination).toHaveBeenCalledWith("chapter-2");
  });

  it("renders external-link entries inert (page null)", async () => {
    const source = makeSource([
      { title: "Website", dest: null, url: "https://example.com", items: [] },
    ]);
    expect(await normalizePdfOutline(source)).toEqual([
      { title: "Website", page: null, items: [] },
    ]);
  });

  it("degrades unresolvable destinations to inert rows", async () => {
    const source = makeSource([
      { title: "Gone", dest: "missing-name", items: [] },
      { title: "Empty", dest: [], items: [] },
    ]);
    source.getDestination = vi.fn(async () => null);
    expect(await normalizePdfOutline(source)).toEqual([
      { title: "Gone", page: null, items: [] },
      { title: "Empty", page: null, items: [] },
    ]);
  });

  it("degrades page-resolution failures to inert rows", async () => {
    const source = makeSource([{ title: "Broken", dest: dest(7), items: [] }]);
    source.getPageIndex = vi.fn(async () => {
      throw new Error("page gone");
    });
    expect(await normalizePdfOutline(source)).toEqual([{ title: "Broken", page: null, items: [] }]);
  });

  it("preserves nesting depth-first", async () => {
    const source = makeSource([
      {
        title: "Part One",
        dest: dest(1),
        items: [
          { title: "Section A", dest: dest(1), items: [] },
          {
            title: "Section B",
            dest: dest(11),
            items: [{ title: "Subsection", dest: dest(12), items: [] }],
          },
        ],
      },
    ]);
    const outline = await normalizePdfOutline(source);
    expect(outline[0]?.title).toBe("Part One");
    expect(outline[0]?.items[1]?.page).toBe(11);
    expect(outline[0]?.items[1]?.items[0]?.title).toBe("Subsection");
  });

  it("skips malformed entries and non-string titles", async () => {
    const source = makeSource([
      null,
      42,
      { title: 7, dest: dest(2), items: [] },
      { title: "Ok", dest: dest(3), items: [null, { title: "Kid", dest: dest(4) }] },
    ]);
    const outline = await normalizePdfOutline(source);
    expect(outline).toHaveLength(2);
    expect(outline[0]).toEqual({ title: "", page: 2, items: [] });
    expect(outline[1]?.items).toEqual([{ title: "Kid", page: 4, items: [] }]);
  });
});
