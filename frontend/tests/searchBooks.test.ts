import { describe, expect, it } from "vitest";
import { searchBooks } from "@/components/search/searchBooks";
import { makeBook } from "./factories";

const library = [
  makeBook({
    id: 1,
    path: "/library/the-quiet-meridian.epub",
    title: "The Quiet Meridian",
    author: "Elena Vasquez",
    publisher: "Harborlight Press",
    isbn: "978-0-00-000001-1",
    description: "A season of tide charts and radio static.",
  }),
  makeBook({
    id: 2,
    path: "/library/systems-of-arrangement.pdf",
    title: "Systems of Arrangement",
    author: "Tomas Lindqvist",
    publisher: "Northlight Academic",
    isbn: "978-0-00-000002-2",
    description: "How archives impose order on abundance.",
  }),
];

describe("searchBooks", () => {
  it("matches title, author, and publisher case-insensitively", () => {
    expect(searchBooks(library, "quiet meridian").map((b) => b.id)).toEqual([1]);
    expect(searchBooks(library, "LINDQVIST").map((b) => b.id)).toEqual([2]);
    expect(searchBooks(library, "northlight").map((b) => b.id)).toEqual([2]);
  });

  it("matches ISBN, description, and file name", () => {
    expect(searchBooks(library, "978-0-00-000002-2").map((b) => b.id)).toEqual([2]);
    expect(searchBooks(library, "tide charts").map((b) => b.id)).toEqual([1]);
    expect(searchBooks(library, "systems-of-arrangement.epub").map((b) => b.id)).toEqual([]);
    expect(searchBooks(library, "systems-of-arrangement.pdf").map((b) => b.id)).toEqual([2]);
  });

  it("matches partial file names", () => {
    expect(searchBooks(library, "quiet-meridian").map((b) => b.id)).toEqual([1]);
  });

  it("matches nothing for an empty query", () => {
    expect(searchBooks(library, "")).toEqual([]);
    expect(searchBooks(library, "   ")).toEqual([]);
  });

  it("returns nothing when no field matches", () => {
    expect(searchBooks(library, "nonexistent")).toEqual([]);
  });
});
