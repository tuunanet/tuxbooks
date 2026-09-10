import fs from "node:fs";
import path from "node:path";

/**
 * GPU-crash fallback policy (docs/gpu-fallback.md, issue #13): a GPU-process
 * crash under an unstable driver stack (observed: Mesa/Wayland, Chromium's
 * `--type=gpu-process`) is recovered by Chromium itself, but a session that
 * accumulates repeated crashes means the graphics stack is broken — the next
 * launch then runs software-rendered until a stable session proves hardware
 * acceleration works again.
 *
 * Pure node:fs/path — deliberately no Electron import, so the decision logic
 * is unit-testable and the module can run at the top of the main bundle,
 * before `app.whenReady()` (disableHardwareAcceleration is legal only there).
 * The marker lives next to the application database, which keeps the
 * TEST_DATABASE_PATH isolation of every test/E2E environment for free.
 */

/** Marker file name, placed in the app data dir next to the database. */
export const GPU_FALLBACK_MARKER = "gpu-fallback.json";

/**
 * GPU-process crashes (`reason: "crashed"`) tolerated per hardware-accelerated
 * session. One crash is a driver hiccup; two within one session is the
 * crash → recovery → crash loop of an unstable stack.
 */
export const GPU_CRASH_FALLBACK_THRESHOLD = 2;

/** The fallback expires after this many days: a fixed driver is re-tried. */
export const GPU_FALLBACK_EXPIRY_DAYS = 7;

export interface GpuFallbackMarker {
  reason: "repeated-gpu-process-crashes";
  /** Crash count that triggered the marker (the threshold or more). */
  crashes: number;
  firstCrashAt: string;
  lastCrashAt: string;
  /** ISO timestamp; the marker reads as absent after this point. */
  expiresAt: string;
  electron: string;
  chrome: string;
}

export function gpuFallbackMarkerPath(dataDir: string): string {
  return path.join(dataDir, GPU_FALLBACK_MARKER);
}

/**
 * Read an active fallback marker. Absent, unreadable, corrupt, foreign, or
 * expired files all read as `null` — the fallback decision must never be
 * broken by a bad file. Expired files are not unlinked here; the next clean
 * hardware-accelerated session removes stale files (clearGpuFallbackMarker).
 */
export function readGpuFallbackMarker(
  dataDir: string,
  now: Date = new Date(),
): GpuFallbackMarker | null {
  let raw: string;
  try {
    raw = fs.readFileSync(gpuFallbackMarkerPath(dataDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GpuFallbackMarker> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.reason !== "repeated-gpu-process-crashes") return null;
    if (typeof parsed.expiresAt !== "string") return null;
    const expiresAt = new Date(parsed.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) return null;
    return parsed as GpuFallbackMarker;
  } catch {
    return null;
  }
}

/**
 * Record GPU-process crashes after a hardware-accelerated session reached
 * the fallback threshold: writes (or refreshes) the marker and returns it.
 * Below the threshold this is a no-op returning `null` — a single crash
 * never degrades the next launch. `lastCrashAt` is `now`; `firstCrashAt`
 * carries over when an existing marker is refreshed.
 */
export function recordGpuCrashes(
  dataDir: string,
  crashCount: number,
  versions: { electron: string; chrome: string },
  now: Date = new Date(),
): GpuFallbackMarker | null {
  if (crashCount < GPU_CRASH_FALLBACK_THRESHOLD) return null;
  const existing = readGpuFallbackMarker(dataDir, now);
  const expiresAt = new Date(now.getTime() + GPU_FALLBACK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const marker: GpuFallbackMarker = {
    reason: "repeated-gpu-process-crashes",
    crashes: Math.max(crashCount, existing?.crashes ?? 0),
    firstCrashAt: existing?.firstCrashAt ?? now.toISOString(),
    lastCrashAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    electron: versions.electron,
    chrome: versions.chrome,
  };
  try {
    fs.writeFileSync(gpuFallbackMarkerPath(dataDir), JSON.stringify(marker, null, 2));
  } catch {
    // The marker is an optimization, not a correctness requirement: a
    // read-only data dir only means the next launch tries hardware again.
    return null;
  }
  return marker;
}

/**
 * Remove the marker file (best effort). Returns whether a file was removed —
 * the caller logs the self-heal only when there was something to heal.
 */
export function clearGpuFallbackMarker(dataDir: string): boolean {
  try {
    if (!fs.existsSync(gpuFallbackMarkerPath(dataDir))) return false;
    fs.rmSync(gpuFallbackMarkerPath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Whether a marker file exists at all (active or expired) — for diagnostics. */
export function gpuFallbackMarkerExists(dataDir: string): boolean {
  try {
    return fs.existsSync(gpuFallbackMarkerPath(dataDir));
  } catch {
    return false;
  }
}
