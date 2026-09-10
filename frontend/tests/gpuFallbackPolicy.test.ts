import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearGpuFallbackMarker,
  gpuFallbackMarkerExists,
  GPU_CRASH_FALLBACK_THRESHOLD,
  gpuFallbackMarkerPath,
  readGpuFallbackMarker,
  recordGpuCrashes,
  type GpuFallbackMarker,
} from "../../electron/main/gpuFallback";

/**
 * Policy unit tests for the GPU-crash fallback (docs/gpu-fallback.md,
 * issue #13): the crash-count threshold arming, marker expiry, and the
 * self-heal primitive. The marker-driven end-to-end behavior (boot decision,
 * degraded reading, clean-exit clearing) is pinned by the E2E gpu phase;
 * injecting real GPU-process crashes is not possible headlessly.
 */

const VERSIONS = { electron: "44.0.0", chrome: "130.0.0.0" };
const T0 = new Date("2026-09-10T12:00:00.000Z");

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-fallback-test-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("gpu fallback marker policy", () => {
  it("reads as absent when no marker exists", () => {
    expect(readGpuFallbackMarker(dataDir, T0)).toBeNull();
    expect(gpuFallbackMarkerExists(dataDir)).toBe(false);
  });

  it("ignores crash counts below the threshold — one crash never degrades the next launch", () => {
    expect(recordGpuCrashes(dataDir, GPU_CRASH_FALLBACK_THRESHOLD - 1, VERSIONS, T0)).toBeNull();
    expect(gpuFallbackMarkerExists(dataDir)).toBe(false);
  });

  it("arms the fallback at the threshold with an expiry inside the window", () => {
    const marker = recordGpuCrashes(dataDir, GPU_CRASH_FALLBACK_THRESHOLD, VERSIONS, T0);
    expect(marker).not.toBeNull();
    expect(marker?.reason).toBe("repeated-gpu-process-crashes");
    expect(marker?.crashes).toBe(GPU_CRASH_FALLBACK_THRESHOLD);
    expect(marker?.firstCrashAt).toBe(T0.toISOString());
    expect(marker?.lastCrashAt).toBe(T0.toISOString());

    const reread = readGpuFallbackMarker(dataDir, T0);
    expect(reread).toEqual(marker);
  });

  it("refreshes an existing marker without losing the first crash time", () => {
    recordGpuCrashes(dataDir, GPU_CRASH_FALLBACK_THRESHOLD, VERSIONS, T0);
    const later = new Date(T0.getTime() + 60_000);
    const refreshed = recordGpuCrashes(dataDir, GPU_CRASH_FALLBACK_THRESHOLD + 1, VERSIONS, later);
    expect(refreshed?.firstCrashAt).toBe(T0.toISOString());
    expect(refreshed?.lastCrashAt).toBe(later.toISOString());
    expect(refreshed?.crashes).toBe(GPU_CRASH_FALLBACK_THRESHOLD + 1);
  });

  it("expires: an out-of-date marker reads as absent but stays on disk", () => {
    recordGpuCrashes(dataDir, GPU_CRASH_FALLBACK_THRESHOLD, VERSIONS, T0);
    const afterExpiry = new Date(T0.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(readGpuFallbackMarker(dataDir, afterExpiry)).toBeNull();
    // Stale files are not dropped on read — the next clean hardware session
    // removes them (clearGpuFallbackMarker) so the decision path stays pure.
    expect(gpuFallbackMarkerExists(dataDir)).toBe(true);
  });

  it("treats corrupt, foreign, or malformed markers as absent", () => {
    const p = gpuFallbackMarkerPath(dataDir);
    const broken: string[] = [
      "not json at all",
      "{}",
      JSON.stringify({ reason: "something-else", expiresAt: T0.toISOString() }),
      JSON.stringify({ reason: "repeated-gpu-process-crashes" }),
      JSON.stringify({
        reason: "repeated-gpu-process-crashes",
        expiresAt: "not-a-date",
      }),
    ];
    for (const raw of broken) {
      fs.writeFileSync(p, raw);
      expect(readGpuFallbackMarker(dataDir, T0)).toBeNull();
    }
  });

  it("a clean hardware-accelerated session clears the marker (self-heal)", () => {
    recordGpuCrashes(dataDir, GPU_CRASH_FALLBACK_THRESHOLD, VERSIONS, T0);
    expect(clearGpuFallbackMarker(dataDir)).toBe(true);
    expect(gpuFallbackMarkerExists(dataDir)).toBe(false);
  });

  it("clearing reports nothing removed when no marker exists", () => {
    expect(clearGpuFallbackMarker(dataDir)).toBe(false);
  });

  it("survives a read-only data dir: arming failure only means the next launch retries hardware", () => {
    const readOnly = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-fallback-ro-"));
    fs.chmodSync(readOnly, 0o500);
    try {
      expect(recordGpuCrashes(readOnly, 5, VERSIONS, T0)).toBeNull();
      expect(readGpuFallbackMarker(readOnly, T0)).toBeNull();
    } finally {
      fs.chmodSync(readOnly, 0o700);
      fs.rmSync(readOnly, { recursive: true, force: true });
    }
  });

  it("marker shape is stable — the E2E phase writes this exact record shape", () => {
    const marker = recordGpuCrashes(dataDir, GPU_CRASH_FALLBACK_THRESHOLD, VERSIONS, T0);
    const keys = Object.keys(marker as GpuFallbackMarker).sort();
    expect(keys).toEqual([
      "chrome",
      "crashes",
      "electron",
      "expiresAt",
      "firstCrashAt",
      "lastCrashAt",
      "reason",
    ]);
  });
});
