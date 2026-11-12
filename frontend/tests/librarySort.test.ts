import { describe, expect, it } from "vite-plus/test";
import {
  BOOK_SORT_OPTIONS,
  bookSortLabel,
  selectVisibleBooks,
  sortBooks,
} from "@/components/library/sections";
import { defaultSortFor, type LibrarySection } from "@/state/appState";
import { makeBook, makeCollection } from "./factories";
import { epub, neverOpened, pdf } from "./libraryBooks";

describe("BOOK_SORT_OPTIONS", () => {
  it("offers only concrete orders, starting with Date added", () => {
    expect(BOOK_SORT_OPTIONS[0]).toEqual({ id: "date-added", label: "Date added" });
  });

  it("lists the five concrete choices without a place-relative meta-option", () => {
    expect(BOOK_SORT_OPTIONS).toEqual([
      { id: "date-added", label: "Date added" },
      { id: "last-read", label: "Last read" },
      { id: "progress-updated", label: "Progress updated" },
      { id: "title", label: "Title" },
      { id: "author", label: "Author" },
    ]);
  });
});

describe("defaultSortFor", () => {
  it("uses the timestamp that defines each place", () => {
    expect(defaultSortFor({ kind: "smart", id: "all-books" })).toBe("date-added");
    expect(defaultSortFor({ kind: "smart", id: "recently-added" })).toBe("date-added");
    expect(defaultSortFor({ kind: "smart", id: "recently-read" })).toBe("last-read");
    expect(defaultSortFor({ kind: "smart", id: "in-progress" })).toBe("progress-updated");
    expect(defaultSortFor({ kind: "smart", id: "finished" })).toBe("progress-updated");
    expect(defaultSortFor({ kind: "reading-history" })).toBe("last-read");
    expect(defaultSortFor({ kind: "collection", ids: [7] })).toBe("date-added");
  });
});

describe("bookSortLabel", () => {
  it("labels the date option Added to collection inside a collection place", () => {
    expect(bookSortLabel("date-added", { kind: "smart", id: "all-books" })).toBe("Date added");
    expect(bookSortLabel("date-added", { kind: "collection", ids: [7] })).toBe(
      "Added to collection",
    );
  });

  it("leaves the other labels alone", () => {
    expect(bookSortLabel("title", { kind: "collection", ids: [7] })).toBe("Title");
  });
});

describe("sortBooks", () => {
  const allBooks: LibrarySection = { kind: "smart", id: "all-books" };
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

  it("applies the All Books default order, date added", () => {
    expect(sortBooks(titled, defaultSortFor(allBooks), allBooks).map((b) => b.id)).toEqual([
      2, 3, 1,
    ]);
  });
});

describe("sortBooks by collection membership", () => {
  const allBooks: LibrarySection = { kind: "smart", id: "all-books" };
  const collection: LibrarySection = { kind: "collection", ids: [8] };
  // Library order is [1, 2]: book 1 is newer. Membership says otherwise.
  const books = [
    makeBook({ id: 1, title: "Joined later", addedAt: "2026-06-01T00:00:00.000Z" }),
    makeBook({ id: 2, title: "Joined earlier", addedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const first = makeCollection({
    id: 7,
    bookIds: [1, 2],
    memberships: [
      { bookId: 1, addedAt: "2026-05-01T00:00:00.000Z" },
      { bookId: 2, addedAt: "2026-03-01T00:00:00.000Z" },
    ],
  });
  const second = makeCollection({
    id: 8,
    bookIds: [1, 2],
    memberships: [
      { bookId: 1, addedAt: "2026-02-01T00:00:00.000Z" },
      { bookId: 2, addedAt: "2026-04-01T00:00:00.000Z" },
    ],
  });

  it("orders a single collection by when each book joined it", () => {
    expect(sortBooks(books, "date-added", collection, [second]).map((b) => b.id)).toEqual([2, 1]);
  });

  it("treats membership order as the collection's default", () => {
    expect(
      sortBooks(books, defaultSortFor(collection), collection, [second]).map((b) => b.id),
    ).toEqual([2, 1]);
  });

  it("uses the earliest membership date across several selected collections", () => {
    // Book 1 joined first in May, book 2 in March, so `first` alone is [1, 2].
    // The second collection reverses that, and the earliest dates are Feb
    // (book 1) and March (book 2): [2, 1] whichever order the list arrives in.
    expect(sortBooks(books, "date-added", collection, [first]).map((b) => b.id)).toEqual([1, 2]);
    expect(sortBooks(books, "date-added", collection, [first, second]).map((b) => b.id)).toEqual([
      2, 1,
    ]);
    expect(sortBooks(books, "date-added", collection, [second, first]).map((b) => b.id)).toEqual([
      2, 1,
    ]);
  });

  it("keeps All Books on the library added date", () => {
    expect(sortBooks(books, "date-added", allBooks).map((b) => b.id)).toEqual([1, 2]);
    expect(sortBooks(books, defaultSortFor(allBooks), allBooks).map((b) => b.id)).toEqual([1, 2]);
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
  const collection = makeCollection({
    id: 7,
    bookIds: [1, 3],
    memberships: [
      { bookId: 1, addedAt: "2026-08-20T00:00:00.000Z" },
      { bookId: 3, addedAt: "2026-08-02T00:00:00.000Z" },
    ],
  });

  it("uses date added for All Books by default", () => {
    const result = selectVisibleBooks({
      ...base,
      section: { kind: "smart", id: "all-books" },
      sort: "date-added",
    });
    expect(result.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it("uses membership order for a collection place by default", () => {
    const result = selectVisibleBooks({
      ...base,
      collections: [collection],
      section: { kind: "collection", ids: [7] },
      sort: "date-added",
    });
    expect(result.map((b) => b.id)).toEqual([1, 3]);
  });

  it("shows the deduped union of selected collections in membership order", () => {
    const first = makeCollection({
      id: 7,
      bookIds: [1, 2],
      memberships: [
        { bookId: 1, addedAt: "2026-08-20T00:00:00.000Z" },
        { bookId: 2, addedAt: "2026-08-10T00:00:00.000Z" },
      ],
    });
    const second = makeCollection({
      id: 8,
      bookIds: [2, 3],
      memberships: [
        { bookId: 2, addedAt: "2026-08-01T00:00:00.000Z" },
        { bookId: 3, addedAt: "2026-08-05T00:00:00.000Z" },
      ],
    });
    const result = selectVisibleBooks({
      ...base,
      collections: [first, second],
      section: { kind: "collection", ids: [7, 8] },
      sort: "date-added",
    });
    // Book 2 is in both collections and appears once. It keeps its earliest
    // membership date (August 1), so the union orders 1, 3, 2.
    expect(result.map((b) => b.id)).toEqual([1, 3, 2]);
  });

  it("keeps Recently Added in library added order by default", () => {
    const result = selectVisibleBooks({
      ...base,
      section: { kind: "smart", id: "recently-added" },
      sort: "date-added",
    });
    expect(result.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it("keeps Recently Read in last-opened order by default", () => {
    const result = selectVisibleBooks({
      ...base,
      section: { kind: "smart", id: "recently-read" },
      sort: "last-read",
    });
    expect(result.map((b) => b.id)).toEqual([2, 1]);
  });

  it("keeps In Progress in progress-updated order by default", () => {
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
      sort: "progress-updated",
    });
    expect(result.map((b) => b.id)).toEqual([11, 10]);
  });

  it("keeps Finished in progress-updated order by default", () => {
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
      sort: "progress-updated",
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

  it("composes the format filter with the default order", () => {
    const result = selectVisibleBooks({
      ...base,
      formatFilter: ["pdf"],
      section: { kind: "smart", id: "all-books" },
      sort: "date-added",
    });
    expect(result.map((b) => b.id)).toEqual([2]);
  });
});
