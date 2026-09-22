import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { GPU_FALLBACK_MARKER } from "./gpuFallback";
import { isContained } from "./pathContainment";
import { BROWSER_CACHE_DIRS, directoryBytes, type StorageDirs } from "./storageSizing";

/**
 * Cache clear (data-management spec): remove only the data the app
 * regenerates by itself, the Chromium browser caches under the config root
 * and the GPU fallback marker under the data root. The catalog, the cover
 * cache, the settings, and book files are never touched. Each target goes
 * through the shared `isContained` rule, so a symlink planted in the root
 * cannot point the deletion elsewhere. Symlinks found during the walk are
 * skipped and `rm` unlinks a link itself rather than following it. Returns
 * the bytes freed.
 */

interface ClearTarget {
  root: string;
  name: string;
}

/** A target the cache clear owns: fixed directory names plus the GPU marker. */
export function clearTargets(dirs: StorageDirs): ClearTarget[] {
  return [
    ...BROWSER_CACHE_DIRS.map((name) => ({ root: dirs.configDir, name })),
    { root: dirs.dataDir, name: GPU_FALLBACK_MARKER },
  ];
}

/** Remove the browser caches and GPU marker; resolves the bytes freed. */
export async function clearAppCache(dirs: StorageDirs): Promise<number> {
  let freed = 0;
  for (const { root, name } of clearTargets(dirs)) {
    const target = path.join(root, name);
    if (!isContained(fs, root, target)) continue;
    const bytes = directoryBytes(target);
    try {
      await fsp.rm(target, { recursive: true, force: true });
      freed += bytes;
    } catch {
      // Best effort: a cache the running app holds open stays and counts as
      // nothing freed; the next clear picks it up.
    }
  }
  return freed;
}
