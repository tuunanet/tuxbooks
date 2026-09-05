import type { Annotation, Book } from "@/types/domain";

export function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 1,
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
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
