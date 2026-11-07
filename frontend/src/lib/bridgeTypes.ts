/**
 * Bridge wire types: the shapes the preload bridge carries, plus the type
 * re-exports the rest of the renderer imports from `@/lib/bridge`. Types
 * only — no runtime, so this module never touches the outside world
 * (docs/ARCHITECTURE.md keeps that in `bridge.ts`).
 */

import type { StorageReport } from "../../../electron/shared/storageReport";
import type { StorageRootId } from "../../../electron/shared/pathSchema";

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
  copyText(text: string): Promise<void>;
  clearCache(): Promise<number>;
  fetchBookBytes(bookId: number, format: string): Promise<ArrayBuffer>;
  pathForFile(file: File): string;
}
