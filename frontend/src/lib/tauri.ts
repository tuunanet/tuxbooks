import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Book,
  ImportReport,
  LibraryStats,
  ReadingProgressInput,
  ReadingProgressRecord,
} from "@/types/domain";

export type { Book, BookFormat, ImportReport, LibraryStats } from "@/types/domain";

export function getLibraryStats(): Promise<LibraryStats> {
  return invoke("get_library_stats");
}

export function listBooks(): Promise<Book[]> {
  return invoke("list_books");
}

export function scanLibrary(path: string): Promise<ImportReport> {
  return invoke("scan_library", { path });
}

/**
 * Subscribe to per-book import progress (the `import-progress` backend
 * event). The callback receives each book as soon as it is persisted, so
 * covers appear while a scan is still running. Resolves an unlisten fn.
 */
export function onImportProgress(callback: (book: Book) => void): Promise<() => void> {
  return listen<Book>("import-progress", (event) => callback(event.payload));
}

/**
 * Raw bytes of a stored book's source file. The command answers with an IPC
 * raw byte response, so `invoke` normally resolves to an ArrayBuffer — but
 * when the custom protocol is unavailable Tauri falls back to postMessage
 * transport, which JSON-serializes the bytes into a plain number array.
 * Consumers must accept both.
 */
export function getBookBytes(bookId: number): Promise<ArrayBuffer | number[]> {
  return invoke("get_book_bytes", { bookId });
}

/** Load the stored reading position for a book, if any. */
export function getReadingProgress(bookId: number): Promise<ReadingProgressRecord | null> {
  return invoke("get_reading_progress", { bookId });
}

/** Persist (upsert) where the user stopped reading a book. */
export function saveReadingProgress(bookId: number, progress: ReadingProgressInput): Promise<null> {
  return invoke("save_reading_progress", { bookId, progress });
}

/** Native folder picker; resolves to null when the user cancels. */
export function pickDirectory(): Promise<string | null> {
  return open({ directory: true, multiple: false, title: "Choose a folder to import" });
}

/** Tauri asset-protocol URL for an extracted cover image on disk. */
export function coverFileUrl(coverPath: string): string {
  return convertFileSrc(coverPath);
}
