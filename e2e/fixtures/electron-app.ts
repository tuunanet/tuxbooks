/**
 * The application fixture: the single owner of the Electron lifecycle
 * (docs/TESTING.md). Tests receive `electronApp` (main-process handle) and
 * `page` (the app's first BrowserWindow) — they never launch Electron
 * themselves.
 *
 * Responsibilities, mirroring the old WDIO service+config contract:
 * - isolation gate: fail before anything launches unless the environment
 *   points at this run's scratch dir (`tuxbooks-e2e-`), and fail before the
 *   first test unless the sidecar actually wrote the scratch database;
 * - Electron launch with the pinned X11/HiDPI switches (a Wayland desktop
 *   is reachable through the compositor socket even with WAYLAND_DISPLAY
 *   unset — without the pin, E2E windows land on the real desktop);
 * - main + renderer console capture into the run's artifacts (failures must
 *   be diagnosable from CI artifacts alone);
 * - Chromium-version record completion;
 * - teardown that reliably quits the app (worker-scoped, so one app serves
 *   a whole worker's spec files — the phase keeps accumulating state in the
 *   scratch library exactly like the previous harness).
 */
import fs from "node:fs";
import path from "node:path";

import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { test as base, expect, type TestInfo } from "@playwright/test";

import { appEntryPoint } from "../setup/fixtures.js";
import { artifactsDir, configDir, databasePath, libraryDir, runId } from "../setup/environment.js";
import { stackVersions } from "../setup/versions.js";

interface TestFixtures {
  /** The app's first BrowserWindow (shared across the worker's tests). */
  page: Page;
  /** Auto fixture: failure artifacts (screenshot + metadata) per test. */
  failureArtifacts: void;
}

interface WorkerFixtures {
  /** Main-process handle of the launched Electron app. */
  electronApp: ElectronApplication;
}

const versions = stackVersions();

// A high-DPI/high-refresh desktop is part of the reference conditions
// (docs/PERFORMANCE.md); the hidpi phase (just test-e2e-hidpi) forces a
// device scale factor through this Chromium switch.
const deviceScaleFactor = Number(process.env.E2E_DEVICE_SCALE_FACTOR ?? "");
const appArgs = ["--no-sandbox", "--ozone-platform=x11"];
if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
  appArgs.push(`--force-device-scale-factor=${deviceScaleFactor}`);
}

/** Renderer + main console lines land in per-run files, prefixed. */
function logLine(file: string, line: string): void {
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.appendFileSync(path.join(artifactsDir, file), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics only — never fail a run over its own log.
  }
}

/** Merge a patch into the run's environment record (diagnostics only). */
function patchEnvironmentRecord(patch: Record<string, unknown>): void {
  const file = path.join(artifactsDir, "environment.json");
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...record, ...patch }, null, 2));
  } catch {
    // Diagnostics only.
  }
}

/**
 * Launch one isolated app instance. Exported for the desktop-shell suite's
 * relaunch scenario, which manages a second app lifecycle inside a test
 * (ElectronApplication.close() is idempotent, so the worker teardown's
 * close on an already-closed app is a no-op).
 */
export async function launchElectronApp(): Promise<ElectronApplication> {
  // Isolation gate (docs/TESTING.md): the scratch database must belong to
  // this run before the app ever launches. A fixture-level failure stops
  // the worker — there is no WDIO-style "log the hook error and continue"
  // that could silently degrade into testing the real user library.
  const dbPath = process.env.TEST_DATABASE_PATH ?? "";
  if (!dbPath.includes("tuxbooks-e2e-") || dbPath !== databasePath) {
    throw new Error(
      "E2E isolation broken: TEST_DATABASE_PATH does not point at this run's scratch dir",
    );
  }
  if (process.env.TEST_LIBRARY_PATH !== libraryDir || process.env.XDG_CONFIG_HOME !== configDir) {
    throw new Error("E2E isolation broken: scratch environment variables are not coherent");
  }

  // Playwright's Electron launcher: spawns the electron binary from this
  // package's node_modules pointed at our CJS main bundle (the unpackaged
  // dev app), then attaches to it over CDP. Main-process stdout/stderr —
  // including every main-process console.log/error — rides through the
  // child pipes and is captured below.
  const app = await electron.launch({ args: [appEntryPoint, ...appArgs] });

  // Main-process console/errors (the WDIO service's captureMainProcessLogs
  // equivalent): everything the app prints lands in the per-run log.
  const child = app.process();
  const mainLog = path.join(artifactsDir, "electron-main.log");
  fs.mkdirSync(artifactsDir, { recursive: true });
  child.stdout?.on("data", (chunk: Buffer) => fs.appendFile(mainLog, chunk, () => {}));
  child.stderr?.on("data", (chunk: Buffer) => fs.appendFile(mainLog, chunk, () => {}));

  // Renderer diagnostics: console messages and uncaught page errors go to
  // the per-run renderer log next to the main-process one.
  const window = await app.firstWindow();
  window.on("console", (message) =>
    logLine("electron-renderer.log", `[${message.type()}] ${message.text()}`),
  );
  window.on("pageerror", (error) =>
    logLine("electron-renderer.log", `[pageerror] ${error.message}`),
  );
  window.on("close", () => logLine("electron-renderer.log", "[close] window closed"));

  // Complete the environment record with the Chromium build the running
  // app actually reports (the launcher side only knows the Electron
  // package version).
  try {
    const runtime = await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      appPath: process.env.TEST_DATABASE_PATH ?? "",
    }));
    patchEnvironmentRecord({
      chromium: runtime.chrome,
      electronRuntime: runtime.electron,
    });
    console.log(`[e2e] session versions: electron=${runtime.electron} chromium=${runtime.chrome}`);
  } catch {
    // Diagnostics only.
  }

  // Isolation gate, second half (docs/TESTING.md): the sidecar must have
  // written the schema into the scratch database before any test runs. The
  // window only appears after the sidecar is healthy, so by the time the
  // page exists the DB should be written — poll anyway, bounded.
  await expect
    .poll(
      () => {
        try {
          return fs.statSync(databasePath).size;
        } catch {
          return 0;
        }
      },
      { timeout: 10_000, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThan(0);

  return app;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  electronApp: [
    async ({}, use) => {
      const app = await launchElectronApp();
      await use(app);
      await app.close();
    },
    { scope: "worker" },
  ],

  page: [
    async ({ electronApp }, use) => {
      // firstWindow() memoizes: every test in the worker gets the same
      // BrowserWindow, so reading-position/view state accumulates across
      // specs exactly like the shared-session harness (helpers re-navigate
      // to a known state before asserting).
      const window = await electronApp.firstWindow();
      await use(window);
      // No explicit teardown: closing the app (worker teardown) closes its
      // windows; a lingering window dies with the app process.
    },
    { scope: "test" },
  ],

  failureArtifacts: [
    async ({ page }, use, testInfo: TestInfo) => {
      await use();
      if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;
      const sanitized = testInfo.title.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80) || "test";
      // Screenshot-only-on-failure debugging aid; no visual baselines.
      // Best effort: the screenshot itself fails when the app died.
      try {
        await page.screenshot({
          path: path.join(artifactsDir, `${runId}-${sanitized}.png`),
          timeout: 5000,
        });
      } catch (err) {
        console.warn(`[e2e] failure screenshot unavailable: ${err}`);
      }
      // Failure metadata (docs/TESTING.md): what failed, where, and against
      // which stack — so CI artifacts answer "React, Electron, engine, IPC,
      // or harness?" without a local reproduction. Renderer/main console
      // output and the Playwright trace sit next to this file.
      try {
        const failure = {
          runId,
          suite: path.basename(testInfo.file ?? ""),
          test: testInfo.title,
          file: testInfo.file ?? null,
          error: testInfo.error
            ? { message: testInfo.error.message, stack: testInfo.error.stack ?? null }
            : null,
          stack: versions,
          at: new Date().toISOString(),
        };
        fs.writeFileSync(
          path.join(artifactsDir, `failure-${runId}-${sanitized}.json`),
          JSON.stringify(failure, null, 2),
        );
      } catch (err) {
        console.warn(`[e2e] failure metadata unavailable: ${err}`);
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { ElectronApplication, Page } from "playwright";
