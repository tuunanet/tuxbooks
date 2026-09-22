import type { StorageRootId } from "./pathSchema";

/**
 * The storage read model (data-management spec): what TuxBooks keeps on disk
 * and how large each item is. Main resolves paths by stable id and builds
 * this report; the renderer only displays it and names rows by id. Later
 * tickets fill the book locations and catalog counts.
 */

export type StorageEntryKind = "derived" | "only-copy" | "settings" | "books";

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
  path: string;
  addedAt: string;
  bookCount: number;
  totalBytes: number;
}

export interface StorageReport {
  roots: StorageRoot[];
  /** Total bytes across every app-owned root (data root plus config root). */
  appDataBytes: number;
  /** Browser caches plus the GPU fallback marker: the app regenerates these. */
  cacheBytes: number;
  bookLocations: LibraryLocationStat[];
  bookTotalBytes: number;
  catalog: {
    books: number;
    authors: number;
    collections: number;
    annotations: number;
    readingProgress: number;
  };
}
