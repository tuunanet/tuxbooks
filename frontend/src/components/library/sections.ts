import type { LibrarySection, SmartSectionId } from "@/state/appState";
import type { Book } from "@/types/domain";

export const SMART_SECTION_TITLES: Record<SmartSectionId, string> = {
  "all-books": "All Books",
  epubs: "EPUBs",
  pdfs: "PDFs",
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
    case "settings":
      return "Settings";
  }
}

/**
 * Client-side filtering over the full `list_books` payload.
 */
export function filterBooksBySection(books: Book[], section: LibrarySection): Book[] {
  if (section.kind !== "smart") return books;
  switch (section.id) {
    case "all-books":
      return books;
    case "epubs":
      return books.filter((book) => book.format === "epub");
    case "pdfs":
      return books.filter((book) => book.format === "pdf");
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
