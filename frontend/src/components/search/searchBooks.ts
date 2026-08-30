import type { Book } from "@/types/domain";

/** The last path segment, regardless of platform separator. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Client-side global search over title, author, publisher, ISBN,
 * description, and file name (task: no backend FTS command yet). An empty
 * query matches nothing so the results dropdown stays closed.
 */
export function searchBooks(books: Book[], query: string): Book[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return books.filter((book) =>
    [
      book.title,
      book.author,
      book.publisher,
      book.isbn,
      book.description,
      fileNameOf(book.path),
    ].some((field) => field !== null && field.toLowerCase().includes(needle)),
  );
}
