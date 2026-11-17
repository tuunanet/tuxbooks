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

// The hidpi phase forces a device scale factor through this Chromium switch.
const deviceScaleFactor = Number(process.env.E2E_DEVICE_SCALE_FACTOR ?? "");
const appArgs = ["--no-sandbox", "--ozone-platform=x11"];
if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
  appArgs.push(`--force-device-scale-factor=${deviceScaleFactor}`);
}
// Without a capture device Chromium rejects with NotFoundError before the permission
// handler, so the security phase gets a fake device to exercise the deny path.
if (process.env.E2E_PHASE === "security") {
  appArgs.push("--use-fake-device-for-media-stream");
}

/** Renderer + main console lines land in per-run files, prefixed. */
function logLine(file: string, line: string): void {
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.appendFileSync(path.join(artifactsDir, file), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** Merge a patch into the run's environment record (diagnostics only). */
function patchEnvironmentRecord(patch: Record<string, unknown>): void {
  const file = path.join(artifactsDir, "environment.json");
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...record, ...patch }, null, 2));
  } catch {}
}

/**
 * Launch one isolated app instance. Exported for the desktop-shell suite's
 * relaunch scenario, which manages a second app lifecycle inside a test
 * (ElectronApplication.close() is idempotent, so the worker teardown's
 * close on an already-closed app is a no-op).
 */
export async function launchElectronApp(): Promise<ElectronApplication> {
  // A fixture-level failure must stop the worker: logging a hook error and continuing
  // would silently degrade into testing the real user library.
  const dbPath = process.env.TEST_DATABASE_PATH ?? "";
  if (!dbPath.includes("tuxbooks-e2e-") || dbPath !== databasePath) {
    throw new Error(
      "E2E isolation broken: TEST_DATABASE_PATH does not point at this run's scratch dir",
    );
  }
  if (process.env.TEST_LIBRARY_PATH !== libraryDir || process.env.XDG_CONFIG_HOME !== configDir) {
    throw new Error("E2E isolation broken: scratch environment variables are not coherent");
  }

  const app = await electron.launch({ args: [appEntryPoint, ...appArgs] });

  const child = app.process();
  const mainLog = path.join(artifactsDir, "electron-main.log");
  fs.mkdirSync(artifactsDir, { recursive: true });
  child.stdout?.on("data", (chunk: Buffer) => fs.appendFile(mainLog, chunk, () => {}));
  child.stderr?.on("data", (chunk: Buffer) => fs.appendFile(mainLog, chunk, () => {}));

  const window = await app.firstWindow();
  window.on("console", (message) =>
    logLine("electron-renderer.log", `[${message.type()}] ${message.text()}`),
  );
  window.on("pageerror", (error) =>
    logLine("electron-renderer.log", `[pageerror] ${error.message}`),
  );
  window.on("close", () => logLine("electron-renderer.log", "[close] window closed"));

  // Pin light so spec expectations hold on dark hosts; the emulation re-applies the resolved theme.
  await window.emulateMedia({ colorScheme: "light" });

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
  } catch {}

  // The window only appears after a healthy sidecar, so the DB should exist; poll bounded anyway.
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
      // firstWindow() memoizes: every test gets the same BrowserWindow, so view state accumulates.
      const window = await electronApp.firstWindow();
      // Clear localStorage between tests so appearance picks do not leak; backend state accumulates.
      await window
        .evaluate(() => {
          try {
            window.localStorage.clear();
          } catch {}
        })
        .catch(() => {});
      // A settings window left open would hide the sidebar; Escape dismisses it without racing.
      if ((await window.getByTestId("settings-window").count()) > 0) {
        await window.keyboard.press("Escape").catch(() => {});
        await window
          .getByTestId("settings-window")
          .waitFor({ state: "detached", timeout: 2000 })
          .catch(() => {});
      }
      await use(window);
    },
    { scope: "test" },
  ],

  failureArtifacts: [
    async ({ page }, use, testInfo: TestInfo) => {
      await use();
      if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;
      const sanitized = testInfo.title.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80) || "test";
      try {
        await page.screenshot({
          path: path.join(artifactsDir, `${runId}-${sanitized}.png`),
          timeout: 5000,
        });
      } catch (err) {
        console.warn(`[e2e] failure screenshot unavailable: ${err}`);
      }
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
