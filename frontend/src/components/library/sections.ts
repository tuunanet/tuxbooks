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

/** The collections a place selects, in sidebar order. */
export function selectedCollections(
  section: LibrarySection,
  collections: CollectionSummary[],
): CollectionSummary[] {
  if (section.kind !== "collection") return [];
  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  return section.ids.flatMap((id) => {
    const collection = byId.get(id);
    return collection ? [collection] : [];
  });
}

/**
 * The header title. One collection keeps its name; two are joined in sidebar
 * order; three or more count instead of listing every name.
 */
export function libraryTitle(section: LibrarySection, collections: CollectionSummary[]): string {
  if (section.kind !== "collection") return sectionTitle(section);
  const names = selectedCollections(section, collections).map((collection) => collection.name);
  if (section.ids.length >= 3) return `${section.ids.length} collections`;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names[0] ?? "Collection";
}

/** Why a collection place shows no books. */
export type CollectionEmptyKind = "none" | "empty" | "empty-multi";

/**
 * Distinguishes a single empty collection from a union whose collections all
 * hold no books. A place whose members exist but filters hide them is not
 * empty and is handled by the view's filter-aware state.
 */
export function collectionEmptyKind(
  section: LibrarySection,
  collections: CollectionSummary[],
): CollectionEmptyKind {
  if (section.kind !== "collection") return "none";
  const hasMembers = selectedCollections(section, collections).some(
    (collection) => collection.bookIds.length > 0,
  );
  if (hasMembers) return "none";
  return section.ids.length > 1 ? "empty-multi" : "empty";
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
  const placeCollections = selectedCollections(section, collections);
  // A multi-collection place shows the union of its members; the Set inside
  // filterBooksByCollection dedupes a book that belongs to several of them.
  const scoped =
    section.kind === "collection"
      ? filterBooksByCollection(
          books,
          placeCollections.flatMap((collection) => collection.bookIds),
        )
      : filterBooksBySection(books, section);
  const filtered = filterBooksByFormat(scoped, formatFilter);
  return filterBooksByQuery(sortBooks(filtered, sort, section, placeCollections), query);
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

/** Concrete sort orders offered by the library header select. */
export const BOOK_SORT_OPTIONS: { id: BookSortId; label: string }[] = [
  { id: "date-added", label: "Date added" },
  { id: "last-read", label: "Last read" },
  { id: "progress-updated", label: "Progress updated" },
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

/** The concrete field a sort id resolves to inside the current place. */
type BookSortField = BookSortId | "membership-date";

export type BookViewMode = "grid" | "list";

/** Sorts above every real author, pushing missing authors to the end. */
const MISSING_AUTHOR_SORT_KEY = "\uffff";

/** The field a chosen sort maps to for this place. */
function sortFieldFor(sort: BookSortId, section: LibrarySection): BookSortField {
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
