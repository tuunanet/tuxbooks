import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GPU_FALLBACK_MARKER } from "../../electron/main/gpuFallback";
import { buildStorageReport, directoryBytes } from "../../electron/main/storageSizing";
import type {
  LibraryStorageStats,
  StorageReport,
  StorageRoot,
} from "../../electron/shared/storageReport";

/**
 * Main-process sizing tests (data-management spec): the bounded walk and the
 * report it feeds. Real temp directories, external behavior only: what the
 * report contains, never how the walk is written.
 */

const NO_LIBRARY: LibraryStorageStats = {
  locations: [],
  bookTotalBytes: 0,
  catalog: { books: 0, authors: 0, collections: 0, annotations: 0, readingProgress: 0 },
};

let dataDir: string;
let configDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-data-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-config-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

function write(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
}

function rootById(report: StorageReport, id: "app-data" | "app-config"): StorageRoot {
  const root = report.roots.find((candidate) => candidate.id === id);
  if (!root) throw new Error(`missing root ${id}`);
  return root;
}

describe("directoryBytes", () => {
  it("sums files recursively", () => {
    write(path.join(dataDir, "a.bin"), 100);
    write(path.join(dataDir, "nested", "b.bin"), 200);
    expect(directoryBytes(dataDir)).toBe(300);
  });

  it("does not follow symlinks", () => {
    write(path.join(dataDir, "real.bin"), 100);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-outside-"));
    const outside = path.join(outsideDir, "outside.bin");
    write(outside, 5000);
    try {
      fs.symlinkSync(outside, path.join(dataDir, "link.bin"));
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }
    try {
      expect(directoryBytes(dataDir)).toBe(100);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("reads a missing directory as zero without throwing", () => {
    expect(directoryBytes(path.join(dataDir, "nope"))).toBe(0);
  });
});

describe("buildStorageReport", () => {
  it("sizes the data root entries", () => {
    write(path.join(dataDir, "tuxbooks.db"), 1000);
    write(path.join(dataDir, "tuxbooks.db-wal"), 40);
    write(path.join(dataDir, "tuxbooks.db-shm"), 10);
    write(path.join(dataDir, "covers", "a.png"), 300);
    write(path.join(dataDir, "covers", "b.png"), 200);
    write(path.join(dataDir, GPU_FALLBACK_MARKER), 5);

    const report = buildStorageReport({ dataDir, configDir }, NO_LIBRARY);
    const dataRoot = rootById(report, "app-data");
    expect(dataRoot.id).toBe("app-data");
    expect(dataRoot.sizeBytes).toBe(directoryBytes(dataDir));
    expect(dataRoot.entries.find((entry) => entry.id === "catalog")).toMatchObject({
      sizeBytes: 1050,
      kind: "only-copy",
    });
    expect(dataRoot.entries.find((entry) => entry.id === "covers")).toMatchObject({
      sizeBytes: 500,
      kind: "only-copy",
    });
    expect(dataRoot.entries.find((entry) => entry.id === "gpu-fallback")).toMatchObject({
      sizeBytes: 5,
      kind: "derived",
    });
  });

  it("sizes the config root caches and settings and the cache total", () => {
    write(path.join(configDir, "Cache", "x"), 400);
    write(path.join(configDir, "GPUCache", "y"), 100);
    write(path.join(configDir, "Preferences"), 7);
    write(path.join(dataDir, GPU_FALLBACK_MARKER), 5);

    const report = buildStorageReport({ dataDir, configDir }, NO_LIBRARY);
    const configRoot = rootById(report, "app-config");
    expect(configRoot.id).toBe("app-config");
    expect(configRoot.sizeBytes).toBe(directoryBytes(configDir));
    expect(configRoot.entries.find((entry) => entry.id === "browser-caches")).toMatchObject({
      sizeBytes: 500,
      kind: "derived",
    });
    expect(configRoot.entries.find((entry) => entry.id === "settings")).toMatchObject({
      sizeBytes: directoryBytes(configDir) - 500,
      kind: "settings",
    });
    expect(report.cacheBytes).toBe(505);
    expect(report.appDataBytes).toBe(
      report.roots.reduce((total, root) => total + root.sizeBytes, 0),
    );
  });

  it("folds the sidecar's locations, bytes, and catalog counts into the report", () => {
    const library: LibraryStorageStats = {
      locations: [
        {
          id: 1,
          path: "/books",
          addedAt: "2026-01-01T00:00:00.000Z",
          bookCount: 3,
          totalBytes: 9,
        },
      ],
      bookTotalBytes: 9,
      catalog: { books: 3, authors: 2, collections: 1, annotations: 4, readingProgress: 2 },
    };

    const report = buildStorageReport({ dataDir, configDir }, library);
    expect(report.bookLocations).toEqual(library.locations);
    expect(report.bookTotalBytes).toBe(9);
    expect(report.catalog).toEqual(library.catalog);
  });
});
