import { describe, expect, it } from "vitest";
import {
  bookmarkInputFor,
  epubProgressPayload,
  isBookmarkAtPosition,
  jumpToAnnotation,
  jumpToSearchMatch,
  parseEpubProgress,
  parsePdfProgress,
  pdfProgressPayload,
  type ReaderPosition,
} from "@/components/reader/readerModel";
import { makeAnnotation } from "./factories";

const epubPosition: ReaderPosition = {
  format: "epub",
  cfi: "epubcfi(/6/4!/4/2,/1:0,/1:42)",
  chapterHref: "chapter2.xhtml",
};
const pdfPosition: ReaderPosition = { format: "pdf", page: 3, fraction: 0.25 };

describe("bookmark placement", () => {
  it("matches bookmarks at the exact EPUB CFI only", () => {
    const bookmark = makeAnnotation({
      kind: "bookmark",
      cfi: "epubcfi(/6/4!/4/2,/1:0,/1:42)",
      chapterHref: "chapter2.xhtml",
      pageNumber: null,
      rects: null,
      text: null,
    });
    expect(isBookmarkAtPosition(bookmark, epubPosition)).toBe(true);
    expect(isBookmarkAtPosition(bookmark, pdfPosition)).toBe(false);
    expect(isBookmarkAtPosition(makeAnnotation({ kind: "highlight" }), epubPosition)).toBe(false);
  });

  it("matches bookmarks at the exact PDF page only", () => {
    const bookmark = makeAnnotation({
      kind: "bookmark",
      pageNumber: 3,
      cfi: null,
      rects: null,
      text: null,
    });
    expect(isBookmarkAtPosition(bookmark, pdfPosition)).toBe(true);
    expect(isBookmarkAtPosition(bookmark, epubPosition)).toBe(false);
  });

  it("builds the persisted bookmark input for both formats", () => {
    expect(bookmarkInputFor(epubPosition)).toEqual({
      kind: "bookmark",
      cfi: "epubcfi(/6/4!/4/2,/1:0,/1:42)",
      chapterHref: "chapter2.xhtml",
    });
    expect(bookmarkInputFor(pdfPosition)).toEqual({
      kind: "bookmark",
      pageNumber: 3,
      pageFraction: 0.25,
    });
    // A page-top position keeps no fraction: the page is the whole locator.
    expect(bookmarkInputFor({ format: "pdf", page: 1, fraction: 0 })).toEqual({
      kind: "bookmark",
      pageNumber: 1,
      pageFraction: null,
    });
  });
});

describe("navigation targets", () => {
  it("maps annotations onto their format's jump target", () => {
    expect(jumpToAnnotation(makeAnnotation({ cfi: "epubcfi(/6/2)", pageNumber: null }))).toEqual({
      format: "epub",
      locator: "epubcfi(/6/2)",
    });
    expect(jumpToAnnotation(makeAnnotation({ cfi: null, pageNumber: 4 }))).toEqual({
      format: "pdf",
      page: 4,
    });
    expect(jumpToAnnotation(makeAnnotation({ cfi: null, pageNumber: null }))).toBeNull();
  });

  it("maps search matches onto their format's jump target", () => {
    expect(
      jumpToSearchMatch({
        cfi: "epubcfi(/6/2!/4/2,/1:0,/1:8)",
        page: null,
        excerpt: { pre: "a ", match: "mole", post: " dug" },
      }),
    ).toEqual({ format: "epub", locator: "epubcfi(/6/2!/4/2,/1:0,/1:8)" });
    expect(
      jumpToSearchMatch({ cfi: null, page: 2, excerpt: { pre: "", match: "x", post: "" } }),
    ).toEqual({ format: "pdf", page: 2 });
  });
});

describe("progress persistence mapping", () => {
  const record = {
    bookId: 1,
    chapterHref: "chapter2.xhtml",
    cfi: "epubcfi(/6/4!/4/2,/1:0,/1:42)",
    characterOffset: null,
    pageNumber: 4,
    scrollOffset: null,
    progressPercent: 55,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts only canonical EPUB CFIs", () => {
    expect(parseEpubProgress(record)).toBe("epubcfi(/6/4!/4/2,/1:0,/1:42)");
    expect(parseEpubProgress({ ...record, cfi: null })).toBeNull();
    expect(parseEpubProgress({ ...record, cfi: "page 3" })).toBeNull();
    expect(parseEpubProgress(null)).toBeNull();
  });

  it("accepts only in-range 1-based PDF pages", () => {
    expect(parsePdfProgress(record, 10)).toBe(4);
    expect(parsePdfProgress({ ...record, pageNumber: 0 }, 10)).toBeNull();
    expect(parsePdfProgress({ ...record, pageNumber: 11 }, 10)).toBeNull();
    expect(parsePdfProgress({ ...record, pageNumber: 4.5 }, 10)).toBeNull();
    expect(parsePdfProgress({ ...record, pageNumber: null }, 10)).toBeNull();
    expect(parsePdfProgress(null, 10)).toBeNull();
  });

  it("serializes each format's payload", () => {
    expect(
      epubProgressPayload({ cfi: "epubcfi(/6/2)", chapterHref: "chapter1.xhtml" }, 12.5),
    ).toEqual({ cfi: "epubcfi(/6/2)", chapterHref: "chapter1.xhtml", progressPercent: 12.5 });
    expect(pdfProgressPayload(3, 66)).toEqual({ pageNumber: 3, progressPercent: 66 });
  });
});
