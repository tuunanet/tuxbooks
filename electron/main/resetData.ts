import path from "node:path";

import { RESET_DATA_COMMAND } from "./bootRecovery";
import { clearAppCache } from "./clearCache";
import { isContained } from "./pathContainment";
import {
  BROWSER_CACHE_DIRS,
  buildStorageReport,
  CATALOG_DB_FILENAME,
  COVERS_DIRNAME,
  directoryBytes,
  type StorageDirs,
} from "./storageSizing";
import type { LibraryStorageStats, StorageReport } from "../shared/storageReport";

/**
 * Command-line recovery (data-management spec): `--dry-run` prints the
 * resolved app-data roots and their sizes without touching anything, and
 * `--reset-data` clears app data while never touching book files. The
 * database is quarantined by default, never deleted, so the catalog (the only
 * copy) and the watched locations it carries survive. The fs surface, the
 * resolved roots, and the writers are injected, so the policy unit-tests
 * without Electron. Each removal goes through the shared `isContained` rule,
 * so a symlink can never point a deletion outside the app-owned roots.
 */

/** The copy-paste command shown after a reset, to start the app again. */
export const LAUNCH_COMMAND = "tuxbooks";

/** The fs calls the reset needs; injected so the policy tests without Electron. */
export interface ResetFsSurface {
  existsSync(target: string): boolean;
  readdirSync(root: string): string[];
  realpathSync(target: string): string;
  renameSync(from: string, to: string): void;
  rmSync(target: string, options?: { recursive?: boolean; force?: boolean }): void;
}

export interface ResetDataDeps {
  fs: ResetFsSurface;
  dirs: StorageDirs;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  now?: () => Date;
}

export interface ResetReport {
  dirs: StorageDirs;
  removed: string[];
  quarantined: { from: string; to: string } | null;
  freedBytes: number;
}

/** Dry-run sizes the app roots without a sidecar; watched data is not read. */
const EMPTY_LIBRARY: LibraryStorageStats = {
  locations: [],
  bookTotalBytes: 0,
  catalog: { books: 0, authors: 0, collections: 0, annotations: 0, readingProgress: 0 },
};

/** The sidecar's quarantine stamp; matches its `%Y%m%dT%H%M%S%.3fZ` format. */
export function quarantineStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "");
}

/** A free `<db>.corrupt-<stamp>[/-attempt]` name next to the database. */
function quarantineTarget(fs: ResetFsSurface, database: string, now: Date): string {
  const stamp = quarantineStamp(now);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const candidate =
      attempt === 0 ? `${database}.corrupt-${stamp}` : `${database}.corrupt-${stamp}-${attempt}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${database}.corrupt-${stamp}-${now.getTime()}`;
}

/** Move the database and its WAL and shm sidecars aside without deleting them. */
function quarantineDatabase(
  fs: ResetFsSurface,
  dataDir: string,
  now: Date,
): { from: string; to: string } | null {
  const database = path.join(dataDir, CATALOG_DB_FILENAME);
  if (!fs.existsSync(database)) return null;
  const target = quarantineTarget(fs, database, now);
  fs.renameSync(database, target);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${database}${suffix}`;
    if (!fs.existsSync(sidecar)) continue;
    try {
      fs.renameSync(sidecar, `${target}${suffix}`);
    } catch {
      // Best effort: the fresh database is created at the now-free path.
    }
  }
  return { from: database, to: target };
}

/** Remove one app-owned target, but only when it really lives under `root`. */
function removeContained(
  deps: ResetDataDeps,
  root: string,
  target: string,
): { path: string; bytes: number } | null {
  const { fs } = deps;
  if (!isContained(fs, root, target)) return null;
  const bytes = directoryBytes(target);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { path: target, bytes };
  } catch {
    return null;
  }
}

/**
 * Clear app data: the browser caches and GPU marker (the w46.4 clear), the
 * cover cache, the settings under the config root, and the quarantined
 * database. Book files and watched locations are never touched.
 */
async function resetAppData(deps: ResetDataDeps): Promise<ResetReport> {
  const { fs, dirs } = deps;
  const now = deps.now ? deps.now() : new Date();
  const removed: string[] = [];
  let freedBytes = await clearAppCache(dirs);

  const covers = path.join(dirs.dataDir, COVERS_DIRNAME);
  const coversResult = removeContained(deps, dirs.dataDir, covers);
  if (coversResult) {
    removed.push(coversResult.path);
    freedBytes += coversResult.bytes;
  } else if (fs.existsSync(covers)) {
    deps.stderr(`[reset] refused to remove ${covers}: it resolves outside the data root`);
  }

  const quarantined = quarantineDatabase(fs, dirs.dataDir, now);

  let configNames: string[] = [];
  try {
    configNames = fs.readdirSync(dirs.configDir);
  } catch {
    configNames = [];
  }
  const cacheNames: readonly string[] = BROWSER_CACHE_DIRS;
  for (const name of configNames) {
    if (cacheNames.includes(name)) continue;
    const settingsResult = removeContained(deps, dirs.configDir, path.join(dirs.configDir, name));
    if (settingsResult) {
      removed.push(settingsResult.path);
      freedBytes += settingsResult.bytes;
    }
  }

  return { dirs, removed, quarantined, freedBytes };
}

function bytes(value: number): string {
  return `${value} bytes`;
}

export function formatDryRun(report: StorageReport): string {
  const lines: string[] = ["TuxBooks dry run: no files were changed."];
  for (const root of report.roots) {
    lines.push(`${root.label}: ${root.path} (${bytes(root.sizeBytes)})`);
    for (const entry of root.entries) {
      lines.push(`  ${entry.label}: ${entry.path} (${bytes(entry.sizeBytes)})`);
    }
  }
  lines.push(`To clear app data, run: ${RESET_DATA_COMMAND}`);
  return lines.join("\n");
}

export function formatResetReport(report: ResetReport): string {
  const lines: string[] = [
    "TuxBooks reset complete. No book files were touched.",
    `App data: ${report.dirs.dataDir}`,
    `App settings and caches: ${report.dirs.configDir}`,
  ];
  if (report.quarantined) {
    lines.push(`Quarantined database: ${report.quarantined.from} -> ${report.quarantined.to}`);
  }
  lines.push(
    `Removed ${report.removed.length} app data entries (${bytes(report.freedBytes)} freed).`,
  );
  lines.push(`To start TuxBooks again, run: ${LAUNCH_COMMAND}`);
  return lines.join("\n");
}

/** Print the resolved paths and sizes; read-only, so nothing is created or removed. */
export function runDryRun(deps: ResetDataDeps): void {
  deps.stdout(formatDryRun(buildStorageReport(deps.dirs, EMPTY_LIBRARY)));
}

/** Clear app data, print what happened and where the database went, and return the report. */
export async function runResetData(deps: ResetDataDeps): Promise<ResetReport> {
  const report = await resetAppData(deps);
  deps.stdout(formatResetReport(report));
  return report;
}
