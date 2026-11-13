/**
 * The renderer's only window.tuxbooks consumer (docs/ARCHITECTURE.md); every
 * sidecar call, picker, and protocol URL goes through these typed wrappers.
 */

import type {
  Annotation,
  AnnotationInput,
  AnnotationPatch,
  Book,
  BookFile,
  BookFormat,
  BookMetadata,
  BookTrashEntry,
  BulkForgetOutcome,
  CollectionSummary,
  EditionBook,
  EditionLinkOutcome,
  ForgetOutcome,
  ImportReport,
  IndexingRetry,
  LibraryChange,
  LibraryStats,
  MetadataFields,
  ReadingHistoryBook,
  ReadingProgressInput,
  ReadingProgressRecord,
  RestoreMode,
  RestoreOutcome,
  SearchHit,
} from "@/types/domain";
import { MAX_BULK_BOOK_IDS, type StorageRootId } from "../../../electron/shared/pathSchema";
import type { StorageReport } from "../../../electron/shared/storageReport";

import type {
  SyncConnectOptions,
  SyncConnectResult,
  SyncDiagnostics,
  SyncIssue,
  SyncStatus,
  SyncTrashEntry,
  TuxbooksApi,
  UnwatchProgress,
  WaitingBook,
} from "./bridgeTypes";
export type * from "./bridgeTypes";

/** The preload API; missing only when a test or non-Electron host forgot the mock. */
export function tuxbooks(): TuxbooksApi {
  if (!window.tuxbooks) {
    throw new Error("tuxbooks preload bridge is unavailable outside the Electron app");
  }
  return window.tuxbooks;
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

export function listReadingHistory(query?: string): Promise<ReadingHistoryBook[]> {
  return invoke(
    "list_reading_history",
    query === undefined || query.trim() === "" ? {} : { query },
  );
}

export function searchLibrary(query: string): Promise<SearchHit[]> {
  return invoke("search_books", { query });
}

export function scanLibrary(path: string): Promise<ImportReport> {
  return invoke("scan_library", { path });
}

export function importPaths(paths: string[]): Promise<ImportReport> {
  return invoke("import_paths", { paths });
}

/**
 * Leave the watch list: the folders stop syncing and their library memberships go away, while
 * reading progress and annotations stay with the durable book (ADR 0014) and return if the same
 * bytes are imported again. Files on disk are never touched. Returns how many folders were actually
 * listed.
 */
export function unwatchLocations(paths: string[]): Promise<number> {
  return invoke("unwatch_locations", { paths });
}

export function onWatchedFoldersChanged(callback: () => void): Promise<() => void> {
  const unlisten = onEvent<null>("watched-folders-changed", () => callback());
  return Promise.resolve(unlisten);
}

export function onUnwatchProgress(
  callback: (progress: UnwatchProgress) => void,
): Promise<() => void> {
  const unlisten = onEvent<UnwatchProgress>("unwatch-progress", callback);
  return Promise.resolve(unlisten);
}

export function onImportProgress(
  callback: (batch: { books: Book[] }) => void,
): Promise<() => void> {
  const unlisten = onEvent<{ books: Book[] }>("import-progress", callback);
  return Promise.resolve(unlisten);
}

export function onLibraryChanged(callback: (change: LibraryChange) => void): Promise<() => void> {
  const unlisten = onEvent<LibraryChange>("library-changed", callback);
  return Promise.resolve(unlisten);
}

/** Remove a book from the library (source file on disk is never touched). */
export function removeBook(bookId: number): Promise<boolean> {
  return invoke("remove_book", { bookId });
}

export function listBookFiles(bookId: number): Promise<BookFile[]> {
  return invoke("list_book_files", { bookId });
}

export function listBookEditions(bookId: number): Promise<EditionBook[]> {
  return invoke("list_book_editions", { bookId });
}

export function linkBookEdition(
  sourceBookId: number,
  targetBookId: number,
): Promise<EditionLinkOutcome> {
  return invoke("link_book_edition", { sourceBookId, targetBookId });
}

/**
 * Remove one file copy; the durable book and its reading state stay while
 * another copy remains, and the file on disk is never touched.
 */
export function removeBookFile(bookId: number, fileId: number): Promise<boolean> {
  return invoke("remove_book_file", { bookId, fileId });
}

export function resetBookReadingData(bookId: number): Promise<boolean> {
  return invoke("reset_book_reading_data", { bookId });
}

/**
 * Retry the content-hash pass now instead of waiting for its backoff;
 * resolves with the state afterwards, so the caller keeps the warning.
 */
export function retryIndexing(bookId: number): Promise<IndexingRetry> {
  return invoke("retry_indexing", { bookId });
}

export function forgetBook(bookId: number): Promise<ForgetOutcome> {
  return invoke("forget_book", { bookId });
}

/**
 * The main process rejects one forget_books invoke over MAX_BULK_BOOK_IDS ids;
 * a failed chunk rejects and leaves the earlier chunks forgotten.
 */
export async function forgetBooks(bookIds: number[]): Promise<BulkForgetOutcome> {
  if (bookIds.length <= MAX_BULK_BOOK_IDS) {
    return invoke("forget_books", { bookIds });
  }
  const outcome: BulkForgetOutcome = { forgotten: 0, trashIds: [] };
  for (let start = 0; start < bookIds.length; start += MAX_BULK_BOOK_IDS) {
    const chunk = bookIds.slice(start, start + MAX_BULK_BOOK_IDS);
    const part = await invoke<BulkForgetOutcome>("forget_books", { bookIds: chunk });
    outcome.forgotten += part.forgotten;
    outcome.trashIds.push(...part.trashIds);
  }
  return outcome;
}

export function listBookTrash(): Promise<BookTrashEntry[]> {
  return invoke("list_book_trash");
}

/**
 * Restore a Forgotten book. With no mode the backend restores silently when
 * the fresh identity has no new progress, and returns `status: "conflict"`
 * when it does; Replace, Keep, and Merge resolve it.
 */
export function restoreBook(trashId: number, mode?: RestoreMode): Promise<RestoreOutcome> {
  return invoke("restore_book", mode === undefined ? { trashId } : { trashId, mode });
}

export function getBookMetadata(bookId: number): Promise<BookMetadata | null> {
  return invoke("get_book_metadata", { bookId });
}

export function resetBookMetadata(bookId: number): Promise<BookMetadata> {
  return invoke("reset_book_metadata", { bookId });
}

export function setBookCover(bookId: number, imagePath: string): Promise<Book> {
  return invoke("set_book_cover", { bookId, imagePath });
}

export function clearBookCoverOverride(bookId: number): Promise<Book> {
  return invoke("clear_book_cover_override", { bookId });
}

/**
 * Save the given metadata into the library and the book's source EPUB/PDF file (a one-time `.bak`
 * backup is kept). Fields the format cannot store stay as library edits. The file is re-parsed, so
 * storeable fields stop being overrides. Covers are not embedded.
 */
export function embedBookMetadata(bookId: number, form: MetadataFields): Promise<BookMetadata> {
  return invoke("embed_book_metadata", { bookId, form });
}

export function pickCoverImage(): Promise<string | null> {
  return tuxbooks().pickCoverImage();
}

export function reconnectBook(bookId: number, path: string): Promise<Book> {
  return invoke("reconnect_book", { bookId, path });
}

/** The backend rejects bytes that already belong to a different book. */
export function relinkBook(bookId: number, path: string): Promise<Book> {
  return invoke("relink_book", { bookId, path });
}

export function getBookBytes(bookId: number, format: BookFormat): Promise<ArrayBuffer> {
  return tuxbooks().fetchBookBytes(bookId, format);
}

export function getEpubSession(bookId: number): Promise<{ manifest: unknown; positions: unknown }> {
  return invoke("get_epub_session", { bookId });
}

export function getReadingProgress(bookId: number): Promise<ReadingProgressRecord | null> {
  return invoke("get_reading_progress", { bookId });
}

export function saveReadingProgress(bookId: number, progress: ReadingProgressInput): Promise<null> {
  return invoke("save_reading_progress", { bookId, progress });
}

export function markBookFinished(bookId: number): Promise<null> {
  return invoke("mark_book_finished", { bookId });
}

export function markBookOpened(bookId: number): Promise<null> {
  return invoke("mark_book_opened", { bookId });
}

/**
 * Reader-session registry for open-book deferral (ADR 0018 D5): tell the sync engine a book's
 * reader session opened, so file adoption defers while the bytes are on screen, and that it
 * closed, so the next sync pass may adopt again. Best effort; callers swallow failures.
 */
export function readerOpened(bookId: number): Promise<null> {
  return invoke("reader_opened", { bookId });
}

export function readerClosed(bookId: number): Promise<null> {
  return invoke("reader_closed", { bookId });
}

export function listCollections(): Promise<CollectionSummary[]> {
  return invoke("list_collections");
}

export function createCollection(name: string): Promise<CollectionSummary> {
  return invoke("create_collection", { name });
}

export function renameCollection(collectionId: number, name: string): Promise<CollectionSummary> {
  return invoke("rename_collection", { collectionId, name });
}

/** Delete a collection; member books are never touched. */
export function deleteCollection(collectionId: number): Promise<boolean> {
  return invoke("delete_collection", { collectionId });
}

export function addBookToCollection(bookId: number, collectionId: number): Promise<null> {
  return invoke("add_book_to_collection", { bookId, collectionId });
}

export function removeBookFromCollection(bookId: number, collectionId: number): Promise<boolean> {
  return invoke("remove_book_from_collection", { bookId, collectionId });
}

export function listAnnotations(bookId: number): Promise<Annotation[]> {
  return invoke("list_annotations", { bookId });
}

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

export function deleteAnnotation(id: number): Promise<boolean> {
  return invoke("delete_annotation", { id });
}

export function pickDirectory(): Promise<string | null> {
  return tuxbooks().pickDirectory();
}

export function pickSyncFolder(): Promise<string | null> {
  return tuxbooks().pickSyncFolder();
}

export function getSyncStatus(): Promise<SyncStatus> {
  return invoke("sync_status");
}

/** Collect the support snapshot. Runs only when the user asks; never polled. */
export function getSyncDiagnostics(): Promise<SyncDiagnostics> {
  return invoke("sync_diagnostics");
}

/**
 * A `mismatch` result means the folder belongs to another library; call again
 * with `confirmLibraryId` to merge this machine's state into it.
 */
export function connectSync(
  path: string,
  options: SyncConnectOptions = {},
): Promise<SyncConnectResult> {
  return invoke("sync_connect", { path, ...options });
}

export function disconnectSync(): Promise<SyncStatus> {
  return invoke("sync_disconnect");
}

export function syncNow(): Promise<SyncStatus> {
  return invoke("sync_now");
}

export function listWaitingBooks(): Promise<WaitingBook[]> {
  return invoke("list_waiting_books");
}

export function forgetWaitingBook(bookUid: string): Promise<boolean> {
  return invoke("forget_waiting_book", { bookUid });
}

export function forgetAllWaitingBooks(): Promise<number> {
  return invoke("forget_all_waiting_books");
}

/** The sidecar verifies the bytes; a mismatch rejects and leaves the book waiting. */
export function attachWaitingBook(bookUid: string, path: string): Promise<Book> {
  return invoke("attach_waiting_book", { bookUid, path });
}

export function dismissAllSyncIssues(): Promise<number> {
  return invoke("dismiss_all_sync_issues");
}

export function listSyncIssues(): Promise<SyncIssue[]> {
  return invoke("sync_issues");
}

export function dismissSyncIssue(id: number): Promise<boolean> {
  return invoke("sync_dismiss_issue", { id });
}

export function retrySyncIssue(id: number): Promise<boolean> {
  return invoke("sync_retry_issue", { id });
}

export function listSyncTrash(): Promise<SyncTrashEntry[]> {
  return invoke("sync_trash");
}

export function restoreSyncTrash(id: number): Promise<boolean> {
  return invoke("sync_restore", { id });
}

export function setSyncDeviceName(name: string): Promise<SyncStatus> {
  return invoke("sync_set_device_name", { name });
}

/**
 * The auto-retry kill switch (ADR 0017 D4): default-on, persisted in the
 * library database. Returns the refreshed status so callers adopt the
 * stored value.
 */
export function setSyncAutoRetry(enabled: boolean): Promise<SyncStatus> {
  return invoke("sync_set_auto_retry", { enabled });
}

export function onSyncStatus(callback: (status: SyncStatus) => void): Promise<() => void> {
  const unlisten = onEvent<SyncStatus>("sync-status", callback);
  return Promise.resolve(unlisten);
}

export function onSyncApplied(
  callback: (payload: { bookIds: number[] }) => void,
): Promise<() => void> {
  const unlisten = onEvent<{ bookIds: number[] }>("sync-applied", callback);
  return Promise.resolve(unlisten);
}

export function pickBookFile(): Promise<string | null> {
  return tuxbooks().pickBookFile();
}

export function pickBookFiles(): Promise<string[]> {
  return tuxbooks().pickBookFiles();
}

export function revealBook(bookId: number): Promise<void> {
  return tuxbooks().revealBook(bookId);
}

export function getStorageReport(): Promise<StorageReport> {
  return tuxbooks().storageReport();
}

export function openDataFolder(rootId: StorageRootId): Promise<void> {
  return tuxbooks().openDataFolder(rootId);
}

export function openLibraryLocation(locationId: number): Promise<void> {
  return tuxbooks().openLibraryLocation(locationId);
}

/** Open the connected cloud-sync folder; the renderer passes no path. */
export function openSyncFolder(): Promise<void> {
  return tuxbooks().openSyncFolder();
}

export function copyDataPath(rootId: StorageRootId): Promise<void> {
  return tuxbooks().copyDataPath(rootId);
}

export function copyLibraryLocationPath(locationId: number): Promise<void> {
  return tuxbooks().copyLibraryLocationPath(locationId);
}

/**
 * Copy renderer-formatted text through main: the permission policy (X-4)
 * denies the renderer's own `navigator.clipboard` write.
 */
export function copyText(text: string): Promise<void> {
  return tuxbooks().copyText(text);
}

/** Clear the caches the app rebuilds by itself (browser caches and the GPU
 * fallback marker); resolves the bytes freed. */
export function clearCache(): Promise<number> {
  return tuxbooks().clearCache();
}

export function pathForFile(file: File): string {
  return tuxbooks().pathForFile(file);
}

/**
 * `tuxbooks://cover/<name>`: only the cover's file name crosses the protocol
 * boundary, so the stored absolute path never round-trips (issue #84 T-1).
 */
export function coverFileUrl(coverPath: string): string {
  const lastSeparator = Math.max(coverPath.lastIndexOf("/"), coverPath.lastIndexOf("\\"));
  return `tuxbooks://cover/${encodeURIComponent(coverPath.slice(lastSeparator + 1))}`;
}
