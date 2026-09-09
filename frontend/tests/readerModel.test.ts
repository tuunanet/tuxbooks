import { describe, expect, it } from "vitest";
import {
  bookmarkInputFor,
  epubHrefJump,
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

const LOCATOR =
  '{"href":"chapter2.xhtml","type":"application/xhtml+xml","locations":{"progression":0.4}}';
const epubPosition: ReaderPosition = {
  format: "epub",
  locator: LOCATOR,
  chapterHref: "chapter2.xhtml",
};
const pdfPosition: ReaderPosition = { format: "pdf", page: 3, fraction: 0.25 };

describe("bookmark placement", () => {
  it("matches bookmarks at the exact EPUB locator only", () => {
    const bookmark = makeAnnotation({
      kind: "bookmark",
      cfi: LOCATOR,
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
      cfi: LOCATOR,
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
    expect(jumpToAnnotation(makeAnnotation({ cfi: LOCATOR, pageNumber: null }))).toEqual({
      format: "epub",
      locator: LOCATOR,
    });
    // Legacy foliate CFIs jump too — the engine migrates them on the fly.
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
        locator: LOCATOR,
        page: null,
        excerpt: { pre: "a ", match: "mole", post: " dug" },
      }),
    ).toEqual({ format: "epub", locator: LOCATOR });
    expect(
      jumpToSearchMatch({ locator: null, page: 2, excerpt: { pre: "", match: "x", post: "" } }),
    ).toEqual({ format: "pdf", page: 2 });
  });

  it("wraps spine and TOC hrefs into minimal href locators", () => {
    expect(epubHrefJump("chapter2.xhtml")).toEqual({
      format: "epub",
      locator: JSON.stringify({ href: "chapter2.xhtml" }),
    });
    // A TOC fragment rides along; the engine resolves it inside the section.
    expect(epubHrefJump("chapter2.xhtml#part")).toEqual({
      format: "epub",
      locator: JSON.stringify({ href: "chapter2.xhtml#part" }),
    });
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
    locator: null,
    progression: null,
    locations: null,
    engine: null,
    schemaVersion: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("passes locator-bearing EPUB rows through for engine-side resolution", () => {
    expect(parseEpubProgress(record)).toBe(record);
    const hrefOnly = { ...record, cfi: null, chapterHref: "chapter2.xhtml" };
    expect(parseEpubProgress(hrefOnly)).toBe(hrefOnly);
    // A migrated (Readium-engine) row passes through untouched.
    const migrated = { ...record, cfi: null, locator: LOCATOR, engine: "readium" };
    expect(parseEpubProgress(migrated)).toBe(migrated);
    expect(parseEpubProgress(null)).toBeNull();
  });

  it("rejects rows that carry no locator at all", () => {
    expect(
      parseEpubProgress({ ...record, cfi: null, chapterHref: null, pageNumber: 4 }),
    ).toBeNull();
    expect(
      parseEpubProgress({ ...record, cfi: "  ", chapterHref: "  ", pageNumber: 4 }),
    ).toBeNull();
  });

  it("accepts only in-range 1-based PDF pages", () => {
    expect(parsePdfProgress(record, 10)).toBe(4);
    expect(parsePdfProgress({ ...record, pageNumber: 0 }, 10)).toBeNull();
    expect(parsePdfProgress({ ...record, pageNumber: 11 }, 10)).toBeNull();
    expect(parsePdfProgress({ ...record, pageNumber: 4.5 }, 10)).toBeNull();
    expect(parsePdfProgress({ ...record, pageNumber: null }, 10)).toBeNull();
    expect(parsePdfProgress(null, 10)).toBeNull();
  });

  it("serializes each format's payload with the engine markers", () => {
    const payload = epubProgressPayload({ locator: LOCATOR, chapterHref: "chapter2.xhtml" }, 12.5);
    expect(payload).toEqual({
      locator: LOCATOR,
      progression: 0.125,
      locations: JSON.stringify({ progression: 0.4 }),
      engine: "readium",
      schemaVersion: 2,
      progressPercent: 12.5,
    });
    // The foliate-era columns are intentionally absent: the service
    // preserves them as provenance (docs/epub.md).
    expect(payload).not.toHaveProperty("cfi");
    expect(payload).not.toHaveProperty("chapterHref");
    expect(pdfProgressPayload(3, 66)).toEqual({ pageNumber: 3, progressPercent: 66 });
  });
});
