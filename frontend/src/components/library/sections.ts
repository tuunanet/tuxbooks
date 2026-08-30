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
 * "In Progress" and "Finished" derive from reading-progress data, which no
 * backend command exposes yet. Callers show an honest placeholder instead of
 * pretending to filter (task §28).
 */
export function sectionNeedsProgressData(section: LibrarySection): boolean {
  return section.kind === "smart" && (section.id === "in-progress" || section.id === "finished");
}

/**
 * Client-side filtering over the full `list_books` payload. Sections that
 * need progress data return an empty list — check
 * `sectionNeedsProgressData` first.
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
    case "finished":
      return [];
  }
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

/** Case-insensitive client-side search over title, author, and publisher. */
export function filterBooksByQuery(books: Book[], query: string): Book[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return books;
  return books.filter((book) =>
    [book.title, book.author, book.publisher].some(
      (field) => field !== null && field.toLowerCase().includes(needle),
    ),
  );
}
