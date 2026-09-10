import fs from "node:fs";
import path from "node:path";

import {
  expect,
  launchElectronApp,
  test,
  type ElectronApplication,
} from "../fixtures/electron-app.js";
import { databasePath } from "../setup/environment.js";
import { canvasIsNonBlank, openInReader, returnToLibrary, waitForRendered } from "./helpers.js";

/**
 * GPU-crash fallback policy (docs/gpu-fallback.md, issue #13): after a
 * session lost its GPU process repeatedly, the next launch runs
 * software-rendered, reading keeps working in that degraded mode, and a
 * stable hardware-accelerated session clears the fallback again.
 *
 * Own Playwright phase ("gpu", e2e/package.json test:gpu): the scenarios
 * close and relaunch the app with different marker states, which must not
 * share a worker with other suites (same rule as the desktop-shell phase).
 *
 * What is verifiable here: the marker-driven behavior through the real app
 * (boot decision, degraded-mode reading, clean-exit self-heal). Injecting
 * two real GPU-process crashes is not possible deterministically headlessly,
 * so the crash-count → marker arming is pinned by the policy unit tests
 * (frontend/tests/gpuFallbackPolicy.test.ts) instead.
 */

/** The marker lives next to the scratch database (TEST_DATABASE_PATH). */
const markerPath = path.join(path.dirname(databasePath), "gpu-fallback.json");

const DAY_MS = 24 * 60 * 60 * 1000;

function writeMarker(expiresInDays: number): void {
  const now = Date.now();
  const marker = {
    reason: "repeated-gpu-process-crashes",
    crashes: 2,
    firstCrashAt: new Date(now - DAY_MS).toISOString(),
    lastCrashAt: new Date(now - DAY_MS).toISOString(),
    expiresAt: new Date(now + expiresInDays * DAY_MS).toISOString(),
    electron: "e2e",
    chrome: "e2e",
  };
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
}

/**
 * The decision probe: disableHardwareAcceleration() appends --disable-gpu to
 * the Chromium command line, so hasSwitch is the exact in-process record of
 * what the startup policy decided. (The policy's console.warn fires during
 * module evaluation — too early for the launch fixture's pipe capture — so
 * the log is a diagnostic, not an assertion surface.)
 */
function gpuDisabled(electronApp: ElectronApplication): Promise<boolean> {
  return electronApp.evaluate(({ app }) => app.commandLine.hasSwitch("disable-gpu"));
}

test.describe("TuxBooks GPU-crash fallback", () => {
  // The worker-scoped app fixture launches lazily on first use — after this
  // module has placed the active marker, so the fixture's very first launch
  // is the degraded one.
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  writeMarker(7);

  test("boots software-rendered while a fallback marker is active", async ({
    electronApp,
    page,
  }) => {
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
    // The startup decision is in effect for this process.
    expect(await gpuDisabled(electronApp)).toBe(true);
    // Diagnostic record of the degraded environment (values are
    // environment-dependent; the activation above is not).
    const gpuStatus = await electronApp.evaluate(({ app }) => app.getGPUFeatureStatus());
    console.log(`[e2e] GPU feature status under fallback: ${JSON.stringify(gpuStatus)}`);
    // The decision state must not be lost across a restart: the marker is
    // cleared only by a stable HARDWARE-accelerated session, and this
    // session did not run one. Asserted on the file the next launch reads.
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  test("reading degrades gracefully: PDF pages still render without hardware acceleration", async ({
    page,
  }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await waitForRendered(page, 1);
    expect(await canvasIsNonBlank(page, 1)).toBe(true);
    await returnToLibrary(page);
  });

  test("a stable hardware-accelerated session clears an expired fallback marker", async ({
    electronApp,
  }) => {
    // Clean quit of the software-rendered session from the previous tests:
    // it must NOT have cleared the active marker (it proves nothing about
    // the hardware path).
    await electronApp.close();
    expect(fs.existsSync(markerPath)).toBe(true);

    // Now the marker is expired: the next session reads as
    // hardware-accelerated and — ending cleanly with zero GPU crashes —
    // removes the stale marker so the fallback does not stick forever.
    writeMarker(-1);
    const relaunched = await launchElectronApp();
    try {
      await relaunched.firstWindow();
      expect(await gpuDisabled(relaunched)).toBe(false);
    } finally {
      await relaunched.close();
    }
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
