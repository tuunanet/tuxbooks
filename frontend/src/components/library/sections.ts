import type { LibrarySection, SmartSectionId } from "../../state/appState";
import type { Book } from "../../types/domain";

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
