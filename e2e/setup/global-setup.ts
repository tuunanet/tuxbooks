/**
 * Playwright global setup — runs once per invocation, before any worker.
 * Mirrors the old WDIO onPrepare contract (docs/TESTING.md): prepare the
 * isolated scratch environment, log and record the stack versions, and arm
 * the detached teardown watchdog so an aborted run cannot leak processes.
 */
import { prepareEnvironment, armTeardownWatchdog, artifactsDir } from "./environment.js";
import { formatVersionBanner, stackVersions, writeEnvironmentRecord } from "./versions.js";

export default function globalSetup(): void {
  prepareEnvironment(process.env.E2E_SEED_LIBRARY === "1");

  const versions = stackVersions();
  console.log(formatVersionBanner(versions));
  writeEnvironmentRecord(`${artifactsDir}/environment.json`, versions, {
    runId: process.env.E2E_RUN_ID,
    phase: process.env.E2E_PHASE ?? "run",
    seeded: process.env.E2E_SEED_LIBRARY === "1",
    deviceScaleFactor:
      Number.isFinite(Number(process.env.E2E_DEVICE_SCALE_FACTOR)) &&
      process.env.E2E_DEVICE_SCALE_FACTOR !== ""
        ? Number(process.env.E2E_DEVICE_SCALE_FACTOR)
        : 1,
  });

  // Arm the watchdog HERE, before anything spawns: an aborted or killed
  // runner never reaches globalTeardown, and the watchdog sweeps the moment
  // its parent disappears — an interrupted run cannot leak app, sidecar, or
  // Xvfb processes. The sweep only kills processes that predate the
  // watchdog, so the next phase's processes are safe.
  armTeardownWatchdog();
}
