/**
 * Frontend domain types mirroring the Rust domain models (src-tauri/src/domain).
 * IPC DTOs serialize camelCase; these interfaces match that wire format.
 */

export type BookFormat = "epub" | "pdf";

/** Mirrors `domain::Book` including the derived `format` field. */
export interface Book {
  id: number;
  path: string;
  format: BookFormat;
  title: string;
  subtitle: string | null;
  author: string | null;
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  description: string | null;
  coverPath: string | null;
  addedAt: string;
  modifiedAt: string;
  lastOpenedAt: string | null;
}

export interface LibraryStats {
  bookCount: number;
  collectionCount: number;
}

export interface ImportReport {
  imported: number;
  updated: number;
  failed: { path: string; error: string }[];
}

export interface BookToc {
  bookId: number;
  title: string;
  chapters: string[];
}

/**
 * Reading progress must stay format-specific so the backend can resume the
 * reader at the exact location (task §15). EPUB uses a CFI string, PDF a page
 * number. Persistence via a future `save_reading_progress` command.
 */
export interface EpubReadingProgress {
  kind: "epub";
  cfi: string;
  percentage: number;
}

export interface PdfReadingProgress {
  kind: "pdf";
  page: number;
  percentage: number;
}

export type ReadingProgress = EpubReadingProgress | PdfReadingProgress;
