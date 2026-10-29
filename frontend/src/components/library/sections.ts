import type { LibrarySection, SmartSectionId } from "@/state/appState";
import type { Book, BookFormat, CollectionSummary } from "@/types/domain";

export const SMART_SECTION_TITLES: Record<SmartSectionId, string> = {
  "all-books": "All Books",
  "recently-added": "Recently Added",
  "recently-read": "Recently Read",
  "in-progress": "In Progress",
  finished: "Finished",
};

export function sectionTitle(section: LibrarySection): string {
  switch (section.kind) {
    case "smart":
      return SMART_SECTION_TITLES[section.id];
    case "collection":
      return "Collection";
    case "reading-history":
      return "Reading history";
    case "settings":
      return "Settings";
  }
}

/** The header title: a collection's own name, otherwise the section title. */
export function libraryTitle(section: LibrarySection, collections: CollectionSummary[]): string {
  if (section.kind !== "collection") return sectionTitle(section);
  return collections.find((collection) => collection.id === section.id)?.name ?? "Collection";
}

/** True when the selected collection exists but holds no books. */
export function isCollectionEmpty(
  section: LibrarySection,
  collections: CollectionSummary[],
): boolean {
  if (section.kind !== "collection") return false;
  const collection = collections.find((entry) => entry.id === section.id);
  return (collection?.bookIds.length ?? 0) === 0;
}

interface SelectVisibleBooksInput {
  books: Book[];
  collections: CollectionSummary[];
  section: LibrarySection;
  formatFilter: readonly BookFormat[];
  sort: BookSortId;
  query: string;
}

/** Section or collection scope, then the format filter, sort, and search. */
export function selectVisibleBooks({
  books,
  collections,
  section,
  formatFilter,
  sort,
  query,
}: SelectVisibleBooksInput): Book[] {
  const scoped =
    section.kind === "collection"
      ? filterBooksByCollection(
          books,
          collections.find((collection) => collection.id === section.id)?.bookIds ?? [],
        )
      : filterBooksBySection(books, section);
  const filtered = filterBooksByFormat(scoped, formatFilter);
  return filterBooksByQuery(sortBooks(filtered, sort), query);
}

/**
 * Client-side filtering over the full `list_books` payload.
 */
export function filterBooksBySection(books: Book[], section: LibrarySection): Book[] {
  if (section.kind !== "smart") return books;
  switch (section.id) {
    case "all-books":
      return books;
    case "recently-added":
      return [...books].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    case "recently-read":
      return books
        .filter((book) => book.lastOpenedAt !== null)
        .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
    case "in-progress":
      // Started but not finished: a saved position below 100 (milestone 10).
      return books
        .filter((book) => book.progressPercent !== null && book.progressPercent < 100)
        .sort((a, b) => (b.progressUpdatedAt ?? "").localeCompare(a.progressUpdatedAt ?? ""));
    case "finished":
      // Explicitly marked finished (progress 100) or completed while reading.
      return books
        .filter((book) => book.progressPercent !== null && book.progressPercent >= 100)
        .sort((a, b) => (b.progressUpdatedAt ?? "").localeCompare(a.progressUpdatedAt ?? ""));
  }
}

/**
 * Keeps the formats the header filter has ticked. An empty selection is not
 * "nothing" — it is no restriction, which is why the trigger reads
 * "All formats".
 */
export function filterBooksByFormat(books: Book[], formats: readonly BookFormat[]): Book[] {
  if (formats.length === 0) return books;
  return books.filter((book) => formats.includes(book.format));
}

/**
 * Membership filter for collection sections (milestone 10): keeps only the
 * books whose id appears in the collection's member list.
 */
export function filterBooksByCollection(books: Book[], bookIds: number[]): Book[] {
  const members = new Set(bookIds);
  return books.filter((book) => members.has(book.id));
}

/** Sort orders offered by the library header select. */
export type BookSortId = "recently-added" | "recently-read" | "title" | "author";

export const BOOK_SORT_OPTIONS: { id: BookSortId; label: string }[] = [
  { id: "recently-added", label: "Recently Added" },
  { id: "recently-read", label: "Recently Read" },
  { id: "title", label: "Title" },
  { id: "author", label: "Author" },
];

export type BookViewMode = "grid" | "list";

/** Sorts above every real author, pushing missing authors to the end. */
const MISSING_AUTHOR_SORT_KEY = "\uffff";

export function sortBooks(books: Book[], sort: BookSortId): Book[] {
  const sorted = [...books];
  switch (sort) {
    case "recently-added":
      sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
      break;
    case "recently-read":
      // Books never opened sort behind everything with a timestamp.
      sorted.sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
      break;
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "author":
      sorted.sort((a, b) =>
        (a.author ?? MISSING_AUTHOR_SORT_KEY).localeCompare(b.author ?? MISSING_AUTHOR_SORT_KEY),
      );
      break;
  }
  return sorted;
}

/**
 * Case-insensitive instant filter over the same fields the global search
 * indexes (title, subtitle, author, publisher, ISBN, description, file
 * name). This is the library grid's view filter; ranked full-text search
 * lives in the backend (`search_books`) behind the global search box.
 */
export function filterBooksByQuery(books: Book[], query: string): Book[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return books;
  return books.filter((book) =>
    [
      book.title,
      book.subtitle,
      book.author,
      book.publisher,
      book.isbn,
      book.description,
      fileNameOf(book.path),
    ].some((field) => field !== null && field.toLowerCase().includes(needle)),
  );
}

/** The last path segment, regardless of platform separator. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
