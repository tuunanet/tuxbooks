import type { StorageReport, SyncDiagnostics } from "@/lib/bridge";

/**
 * Storage report and diagnostics payloads for the Application Data tab tests.
 */

export const DATA_PATH = "/home/u/.local/share/com.tuxbooks.app";
export const CONFIG_PATH = "/home/u/.config/TuxBooks";

export const REPORT: StorageReport = {
  roots: [
    {
      id: "app-data",
      label: "App data",
      path: DATA_PATH,
      sizeBytes: 5 * 1024 * 1024,
      entries: [
        {
          id: "catalog",
          label: "Catalog database",
          path: `${DATA_PATH}/tuxbooks.db`,
          sizeBytes: 3 * 1024 * 1024,
          kind: "only-copy",
        },
        {
          id: "covers",
          label: "Cover cache",
          path: `${DATA_PATH}/covers`,
          sizeBytes: 2 * 1024 * 1024,
          kind: "only-copy",
        },
      ],
    },
    {
      id: "app-config",
      label: "App settings and caches",
      path: CONFIG_PATH,
      sizeBytes: 1 * 1024 * 1024,
      entries: [
        {
          id: "browser-caches",
          label: "Browser caches",
          path: CONFIG_PATH,
          sizeBytes: 1 * 1024 * 1024,
          kind: "derived",
        },
      ],
    },
  ],
  appDataBytes: 6 * 1024 * 1024,
  cacheBytes: 3 * 1024 * 1024,
  bookLocations: [
    {
      id: 1,
      path: "/home/u/Books",
      addedAt: "2026-01-01T00:00:00.000Z",
      bookCount: 12,
      totalBytes: 24 * 1024 * 1024,
      missingFromDisk: false,
      status: "idle",
    },
  ],
  bookTotalBytes: 24 * 1024 * 1024,
  catalog: { books: 12, authors: 8, collections: 3, annotations: 5, readingProgress: 7 },
};

export const DIAGNOSTICS: SyncDiagnostics = {
  generatedAt: "2026-10-31T10:00:00.000Z",
  sync: {
    enabled: true,
    state: "idle",
    folder: "/home/u/Dropbox/TuxBooks",
    lastSyncAt: "2026-10-31T09:59:00.000Z",
    lastError: null,
    autoRetry: true,
    counts: {
      pendingLocal: 2,
      waitingBooks: 1,
      issues: 1,
      trash: 0,
      conflicts: 1,
    },
  },
  issues: [
    {
      kind: "cover_missing",
      detail: "cover publish failed (auto-retry 1/5)",
      fileName: "ops/abc/cover.json",
      autoAttempts: 1,
      nextAutoRetryAt: "2026-10-31T10:59:00.000Z",
      createdAt: "2026-10-31T09:58:00.000Z",
    },
  ],
  hashFailed: [
    {
      bookId: 42,
      title: "Example",
      path: "/home/u/Books/example.epub",
      attempts: 2,
      retryAt: "2026-10-31T11:00:00.000Z",
    },
  ],
  openConflicts: [
    {
      id: 7,
      kind: "annotation",
      field: "note",
      bookTitle: "Example",
      createdAt: "2026-10-31T09:00:00.000Z",
    },
  ],
  recentMerges: {
    books: [{ loser: "a".repeat(32), winner: "b".repeat(32) }],
    entities: [{ kind: "collection", loser: "c".repeat(32), winner: "d".repeat(32) }],
  },
  versions: { libraryMarker: 1, opSchema: 1, dbMigration: 28 },
};
