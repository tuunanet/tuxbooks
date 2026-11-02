import type { BookSortId, LibrarySection, SmartSectionId } from "@/state/appState";
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
  const selectedCollections =
    section.kind === "collection"
      ? collections.filter((collection) => collection.id === section.id)
      : [];
  return filterBooksByQuery(sortBooks(filtered, sort, section, selectedCollections), query);
}

const byDateAddedDesc = (a: Book, b: Book) => b.addedAt.localeCompare(a.addedAt);
const byLastReadDesc = (a: Book, b: Book) =>
  (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? "");
const byProgressUpdatedDesc = (a: Book, b: Book) =>
  (b.progressUpdatedAt ?? "").localeCompare(a.progressUpdatedAt ?? "");

/**
 * Client-side filtering over the full `list_books` payload.
 */
export function filterBooksBySection(books: Book[], section: LibrarySection): Book[] {
  if (section.kind !== "smart") return books;
  switch (section.id) {
    case "all-books":
      return books;
    case "recently-added":
      return [...books].sort(byDateAddedDesc);
    case "recently-read":
      return books.filter((book) => book.lastOpenedAt !== null).sort(byLastReadDesc);
    case "in-progress":
      // Started but not finished: a saved position below 100 (milestone 10).
      return books
        .filter((book) => book.progressPercent !== null && book.progressPercent < 100)
        .sort(byProgressUpdatedDesc);
    case "finished":
      // Explicitly marked finished (progress 100) or completed while reading.
      return books
        .filter((book) => book.progressPercent !== null && book.progressPercent >= 100)
        .sort(byProgressUpdatedDesc);
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
export const BOOK_SORT_OPTIONS: { id: BookSortId; label: string }[] = [
  { id: "section-order", label: "Section order" },
  { id: "date-added", label: "Date added" },
  { id: "last-read", label: "Last read" },
  { id: "title", label: "Title" },
  { id: "author", label: "Author" },
];

/**
 * The date option names the place's own timestamp: a collection orders by
 * when each book joined it, not when the book entered the library.
 */
export function bookSortLabel(id: BookSortId, section: LibrarySection): string {
  if (id === "date-added") {
    return section.kind === "collection" ? "Added to collection" : "Date added";
  }
  return BOOK_SORT_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

/** The concrete field a sort id resolves to; only Section order picks by place. */
type BookSortField =
  | "date-added"
  | "membership-date"
  | "last-read"
  | "progress-updated"
  | "title"
  | "author";

/**
 * A place's natural order. All Books uses the library added date; a
 * collection uses the earliest membership date among its selected
 * collections; the smart sections keep the timestamp that defines them.
 */
function sectionOrderField(section: LibrarySection): BookSortField {
  if (section.kind === "collection") return "membership-date";
  if (section.kind === "reading-history") return "last-read";
  switch (section.id) {
    case "all-books":
    case "recently-added":
      return "date-added";
    case "recently-read":
      return "last-read";
    case "in-progress":
    case "finished":
      return "progress-updated";
  }
}

export type BookViewMode = "grid" | "list";

/** Sorts above every real author, pushing missing authors to the end. */
const MISSING_AUTHOR_SORT_KEY = "\uffff";

/** The field a chosen sort maps to for this place. */
function sortFieldFor(sort: BookSortId, section: LibrarySection): BookSortField {
  if (sort === "section-order") return sectionOrderField(section);
  // Inside a collection place the date option is Added to collection.
  if (sort === "date-added" && section.kind === "collection") return "membership-date";
  return sort;
}

/**
 * The earliest date a book joined any of the selected collections. A book in
 * several selected collections keeps its oldest timestamp, so it does not
 * look newly added every time it joins another one.
 */
function earliestMembershipDates(collections: CollectionSummary[]): Map<number, string> {
  const dates = new Map<number, string>();
  for (const collection of collections) {
    for (const membership of collection.memberships) {
      const current = dates.get(membership.bookId);
      if (current === undefined || membership.addedAt.localeCompare(current) < 0) {
        dates.set(membership.bookId, membership.addedAt);
      }
    }
  }
  return dates;
}

export function sortBooks(
  books: Book[],
  sort: BookSortId,
  section: LibrarySection,
  selectedCollections: CollectionSummary[] = [],
): Book[] {
  const sorted = [...books];
  const field = sortFieldFor(sort, section);
  switch (field) {
    case "date-added":
      sorted.sort(byDateAddedDesc);
      break;
    case "membership-date": {
      const dates = earliestMembershipDates(selectedCollections);
      sorted.sort((a, b) =>
        (dates.get(b.id) ?? b.addedAt).localeCompare(dates.get(a.id) ?? a.addedAt),
      );
      break;
    }
    case "last-read":
      // Books never opened sort behind everything with a timestamp.
      sorted.sort(byLastReadDesc);
      break;
    case "progress-updated":
      sorted.sort(byProgressUpdatedDesc);
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
