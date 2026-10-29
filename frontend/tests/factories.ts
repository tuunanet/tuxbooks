import type {
  Annotation,
  Book,
  BookFile,
  BookTrashEntry,
  CollectionSummary,
  ProviderLink,
  ReadingHistoryBook,
} from "@/types/domain";

export function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 1,
    bookUid: "0123456789abcdef0123456789abcdef",
    path: "/tmp/library/minimal.epub",
    format: "epub",
    title: "A Minimal Book",
    subtitle: null,
    author: "Ada Lovelace",
    publisher: "Tuxbooks Press",
    language: "en",
    isbn: "978-3-16-148410-0",
    description: "A tiny EPUB used as a test fixture.",
    coverPath: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: null,
    available: true,
    fileSize: 1024,
    fileMtime: 1767225600,
    publicationDate: null,
    seriesId: null,
    seriesIndex: null,
    seriesName: null,
    progressPercent: null,
    progressUpdatedAt: null,
    providerLinks: [],
    ...overrides,
  };
}

export function makeBookFile(overrides: Partial<BookFile> = {}): BookFile {
  return {
    id: 1,
    path: "/tmp/library/minimal.epub",
    available: true,
    fileSize: 1024,
    fileMtime: 1767225600,
    addedAt: "2026-01-01T00:00:00.000Z",
    active: true,
    ...overrides,
  };
}

export function makeReadingHistoryBook(
  overrides: Partial<ReadingHistoryBook> = {},
): ReadingHistoryBook {
  return {
    id: 41,
    bookUid: "abcdefabcdefabcdefabcdefabcdefab",
    title: "A Fine History",
    author: "Ada Lovelace",
    coverPath: null,
    progressPercent: 42,
    annotationCount: 3,
    lastOpenedAt: "2026-03-01T00:00:00.000Z",
    metadataState: "available",
    providerLinks: [],
    ...overrides,
  };
}

export function makeBookTrashEntry(overrides: Partial<BookTrashEntry> = {}): BookTrashEntry {
  return {
    id: 7,
    bookId: 41,
    bookUid: "abcdefabcdefabcdefabcdefabcdefab",
    title: "A Forgotten Book",
    author: "Ada Lovelace",
    deletedAt: "2026-03-01T00:00:00.000Z",
    expiresAt: "2026-03-31T00:00:00.000Z",
    progressPercent: 42,
    annotationCount: 2,
    replacementBookId: 51,
    hasNewState: false,
    ...overrides,
  };
}

export function makeProviderLink(overrides: Partial<ProviderLink> = {}): ProviderLink {
  return {
    bookUid: "abcdefabcdefabcdefabcdefabcdefab",
    provider: "hardcover",
    remoteId: "hc-42",
    status: "reading",
    statusUpdatedAt: "2026-03-01T00:00:00.000Z",
    linkedAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeCollection(overrides: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id: 1,
    name: "Favorites",
    createdAt: "2026-01-01T00:00:00.000Z",
    bookIds: [],
    ...overrides,
  };
}

export function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 1,
    bookId: 1,
    kind: "highlight",
    cfi: null,
    chapterHref: null,
    pageNumber: 2,
    pageFraction: null,
    text: "a quoted passage",
    color: "yellow",
    rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.02 }],
    label: null,
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
