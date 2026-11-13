import { describe, expect, it } from "vite-plus/test";

import * as bridge from "@/lib/bridge";

/**
 * Characterization pin for the `@/lib/bridge` value export surface. Typecheck
 * already catches a dropped export for 80 of these 83 wrappers, which other
 * files reference through this module. What the pin adds: the three exports
 * nothing references (getBookBytes, scanLibrary, tuxbooks), and drift in the
 * other direction, an export added here fails the suite even when nothing
 * imports it. Type-only re-exports ride `export type *` and are left to
 * typecheck.
 */
const EXPORT_SURFACE = [
  "addBookToCollection",
  "attachWaitingBook",
  "clearBookCoverOverride",
  "clearCache",
  "connectSync",
  "copyDataPath",
  "copyLibraryLocationPath",
  "copyText",
  "coverFileUrl",
  "createAnnotation",
  "createCollection",
  "deleteAnnotation",
  "deleteCollection",
  "disconnectSync",
  "dismissAllSyncIssues",
  "dismissSyncIssue",
  "embedBookMetadata",
  "forgetAllWaitingBooks",
  "forgetBook",
  "forgetBooks",
  "forgetWaitingBook",
  "getBookBytes",
  "getBookMetadata",
  "getEpubSession",
  "getLibraryStats",
  "getReadingProgress",
  "getStorageReport",
  "getSyncDiagnostics",
  "getSyncStatus",
  "importPaths",
  "linkBookEdition",
  "listAnnotations",
  "listBookEditions",
  "listBookFiles",
  "listBookTrash",
  "listBooks",
  "listCollections",
  "listReadingHistory",
  "listSyncIssues",
  "listSyncTrash",
  "listWaitingBooks",
  "markBookFinished",
  "markBookOpened",
  "onImportProgress",
  "onLibraryChanged",
  "onSyncApplied",
  "onSyncStatus",
  "onUnwatchProgress",
  "onWatchedFoldersChanged",
  "openDataFolder",
  "openLibraryLocation",
  "openSyncFolder",
  "pathForFile",
  "pickBookFile",
  "pickBookFiles",
  "pickCoverImage",
  "pickDirectory",
  "pickSyncFolder",
  "readerClosed",
  "readerOpened",
  "reconnectBook",
  "relinkBook",
  "removeBook",
  "removeBookFile",
  "removeBookFromCollection",
  "renameCollection",
  "resetBookMetadata",
  "resetBookReadingData",
  "restoreBook",
  "restoreSyncTrash",
  "retryIndexing",
  "retrySyncIssue",
  "revealBook",
  "saveReadingProgress",
  "scanLibrary",
  "searchLibrary",
  "setBookCover",
  "setSyncAutoRetry",
  "setSyncDeviceName",
  "syncNow",
  "tuxbooks",
  "unwatchLocations",
  "updateAnnotation",
];

describe("@/lib/bridge export surface", () => {
  it("exports exactly the pinned wrapper set", () => {
    expect(Object.keys(bridge).sort()).toEqual(EXPORT_SURFACE);
  });
});
