/**
 * The renderer's only window.tuxbooks consumer (docs/architecture.md). Every
 * call to the Rust service, native picker, or protocol URL goes through the
 * typed wrappers here; components never touch the preload API directly.
 */

import type {
  Annotation,
  AnnotationInput,
  AnnotationPatch,
  Book,
  BookFormat,
  BookMetadata,
  CollectionSummary,
  ImportReport,
  LibraryChange,
  LibraryStats,
  MetadataFields,
  ReadingProgressInput,
  ReadingProgressRecord,
  SearchHit,
} from "@/types/domain";

export type {
  Book,
  BookFormat,
  BookMetadata,
  CollectionSummary,
  ImportReport,
  LibraryChange,
  LibraryStats,
  MetadataFields,
} from "@/types/domain";

/** Shape of the sandboxed preload bridge (`electron/preload/preload.ts`). */
export interface TuxbooksApi {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(name: string, callback: (payload: unknown) => void): () => void;
  pickDirectory(): Promise<string | null>;
  pickBookFile(): Promise<string | null>;
  pickBookFiles(): Promise<string[]>;
  pickCoverImage(): Promise<string | null>;
  revealInFileManager(path: string): Promise<void>;
  fetchBookBytes(bookId: number, format: string): Promise<ArrayBuffer>;
  pathForFile(file: File): string;
}

/** The preload API; missing only when a test or non-Electron host forgot the mock. */
export function tuxbooks(): TuxbooksApi {
  if (!window.tuxbooks) {
    throw new Error("tuxbooks preload bridge is unavailable outside the Electron app");
  }
  return window.tuxbooks;
}

declare global {
  interface Window {
    tuxbooks?: TuxbooksApi;
  }
}

async function invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  return tuxbooks().invoke(method, params) as Promise<T>;
}

function onEvent<T>(name: string, callback: (payload: T) => void): () => void {
  return tuxbooks().onEvent(name, callback as (payload: unknown) => void);
}

export function getLibraryStats(): Promise<LibraryStats> {
  return invoke("get_library_stats");
}

export function listBooks(): Promise<Book[]> {
  return invoke("list_books");
}

/** Full-text library search (FTS5 over titles, authors, publishers, and more). */
export function searchLibrary(query: string): Promise<SearchHit[]> {
  return invoke("search_books", { query });
}

export function scanLibrary(path: string): Promise<ImportReport> {
  return invoke("scan_library", { path });
}

/**
 * Import a mixed batch of files and/or folders. Folders become watched
 * library locations; plain files are imported in place. Per-path failures
 * come back in the report.
 */
export function importPaths(paths: string[]): Promise<ImportReport> {
  return invoke("import_paths", { paths });
}

/**
 * Subscribe to per-book import progress (the `import-progress` backend
 * event). The callback receives each book as soon as it is persisted, so
 * covers appear while a scan is still running. Resolves an unlisten fn.
 */
export function onImportProgress(callback: (book: Book) => void): Promise<() => void> {
  const unlisten = onEvent<Book>("import-progress", callback);
  return Promise.resolve(unlisten);
}

/**
 * Subscribe to live library synchronization (the `library-changed` backend
 * event). The filesystem watcher and the remove/reconnect methods push every
 * mutation here; see `LibraryChange` in types/domain.
 */
export function onLibraryChanged(callback: (change: LibraryChange) => void): Promise<() => void> {
  const unlisten = onEvent<LibraryChange>("library-changed", callback);
  return Promise.resolve(unlisten);
}

/** Remove a book from the library (source file on disk is never touched). */
export function removeBook(bookId: number): Promise<boolean> {
  return invoke("remove_book", { bookId });
}

/** Curation view of a book: effective metadata, source values, overridden flags. */
export function getBookMetadata(bookId: number): Promise<BookMetadata | null> {
  return invoke("get_book_metadata", { bookId });
}

/**
 * Save the metadata edit form. Only fields that differ from the source file
 * become overrides — source files are never rewritten.
 */
export function updateBookMetadata(bookId: number, form: MetadataFields): Promise<BookMetadata> {
  return invoke("update_book_metadata", { bookId, form });
}

/** Drop every override; the book returns to its source-file metadata. */
export function resetBookMetadata(bookId: number): Promise<BookMetadata> {
  return invoke("reset_book_metadata", { bookId });
}

/** Replace the cover with a user-picked image (copied into the artwork cache). */
export function setBookCover(bookId: number, imagePath: string): Promise<Book> {
  return invoke("set_book_cover", { bookId, imagePath });
}

/** Remove a cover override; the extracted (source) cover returns. */
export function clearBookCoverOverride(bookId: number): Promise<Book> {
  return invoke("clear_book_cover_override", { bookId });
}

/** Native image picker for cover overrides; null when cancelled. */
export function pickCoverImage(): Promise<string | null> {
  return tuxbooks().pickCoverImage();
}

/** Reconnect an unavailable book to a newly located file, keeping its identity. */
export function reconnectBook(bookId: number, path: string): Promise<Book> {
  return invoke("reconnect_book", { bookId, path });
}

/**
 * Raw bytes of a stored book's source file, fetched over the `tuxbooks://`
 * protocol (range-capable; used whole here). Consumers wrap them in a Blob
 * for the reader engines.
 */
export function getBookBytes(bookId: number, format: BookFormat): Promise<ArrayBuffer> {
  return tuxbooks().fetchBookBytes(bookId, format);
}

/** Load the stored reading position for a book, if any. */
export function getReadingProgress(bookId: number): Promise<ReadingProgressRecord | null> {
  return invoke("get_reading_progress", { bookId });
}

/** Persist (upsert) where the user stopped reading a book. */
export function saveReadingProgress(bookId: number, progress: ReadingProgressInput): Promise<null> {
  return invoke("save_reading_progress", { bookId, progress });
}

/** Flag a book as finished (progress 100) without moving its saved position. */
export function markBookFinished(bookId: number): Promise<null> {
  return invoke("mark_book_finished", { bookId });
}

/** Every collection with its member book ids, in name order. */
export function listCollections(): Promise<CollectionSummary[]> {
  return invoke("list_collections");
}

/** Create a named collection; rejects blank or duplicate names. */
export function createCollection(name: string): Promise<CollectionSummary> {
  return invoke("create_collection", { name });
}

/** Delete a collection; member books are never touched. */
export function deleteCollection(collectionId: number): Promise<boolean> {
  return invoke("delete_collection", { collectionId });
}

/** Add a book to a collection (idempotent). */
export function addBookToCollection(bookId: number, collectionId: number): Promise<null> {
  return invoke("add_book_to_collection", { bookId, collectionId });
}

/** Remove a book from a collection; true when a membership was deleted. */
export function removeBookFromCollection(bookId: number, collectionId: number): Promise<boolean> {
  return invoke("remove_book_from_collection", { bookId, collectionId });
}

/** Every annotation of one book (bookmarks + highlights), in document order. */
export function listAnnotations(bookId: number): Promise<Annotation[]> {
  return invoke("list_annotations", { bookId });
}

/** Creates a bookmark or highlight and returns the stored row. */
export function createAnnotation(bookId: number, annotation: AnnotationInput): Promise<Annotation> {
  return invoke("create_annotation", { bookId, annotation });
}

/**
 * Updates an annotation's color and/or note. `note` replaces the stored
 * note (empty string clears, null keeps); resolves null for unknown ids.
 */
export function updateAnnotation(id: number, patch: AnnotationPatch): Promise<Annotation | null> {
  return invoke("update_annotation", { id, patch });
}

/** Deletes an annotation; true when a row was removed. */
export function deleteAnnotation(id: number): Promise<boolean> {
  return invoke("delete_annotation", { id });
}

/** Native folder picker; resolves to null when the user cancels. */
export function pickDirectory(): Promise<string | null> {
  return tuxbooks().pickDirectory();
}

/** Native file picker for relocating a missing book; null when cancelled. */
export function pickBookFile(): Promise<string | null> {
  return tuxbooks().pickBookFile();
}

/** Native multi-file picker for Import Files…; empty when cancelled. */
export function pickBookFiles(): Promise<string[]> {
  return tuxbooks().pickBookFiles();
}

/** Reveal a file in the system file manager (does not open it). */
export function revealInFileManager(path: string): Promise<void> {
  return tuxbooks().revealInFileManager(path);
}

/** Absolute filesystem path of a dropped File (sandboxed preload helper). */
export function pathForFile(file: File): string {
  return tuxbooks().pathForFile(file);
}

/** `tuxbooks://cover/<encoded path>` for an extracted cover image on disk. */
export function coverFileUrl(coverPath: string): string {
  return `tuxbooks://cover/${encodeURIComponent(coverPath)}`;
}
