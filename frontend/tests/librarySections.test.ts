import { describe, expect, it } from "vitest";
import {
  BOOK_SORT_OPTIONS,
  filterBooksByQuery,
  filterBooksBySection,
  sectionNeedsProgressData,
  sectionTitle,
  sortBooks,
} from "@/components/library/sections";
import type { LibrarySection } from "@/state/appState";
import { makeBook } from "./factories";

const epub = () =>
  makeBook({
    id: 1,
    addedAt: "2026-08-01T00:00:00.000Z",
    lastOpenedAt: "2026-08-05T00:00:00.000Z",
  });
const pdf = () =>
  makeBook({
    id: 2,
    path: "/tmp/library/doc.pdf",
    format: "pdf",
    title: "PDF Book",
    addedAt: "2026-08-10T00:00:00.000Z",
    lastOpenedAt: "2026-08-20T00:00:00.000Z",
  });
const neverOpened = () =>
  makeBook({ id: 3, addedAt: "2026-08-15T00:00:00.000Z", lastOpenedAt: null });

describe("sectionTitle", () => {
  it("names smart sections, collections, and settings", () => {
    expect(sectionTitle({ kind: "smart", id: "recently-added" })).toBe("Recently Added");
    expect(sectionTitle({ kind: "collection", id: 4 })).toBe("Collection");
    expect(sectionTitle({ kind: "settings" })).toBe("Settings");
  });
});

describe("sectionNeedsProgressData", () => {
  it("flags only the progress-backed sections", () => {
    expect(sectionNeedsProgressData({ kind: "smart", id: "in-progress" })).toBe(true);
    expect(sectionNeedsProgressData({ kind: "smart", id: "finished" })).toBe(true);
    expect(sectionNeedsProgressData({ kind: "smart", id: "pdfs" })).toBe(false);
    expect(sectionNeedsProgressData({ kind: "collection", id: 1 })).toBe(false);
  });
});

describe("filterBooksBySection", () => {
  const books = [epub(), pdf(), neverOpened()];

  it("returns all books unchanged for All Books", () => {
    const all: LibrarySection = { kind: "smart", id: "all-books" };
    expect(filterBooksBySection(books, all)).toHaveLength(3);
  });

  it("filters by format for EPUBs and PDFs", () => {
    expect(filterBooksBySection(books, { kind: "smart", id: "epubs" }).map((b) => b.id)).toEqual([
      1, 3,
    ]);
    expect(filterBooksBySection(books, { kind: "smart", id: "pdfs" }).map((b) => b.id)).toEqual([
      2,
    ]);
  });

  it("sorts Recently Added newest first", () => {
    const result = filterBooksBySection(books, { kind: "smart", id: "recently-added" });
    expect(result.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it("keeps only opened books in Recently Read, most recent first", () => {
    const result = filterBooksBySection(books, { kind: "smart", id: "recently-read" });
    expect(result.map((b) => b.id)).toEqual([2, 1]);
  });

  it("returns nothing for progress-backed sections (callers show a placeholder)", () => {
    expect(filterBooksBySection(books, { kind: "smart", id: "in-progress" })).toEqual([]);
    expect(filterBooksBySection(books, { kind: "smart", id: "finished" })).toEqual([]);
  });
});

describe("BOOK_SORT_OPTIONS", () => {
  it("offers recently added as the first (default) option", () => {
    expect(BOOK_SORT_OPTIONS[0]).toEqual({ id: "recently-added", label: "Recently Added" });
  });
});

describe("sortBooks", () => {
  const titled = [
    makeBook({
      id: 1,
      title: "Magnetism",
      author: "Nadia Cole",
      addedAt: "2026-01-01T00:00:00.000Z",
    }),
    makeBook({
      id: 2,
      title: "Archipelago",
      author: "Bo Lindqvist",
      addedAt: "2026-03-01T00:00:00.000Z",
    }),
    makeBook({
      id: 3,
      title: "Cartography",
      author: null,
      addedAt: "2026-02-01T00:00:00.000Z",
      lastOpenedAt: "2026-05-01T00:00:00.000Z",
    }),
  ];

  it("sorts recently added newest first without mutating the input", () => {
    const input = [...titled];
    const result = sortBooks(input, "recently-added");
    expect(result.map((b) => b.id)).toEqual([2, 3, 1]);
    expect(input.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it("sorts recently read with never-opened books last", () => {
    const result = sortBooks(titled, "recently-read");
    expect(result.map((b) => b.id)).toEqual([3, 1, 2]);
  });

  it("sorts by title", () => {
    expect(sortBooks(titled, "title").map((b) => b.title)).toEqual([
      "Archipelago",
      "Cartography",
      "Magnetism",
    ]);
  });

  it("sorts by author with missing authors last", () => {
    expect(sortBooks(titled, "author").map((b) => b.id)).toEqual([2, 1, 3]);
  });
});

describe("filterBooksByQuery", () => {
  const books = [
    makeBook({
      id: 1,
      title: "The Quiet Meridian",
      author: "Elena Vasquez",
      publisher: "Harborlight",
    }),
    makeBook({
      id: 2,
      title: "Systems of Arrangement",
      author: "Tomas Lindqvist",
      publisher: "Northlight",
    }),
  ];

  it("matches title, author, and publisher case-insensitively", () => {
    expect(filterBooksByQuery(books, "meridian").map((b) => b.id)).toEqual([1]);
    expect(filterBooksByQuery(books, "vasquez").map((b) => b.id)).toEqual([1]);
    expect(filterBooksByQuery(books, "northlight").map((b) => b.id)).toEqual([2]);
  });

  it("ignores empty and whitespace-only queries", () => {
    expect(filterBooksByQuery(books, "")).toHaveLength(2);
    expect(filterBooksByQuery(books, "   ")).toHaveLength(2);
  });

  it("returns nothing when no field matches", () => {
    expect(filterBooksByQuery(books, "zzz")).toEqual([]);
  });
});
