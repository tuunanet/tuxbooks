/**
 * The renderer's only window.tuxbooks consumer (docs/ARCHITECTURE.md). Every
 * call to the Rust service, native picker, or protocol URL goes through the
 * typed wrappers here; components never touch the preload API directly.
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
import type { StorageRootId } from "../../../electron/shared/pathSchema";
import type { StorageReport } from "../../../electron/shared/storageReport";

export type {
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
  RestoreConflict,
  RestoreMode,
  RestoreOutcome,
} from "@/types/domain";
export type { StorageRootId } from "../../../electron/shared/pathSchema";
export type {
  LibraryLocationStat,
  LibraryLocationStatus,
  StorageEntry,
  StorageEntryKind,
  StorageReport,
  StorageRoot,
} from "../../../electron/shared/storageReport";

export type SyncState = "disabled" | "idle" | "syncing" | "error";

/** Snapshot of the cloud-folder sync engine (docs/SYNC.md). */
export interface SyncStatus {
  enabled: boolean;
  folder: string | null;
  libraryId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  state: SyncState;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingLocal: number;
  waitingBooks: number;
  issues: number;
  trash: number;
  conflicts: number;
}

export interface SyncIssue {
  id: number;
  kind: string;
  detail: string;
  fileName: string | null;
  action: SyncIssueAction;
  target: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The user-initiated support snapshot from `sync_diagnostics`. It carries no
 * book contents, annotation text, or conflict values (docs/SYNC.md, "Copy
 * diagnostics").
 */
export interface SyncDiagnostics {
  generatedAt: string;
  sync: {
    enabled: boolean;
    state: SyncState;
    folder: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
    counts: {
      pendingLocal: number;
      waitingBooks: number;
      issues: number;
      trash: number;
      conflicts: number;
    };
  };
  hashFailed: Array<{
    bookId: number;
    title: string;
    path: string;
    attempts: number;
    retryAt: string | null;
  }>;
  openConflicts: Array<{
    id: number;
    kind: string;
    field: string;
    bookTitle: string | null;
    createdAt: string;
  }>;
  recentMerges: {
    books: Array<{ loser: string; winner: string }>;
    entities: Array<{ kind: string; loser: string; winner: string }>;
  };
  versions: {
    libraryMarker: number | null;
    opSchema: number;
    dbMigration: number;
  };
}

/** What the Sync issues row offers; computed by the sidecar from the kind. */
export type SyncIssueAction = "retry" | "open_folder" | "copy_details" | "dismiss";

export interface SyncTrashEntry {
  id: number;
  kind: string;
  label: string;
  deletedAt: string;
  expiresAt: string;
}

/** One losing value the merge kept, waiting for a keep/apply choice. */
export interface SyncConflict {
  id: number;
  kind: string;
  entityUid: string;
  bookUid: string | null;
  bookTitle: string | null;
  bookAuthor: string | null;
  field: string;
  /** Readable name for `__entity__`, `__deleted__`, and `__restore__`. */
  fieldLabel: string | null;
  winner: unknown;
  loser: unknown;
  winnerDeviceId: string;
  winnerDeviceName: string;
  winnerWall: number;
  winnerCounter: number;
  loserDeviceId: string;
  loserDeviceName: string;
  loserWall: number;
  loserCounter: number;
  createdAt: string;
  canApplyLoser: boolean;
  applyLoserBlockedReason: string | null;
}

export type SyncConflictResolution = "keep_winner" | "apply_loser";

export interface SyncMismatch {
  localLibraryId: string;
  remoteLibraryId: string;
}

export interface SyncConnectResult {
  status: SyncStatus;
  mismatch: SyncMismatch | null;
  /** Set when starting a new library moved the previous one aside. */
  archivedLibraryPath: string | null;
}

export interface SyncConnectOptions {
  deviceName?: string;
  confirmLibraryId?: string;
  startNew?: boolean;
}

/** Mirror state for a book whose file is not present on this machine. */
export interface WaitingBook {
  bookUid: string;
  title: string | null;
  author: string | null;
  progressPercent: number | null;
  annotationCount: number;
  lastOpenedAt: string | null;
  sampleAnnotation: string | null;
}

/** Shape of the sandboxed preload bridge (`electron/preload/preload.ts`). */
export interface TuxbooksApi {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(name: string, callback: (payload: unknown) => void): () => void;
  pickDirectory(): Promise<string | null>;
  pickSyncFolder(): Promise<string | null>;
  pickBookFile(): Promise<string | null>;
  pickBookFiles(): Promise<string[]>;
  pickCoverImage(): Promise<string | null>;
  revealBook(bookId: number): Promise<void>;
  storageReport(): Promise<StorageReport>;
  openDataFolder(rootId: StorageRootId): Promise<void>;
  openLibraryLocation(locationId: number): Promise<void>;
  openSyncFolder(): Promise<void>;
  copyDataPath(rootId: StorageRootId): Promise<void>;
  copyLibraryLocationPath(locationId: number): Promise<void>;
  clearCache(): Promise<number>;
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

/**
 * Reading history: durable books with no file rows, newest activity first.
 * An optional query searches the same FTS index with the opposite membership
 * filter, so library books never appear here.
 */
export function listReadingHistory(query?: string): Promise<ReadingHistoryBook[]> {
  return invoke(
    "list_reading_history",
    query === undefined || query.trim() === "" ? {} : { query },
  );
}

/** Full-text library search (FTS5 over titles, authors, publishers, and more). */
export function searchLibrary(query: string): Promise<SearchHit[]> {
  return invoke("search_books", { query });
}

export function scanLibrary(path: string): Promise<ImportReport> {
  return invoke("scan_library", { path });
}

/**
 * Import a mixed batch of files and/or folders. Both end up watched: a
 * folder is registered as a library location, and a plain file adopts its
 * parent folder the same way. The report lists every folder the run newly
 * watched; per-path failures come back in the report too.
 */
export function importPaths(paths: string[]): Promise<ImportReport> {
  return invoke("import_paths", { paths });
}

/**
 * Leave the watch list: the folders stop syncing and their library
 * memberships go away, while reading progress and annotations stay with the
 * durable book (ADR 0014) and return if the same bytes are imported again.
 * Files on disk are never touched. Returns how many folders were actually
 * listed.
 */
export function unwatchLocations(paths: string[]): Promise<number> {
  return invoke("unwatch_locations", { paths });
}

/** How many of an unwatch's promised books have left the catalog so far. */
export interface UnwatchProgress {
  removed: number;
  total: number;
}

/**
 * Subscribe to watched-folder changes (a folder registered, collapsed into a
 * parent, or removed). The settings view reloads its folder list so a folder
 * appears while its import is still running, not only after it finishes.
 */
export function onWatchedFoldersChanged(callback: () => void): Promise<() => void> {
  const unlisten = onEvent<null>("watched-folders-changed", () => callback());
  return Promise.resolve(unlisten);
}

/**
 * Subscribe to unwatch progress (the `unwatch-progress` backend event). The
 * sidecar batches counts while it purges the removed folders' books, so the
 * dialog can show a bar instead of looking frozen. Resolves an unlisten fn.
 */
export function onUnwatchProgress(
  callback: (progress: UnwatchProgress) => void,
): Promise<() => void> {
  const unlisten = onEvent<UnwatchProgress>("unwatch-progress", callback);
  return Promise.resolve(unlisten);
}

/**
 * Subscribe to import progress (the `import-progress` backend event). The
 * sidecar batches persisted books and emits them as arrays — the callback
 * receives each batch as it lands, so covers appear while a scan is still
 * running without one IPC event per book. Resolves an unlisten fn.
 */
export function onImportProgress(
  callback: (batch: { books: Book[] }) => void,
): Promise<() => void> {
  const unlisten = onEvent<{ books: Book[] }>("import-progress", callback);
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

/** Every file location of one durable book, in active-file order. */
export function listBookFiles(bookId: number): Promise<BookFile[]> {
  return invoke("list_book_files", { bookId });
}

/**
 * Every durable book the user confirmed as another edition of this one.
 * Linked editions keep separate identities and annotations.
 */
export function listBookEditions(bookId: number): Promise<EditionBook[]> {
  return invoke("list_book_editions", { bookId });
}

/**
 * Confirm that two durable books are editions of one work. The books stay
 * separate; the source percentage is copied without a locator, provider
 * links and status move to the current (target) edition, and annotations
 * stay with the source.
 */
export function linkBookEdition(
  sourceBookId: number,
  targetBookId: number,
): Promise<EditionLinkOutcome> {
  return invoke("link_book_edition", { sourceBookId, targetBookId });
}

/**
 * Remove one file copy from a book. The durable book and its reading state
 * stay while another copy remains; the file on disk is never touched.
 */
export function removeBookFile(bookId: number, fileId: number): Promise<boolean> {
  return invoke("remove_book_file", { bookId, fileId });
}

/**
 * Reset reading data for one book: clear progress, annotations, collection
 * membership, metadata overrides, and provider links, but keep the durable
 * identity and the current file. The book stays in the library as unread.
 */
export function resetBookReadingData(bookId: number): Promise<boolean> {
  return invoke("reset_book_reading_data", { bookId });
}

/**
 * Retry the content-hash pass for one book now instead of waiting for its
 * automatic backoff. Resolves with the state afterwards, so the caller keeps
 * the warning when the file is still unreadable.
 */
export function retryIndexing(bookId: number): Promise<IndexingRetry> {
  return invoke("retry_indexing", { bookId });
}

/**
 * Forget one book: move its identity and state to the 30-day trash. When the
 * book has a file, the library entry stays and is rebound to a fresh identity.
 */
export function forgetBook(bookId: number): Promise<ForgetOutcome> {
  return invoke("forget_book", { bookId });
}

/** Bulk Forget for Reading history. */
export function forgetBooks(bookIds: number[]): Promise<BulkForgetOutcome> {
  return invoke("forget_books", { bookIds });
}

/** Forgotten books still restorable inside the 30-day window. */
export function listBookTrash(): Promise<BookTrashEntry[]> {
  return invoke("list_book_trash");
}

/**
 * Restore a Forgotten book. With no mode, the backend restores silently when
 * the fresh identity has no new progress or annotations and returns
 * `status: "conflict"` when it does. Replace, Keep, and Merge resolve it.
 */
export function restoreBook(trashId: number, mode?: RestoreMode): Promise<RestoreOutcome> {
  return invoke("restore_book", mode === undefined ? { trashId } : { trashId, mode });
}

/** Curation view of a book: effective metadata, source values, overridden flags. */
export function getBookMetadata(bookId: number): Promise<BookMetadata | null> {
  return invoke("get_book_metadata", { bookId });
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

/**
 * Save the given metadata into the library and the book's source EPUB/PDF
 * file (a one-time `.bak` backup is kept). Fields the format cannot store
 * stay as library edits. The file is re-parsed, so storeable fields stop
 * being overrides. Covers are not embedded.
 */
export function embedBookMetadata(bookId: number, form: MetadataFields): Promise<BookMetadata> {
  return invoke("embed_book_metadata", { bookId, form });
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
 * Attach a picked file to a Reading-history book. The durable book returns to
 * the library with its progress, annotations, collections, metadata overrides,
 * and last-opened intact; the backend rejects bytes that already belong to a
 * different book.
 */
export function relinkBook(bookId: number, path: string): Promise<Book> {
  return invoke("relink_book", { bookId, path });
}

/**
 * Raw bytes of a stored book's source file, fetched over the `tuxbooks://`
 * protocol (range-capable; used whole here). Consumers wrap them in a Blob
 * for the reader engines.
 */
export function getBookBytes(bookId: number, format: BookFormat): Promise<ArrayBuffer> {
  return tuxbooks().fetchBookBytes(bookId, format);
}

/**
 * The Readium reading session for a stored EPUB, parsed server-side: the
 * webpub manifest and the positions list, both already deserialized JSON.
 * The navigator's document/image resources load over `tuxbooks://` per
 * resource afterwards.
 */
export function getEpubSession(bookId: number): Promise<{ manifest: unknown; positions: unknown }> {
  return invoke("get_epub_session", { bookId });
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

/** Record that a reading session started (the book detail's "Last opened"). */
export function markBookOpened(bookId: number): Promise<null> {
  return invoke("mark_book_opened", { bookId });
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

/** Native picker for the sync folder: local, network, or cloud-synced. */
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
 * Connect a sync folder. A `mismatch` result is expected when the folder
 * belongs to another library; call again with `confirmLibraryId` to merge this
 * machine's state into it.
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

/** Attach a waiting book to the file the user located. The sidecar verifies
 * the bytes; a mismatch rejects and leaves the book waiting. */
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

/** Run the retry path behind an actionable issue; resolves when the row closed. */
export function retrySyncIssue(id: number): Promise<boolean> {
  return invoke("sync_retry_issue", { id });
}

export function listSyncTrash(): Promise<SyncTrashEntry[]> {
  return invoke("sync_trash");
}

export function restoreSyncTrash(id: number): Promise<boolean> {
  return invoke("sync_restore", { id });
}

export function listSyncConflicts(): Promise<SyncConflict[]> {
  return invoke("sync_conflicts");
}

/** `apply_loser` republishes the losing value; every device converges on it. */
export function resolveSyncConflict(
  id: number,
  resolution: SyncConflictResolution,
): Promise<boolean> {
  return invoke("sync_resolve_conflict", { id, resolution });
}

export function setSyncDeviceName(name: string): Promise<SyncStatus> {
  return invoke("sync_set_device_name", { name });
}

/** Live status updates from the engine (the `sync-status` event). */
export function onSyncStatus(callback: (status: SyncStatus) => void): Promise<() => void> {
  const unlisten = onEvent<SyncStatus>("sync-status", callback);
  return Promise.resolve(unlisten);
}

/** Books whose annotations/progress changed in another app instance. */
export function onSyncApplied(
  callback: (payload: { bookIds: number[] }) => void,
): Promise<() => void> {
  const unlisten = onEvent<{ bookIds: number[] }>("sync-applied", callback);
  return Promise.resolve(unlisten);
}

/** Native file picker for relocating a missing book; null when cancelled. */
export function pickBookFile(): Promise<string | null> {
  return tuxbooks().pickBookFile();
}

/** Native multi-file picker for Import Files…; empty when cancelled. */
export function pickBookFiles(): Promise<string[]> {
  return tuxbooks().pickBookFiles();
}

/** Reveal a stored book's file in the system file manager (by book id). */
export function revealBook(bookId: number): Promise<void> {
  return tuxbooks().revealBook(bookId);
}

/** App-owned storage report: the data and config roots with their sizes. */
export function getStorageReport(): Promise<StorageReport> {
  return tuxbooks().storageReport();
}

/** Open one app-owned storage root in the system file manager (by root id). */
export function openDataFolder(rootId: StorageRootId): Promise<void> {
  return tuxbooks().openDataFolder(rootId);
}

/** Open one watched library location in the system file manager (by id). */
export function openLibraryLocation(locationId: number): Promise<void> {
  return tuxbooks().openLibraryLocation(locationId);
}

/** Open the connected cloud-sync folder; the renderer passes no path. */
export function openSyncFolder(): Promise<void> {
  return tuxbooks().openSyncFolder();
}

/** Copy one app-owned storage root's path to the native clipboard (by root id). */
export function copyDataPath(rootId: StorageRootId): Promise<void> {
  return tuxbooks().copyDataPath(rootId);
}

/** Copy one watched library location's path to the native clipboard (by id). */
export function copyLibraryLocationPath(locationId: number): Promise<void> {
  return tuxbooks().copyLibraryLocationPath(locationId);
}

/**
 * Clear the caches the app rebuilds by itself (browser caches and the GPU
 * fallback marker); resolves the bytes freed.
 */
export function clearCache(): Promise<number> {
  return tuxbooks().clearCache();
}

/** Absolute filesystem path of a dropped File (sandboxed preload helper). */
export function pathForFile(file: File): string {
  return tuxbooks().pathForFile(file);
}

/**
 * `tuxbooks://cover/<name>` for an extracted cover image. Only the cover's
 * file name crosses the protocol boundary; main resolves it inside the
 * artwork cache, so the stored absolute path never round-trips through the
 * renderer (issue #84 T-1).
 */
export function coverFileUrl(coverPath: string): string {
  const lastSeparator = Math.max(coverPath.lastIndexOf("/"), coverPath.lastIndexOf("\\"));
  return `tuxbooks://cover/${encodeURIComponent(coverPath.slice(lastSeparator + 1))}`;
}
