import fs from "node:fs";
import path from "node:path";

import type {
  LibraryStorageStats,
  StorageEntry,
  StorageReport,
  StorageRoot,
} from "../shared/storageReport";
import { GPU_FALLBACK_MARKER } from "./gpuFallback";

/**
 * Sizes the app-owned storage roots (data-management spec): the data root
 * (catalog database with its WAL and shared-memory sidecars, cover cache, GPU
 * fallback marker) and the Electron config root (browser caches plus
 * settings). The watched book locations and catalog counts come from the
 * sidecar (`get_storage_stats`); main folds them into the same report. Pure
 * node:fs/path for the sizing so it unit-tests against a temp directory
 * without Electron; main resolves the two paths and this module never
 * guesses one.
 */

/** Cap on files and directories one sizing walk may visit. */
const MAX_WALK_ENTRIES = 100_000;

export const CATALOG_DB_FILENAME = "tuxbooks.db";
export const COVERS_DIRNAME = "covers";

/**
 * Chromium cache directories kept under the Electron config root. Sizing is
 * best effort: a directory the running app does not have contributes zero.
 */
export const BROWSER_CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
] as const;

export interface StorageDirs {
  /** Resolved data root (docs: main's appDataDir resolver). */
  dataDir: string;
  /** Runtime Electron config root: app.getPath("userData"). */
  configDir: string;
}

/** Size of one file in bytes; 0 when missing, a directory, or unreadable. */
function fileBytes(filePath: string): number {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Sum the bytes under a directory with a bounded, iterative walk. Symlinks
 * are never followed (lstat, then skip), so a link cannot escape the tree or
 * loop the walk; unreadable entries are skipped.
 */
export function directoryBytes(root: string): number {
  let total = 0;
  let visited = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch {
      total += fileBytes(current);
      continue;
    }
    for (const name of names) {
      if (visited >= MAX_WALK_ENTRIES) return total;
      visited += 1;
      const full = path.join(current, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        total += stat.size;
      }
    }
  }
  return total;
}

/** Catalog database bytes: the database file plus its WAL and shm sidecars. */
function catalogBytes(dataDir: string): number {
  const database = path.join(dataDir, CATALOG_DB_FILENAME);
  return fileBytes(database) + fileBytes(`${database}-wal`) + fileBytes(`${database}-shm`);
}

function browserCacheBytes(configDir: string): number {
  return BROWSER_CACHE_DIRS.reduce(
    (total, name) => total + directoryBytes(path.join(configDir, name)),
    0,
  );
}

/** Build the storage report from the two resolved roots and the sidecar stats. */
export function buildStorageReport(dirs: StorageDirs, library: LibraryStorageStats): StorageReport {
  const dataRootBytes = directoryBytes(dirs.dataDir);
  const configRootBytes = directoryBytes(dirs.configDir);
  const cacheDirsBytes = browserCacheBytes(dirs.configDir);
  const gpuMarkerBytes = fileBytes(path.join(dirs.dataDir, GPU_FALLBACK_MARKER));

  const dataEntries: StorageEntry[] = [
    {
      id: "catalog",
      label: "Catalog database",
      path: path.join(dirs.dataDir, CATALOG_DB_FILENAME),
      sizeBytes: catalogBytes(dirs.dataDir),
      kind: "only-copy",
    },
    {
      id: "covers",
      label: "Cover cache",
      path: path.join(dirs.dataDir, COVERS_DIRNAME),
      sizeBytes: directoryBytes(path.join(dirs.dataDir, COVERS_DIRNAME)),
      kind: "derived",
    },
    {
      id: "gpu-fallback",
      label: "GPU fallback marker",
      path: path.join(dirs.dataDir, GPU_FALLBACK_MARKER),
      sizeBytes: gpuMarkerBytes,
      kind: "derived",
    },
  ];
  const configEntries: StorageEntry[] = [
    {
      id: "browser-caches",
      label: "Browser caches",
      path: dirs.configDir,
      sizeBytes: cacheDirsBytes,
      kind: "derived",
    },
    {
      id: "settings",
      label: "Settings",
      path: dirs.configDir,
      sizeBytes: Math.max(0, configRootBytes - cacheDirsBytes),
      kind: "settings",
    },
  ];

  const roots: StorageRoot[] = [
    {
      id: "app-data",
      label: "App data",
      path: dirs.dataDir,
      sizeBytes: dataRootBytes,
      entries: dataEntries,
    },
    {
      id: "app-config",
      label: "App settings and caches",
      path: dirs.configDir,
      sizeBytes: configRootBytes,
      entries: configEntries,
    },
  ];

  // Book locations and catalog counts come from the sidecar aggregate; the
  // report mirrors them without recomputing.
  return {
    roots,
    appDataBytes: dataRootBytes + configRootBytes,
    cacheBytes: cacheDirsBytes + gpuMarkerBytes,
    bookLocations: library.locations,
    bookTotalBytes: library.bookTotalBytes,
    catalog: library.catalog,
  };
}
