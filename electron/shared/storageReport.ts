import type { StorageRootId } from "./pathSchema";

/**
 * The storage read model (data-management spec): what TuxBooks keeps on disk
 * and how large each item is. Main resolves paths by stable id and builds
 * this report; the renderer only displays it and names rows by id.
 */

export type StorageEntryKind = "derived" | "only-copy" | "settings";

export interface StorageEntry {
  id: string;
  label: string;
  path: string;
  sizeBytes: number;
  kind: StorageEntryKind;
}

export interface StorageRoot {
  id: StorageRootId;
  label: string;
  path: string;
  sizeBytes: number;
  entries: StorageEntry[];
}

export interface LibraryLocationStat {
  /** The `library_locations.id`; the renderer opens a location by this id. */
  id: number;
  path: string;
  addedAt: string;
  bookCount: number;
  totalBytes: number;
}

export interface CatalogCounts {
  books: number;
  authors: number;
  collections: number;
  annotations: number;
  readingProgress: number;
}

/**
 * The sidecar's storage aggregate (`get_storage_stats`): book stats per
 * watched location, the library's total book bytes, and the catalog counts.
 * Main folds it into the report; the renderer only ever reads the report.
 */
export interface LibraryStorageStats {
  locations: LibraryLocationStat[];
  bookTotalBytes: number;
  catalog: CatalogCounts;
}

export interface StorageReport {
  roots: StorageRoot[];
  /** Total bytes across every app-owned root (data root plus config root). */
  appDataBytes: number;
  /** Browser caches plus the GPU fallback marker: the app regenerates these. */
  cacheBytes: number;
  bookLocations: LibraryLocationStat[];
  bookTotalBytes: number;
  catalog: CatalogCounts;
}
