import type { Book } from "../src/lib/tauri";

export function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 1,
    path: "/tmp/library/minimal.epub",
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
    ...overrides,
  };
}
