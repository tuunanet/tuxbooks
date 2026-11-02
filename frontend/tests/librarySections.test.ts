import { describe, expect, it } from "vite-plus/test";
import {
  BOOK_SORT_OPTIONS,
  SMART_SECTION_TITLES,
  filterBooksByCollection,
  filterBooksByFormat,
  filterBooksByQuery,
  filterBooksBySection,
  sectionTitle,
  selectVisibleBooks,
  sortBooks,
} from "@/components/library/sections";
import type { LibrarySection } from "@/state/appState";
import { makeBook, makeCollection } from "./factories";

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

describe("filterBooksByFormat", () => {
  const books = [epub(), pdf(), neverOpened()];

  it("treats an empty selection as no restriction", () => {
    expect(filterBooksByFormat(books, [])).toHaveLength(3);
  });

  it("keeps one format", () => {
    expect(filterBooksByFormat(books, ["pdf"]).map((b) => b.id)).toEqual([2]);
  });

  it("keeps the union of several formats", () => {
    expect(filterBooksByFormat(books, ["epub", "pdf"]).map((b) => b.id)).toEqual([1, 2, 3]);
  });
});

describe("sectionTitle", () => {
  it("names smart sections and collections", () => {
    expect(sectionTitle({ kind: "smart", id: "recently-added" })).toBe("Recently Added");
    expect(sectionTitle({ kind: "collection", id: 4 })).toBe("Collection");
  });

  it("has no outside-watched id or title", () => {
    expect(Object.keys(SMART_SECTION_TITLES)).not.toContain("outside-watched");
    expect(Object.values(SMART_SECTION_TITLES)).not.toContain("Loose Books");
  });
});

describe("filterBooksBySection", () => {
  const books = [epub(), pdf(), neverOpened()];

  it("returns all books unchanged for All Books", () => {
    const all: LibrarySection = { kind: "smart", id: "all-books" };
    expect(filterBooksBySection(books, all)).toHaveLength(3);
  });

  it("has no format sections; formats are a header filter", () => {
    expect(Object.keys(SMART_SECTION_TITLES)).not.toContain("epubs");
    expect(Object.keys(SMART_SECTION_TITLES)).not.toContain("pdfs");
  });

  it("sorts Recently Added newest first", () => {
    const result = filterBooksBySection(books, { kind: "smart", id: "recently-added" });
    expect(result.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it("keeps only opened books in Recently Read, most recent first", () => {
    const result = filterBooksBySection(books, { kind: "smart", id: "recently-read" });
    expect(result.map((b) => b.id)).toEqual([2, 1]);
  });

  it("keeps started-but-unfinished books in In Progress, most recent first", () => {
    const inProgress = [
      makeBook({
        id: 10,
        title: "Halfway",
        progressPercent: 55,
        progressUpdatedAt: "2026-08-01T00:00:00.000Z",
      }),
      makeBook({
        id: 11,
        title: "Just Started",
        progressPercent: 5,
        progressUpdatedAt: "2026-08-09T00:00:00.000Z",
      }),
      makeBook({
        id: 12,
        title: "Done",
        progressPercent: 100,
        progressUpdatedAt: "2026-08-05T00:00:00.000Z",
      }),
      makeBook({ id: 13, title: "Unread", progressPercent: null, progressUpdatedAt: null }),
    ];
    const result = filterBooksBySection(inProgress, { kind: "smart", id: "in-progress" });
    expect(result.map((b) => b.id)).toEqual([11, 10]);
  });

  it("keeps 100%-progress books in Finished, most recent first", () => {
    const finished = [
      makeBook({
        id: 20,
        title: "Done First",
        progressPercent: 100,
        progressUpdatedAt: "2026-08-02T00:00:00.000Z",
      }),
      makeBook({
        id: 21,
        title: "Done Second",
        progressPercent: 100,
        progressUpdatedAt: "2026-08-08T00:00:00.000Z",
      }),
      makeBook({
        id: 22,
        title: "Halfway",
        progressPercent: 50,
        progressUpdatedAt: "2026-08-09T00:00:00.000Z",
      }),
    ];
    const result = filterBooksBySection(finished, { kind: "smart", id: "finished" });
    expect(result.map((b) => b.id)).toEqual([21, 20]);
  });
});

describe("filterBooksByCollection", () => {
  const books = [epub(), pdf(), neverOpened()];

  it("keeps only member books, in library order", () => {
    expect(filterBooksByCollection(books, [3, 1]).map((b) => b.id)).toEqual([1, 3]);
  });

  it("returns nothing when the collection is empty", () => {
    expect(filterBooksByCollection(books, [])).toEqual([]);
  });
});

describe("BOOK_SORT_OPTIONS", () => {
  it("offers section order as the first (default) option", () => {
    expect(BOOK_SORT_OPTIONS[0]).toEqual({ id: "section-order", label: "Section order" });
  });

  it("lists the five choices without the recently added and recently read shortcuts", () => {
    expect(BOOK_SORT_OPTIONS).toEqual([
      { id: "section-order", label: "Section order" },
      { id: "date-added", label: "Date added" },
      { id: "last-read", label: "Last read" },
      { id: "title", label: "Title" },
      { id: "author", label: "Author" },
    ]);
  });
});

describe("sortBooks", () => {
  const allBooks: LibrarySection = { kind: "smart", id: "all-books" };
  const collection: LibrarySection = { kind: "collection", id: 7 };
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

  it("sorts by date added newest first without mutating the input", () => {
    const input = [...titled];
    const result = sortBooks(input, "date-added", allBooks);
    expect(result.map((b) => b.id)).toEqual([2, 3, 1]);
    expect(input.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it("sorts by last read with never-opened books last", () => {
    const result = sortBooks(titled, "last-read", allBooks);
    expect(result.map((b) => b.id)).toEqual([3, 1, 2]);
  });

  it("sorts by title", () => {
    expect(sortBooks(titled, "title", allBooks).map((b) => b.title)).toEqual([
      "Archipelago",
      "Cartography",
      "Magnetism",
    ]);
  });

  it("sorts by author with missing authors last", () => {
    expect(sortBooks(titled, "author", allBooks).map((b) => b.id)).toEqual([2, 1, 3]);
  });

  it("uses date added for All Books under Section order", () => {
    expect(sortBooks(titled, "section-order", allBooks).map((b) => b.id)).toEqual([2, 3, 1]);
  });

  it("uses date added for a collection under Section order", () => {
    expect(sortBooks(titled, "section-order", collection).map((b) => b.id)).toEqual([2, 3, 1]);
  });
});

describe("selectVisibleBooks", () => {
  const books = [epub(), pdf(), neverOpened()];
  const base = {
    books,
    collections: [],
    formatFilter: [],
    query: "",
  };
  const collection = makeCollection({ id: 7, bookIds: [1, 3] });

  it("uses date added for All Books under Section order", () => {
    const result = selectVisibleBooks({
      ...base,
      section: { kind: "smart", id: "all-books" },
      sort: "section-order",
    });
    expect(result.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it("uses date added for a collection place under Section order", () => {
    const result = selectVisibleBooks({
      ...base,
      collections: [collection],
      section: { kind: "collection", id: 7 },
      sort: "section-order",
    });
    expect(result.map((b) => b.id)).toEqual([3, 1]);
  });

  it("keeps Recently Added in library added order under Section order", () => {
    const result = selectVisibleBooks({
      ...base,
      section: { kind: "smart", id: "recently-added" },
      sort: "section-order",
    });
    expect(result.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it("keeps Recently Read in last-opened order under Section order", () => {
    const result = selectVisibleBooks({
      ...base,
      section: { kind: "smart", id: "recently-read" },
      sort: "section-order",
    });
    expect(result.map((b) => b.id)).toEqual([2, 1]);
  });

  it("keeps In Progress in progress-updated order under Section order", () => {
    const inProgress = [
      makeBook({
        id: 10,
        progressPercent: 55,
        progressUpdatedAt: "2026-08-01T00:00:00.000Z",
      }),
      makeBook({
        id: 11,
        progressPercent: 5,
        progressUpdatedAt: "2026-08-09T00:00:00.000Z",
      }),
    ];
    const result = selectVisibleBooks({
      ...base,
      books: inProgress,
      section: { kind: "smart", id: "in-progress" },
      sort: "section-order",
    });
    expect(result.map((b) => b.id)).toEqual([11, 10]);
  });

  it("keeps Finished in progress-updated order under Section order", () => {
    const finished = [
      makeBook({
        id: 20,
        progressPercent: 100,
        progressUpdatedAt: "2026-08-02T00:00:00.000Z",
      }),
      makeBook({
        id: 21,
        progressPercent: 100,
        progressUpdatedAt: "2026-08-08T00:00:00.000Z",
      }),
    ];
    const result = selectVisibleBooks({
      ...base,
      books: finished,
      section: { kind: "smart", id: "finished" },
      sort: "section-order",
    });
    expect(result.map((b) => b.id)).toEqual([21, 20]);
  });

  it("applies an explicit sort over a smart section's natural order", () => {
    const result = selectVisibleBooks({
      ...base,
      section: { kind: "smart", id: "recently-read" },
      sort: "title",
    });
    expect(result.map((b) => b.title)).toEqual(["A Minimal Book", "PDF Book"]);
  });

  it("composes the format filter with Section order", () => {
    const result = selectVisibleBooks({
      ...base,
      formatFilter: ["pdf"],
      section: { kind: "smart", id: "all-books" },
      sort: "section-order",
    });
    expect(result.map((b) => b.id)).toEqual([2]);
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
