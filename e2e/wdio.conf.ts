import path from "node:path";
import type { Options } from "@wdio/types";

import { appBinary } from "./setup/fixtures.js";
import {
  artifactsDir,
  armTeardownWatchdog,
  prepareEnvironment,
  runId,
  teardownEnvironment,
} from "./setup/environment.js";

/**
 * Desktop E2E against the real Tauri binary. The driver lifecycle (external
 * `tauri-driver` + WebKitWebDriver) is owned by @wdio/tauri-service; this
 * config only owns the isolated environment (setup/environment.ts) and the
 * failure artifacts.
 *
 * Headless: on Linux `just test-e2e` wraps the whole invocation in
 * `xvfb-run --auto-servernum`, so tauri-driver and the app inherit a virtual
 * display. (`autoXvfb` alone is not enough here: with maxInstances 1 the
 * service spawns the driver from the launcher process, which wdio's
 * per-worker Xvfb wrapping does not cover.)
 */
export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  // wdio worker/driver logs (always) + failure screenshots (afterTest).
  outputDir: artifactsDir,

  // Session-creation patience: 3 x 45s. A dead app is not fixed by more
  // retries — a fresh run is — and the old 15-retry budget let a wedged
  // startup burn the whole phase before the justfile timeout stepped in.
  connectionRetryCount: 3,
  connectionRetryTimeout: 45000,
  waitforTimeout: 10000,
  // Per-test bound (mocha). Healthy tests take seconds; without this a
  // wedged test stalls its whole spec file. Bigger than any explicit
  // waitFor inside the tests so those fail with their own message first.
  mochaOpts: { timeout: 120000 },

  services: [
    [
      "@wdio/tauri-service",
      {
        // External provider = the cargo-installed tauri-driver relaying to
        // WebKitWebDriver (Linux/Windows). The embedded provider would need a
        // WebDriver server compiled into the app itself.
        driverProvider: "external",
        // `cargo install tauri-driver` on first use when missing from PATH.
        autoInstallTauriDriver: true,
        // App stdout -> wdio log; console -> wdio log via the frontend plugin.
        captureBackendLogs: true,
        captureFrontendLogs: true,
        backendLogLevel: "debug",
        frontendLogLevel: "debug",
      },
    ],
  ],

  capabilities: [
    {
      // Force WebDriver Classic: WebKitWebDriver has no BiDi support, and
      // WebdriverIO 9 otherwise requests `webSocketUrl` for every non-Safari
      // session.
      "wdio:enforceWebDriverClassic": true,
      browserName: "tauri",
      "tauri:options": {
        application: appBinary,
      },
    } as never,
  ],

  onPrepare() {
    // Unique scratch dir per run; stale processes cleared first. Runs before
    // the service spawns tauri-driver, so the env below reaches the app.
    prepareEnvironment(appBinary, process.env.E2E_SEED_LIBRARY === "1");
  },

  afterTest(test, _context, result) {
    if (result.passed) return;
    // Screenshot-only-on-failure debugging aid; no visual baselines. Best
    // effort: the screenshot itself fails when the app died.
    const sanitized = test.title.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
    try {
      browser.saveScreenshot(path.join(artifactsDir, `${runId}-${sanitized}.png`));
    } catch (err) {
      console.warn(`[e2e] failure screenshot unavailable: ${err}`);
    }
  },

  onComplete() {
    teardownEnvironment();
    // User onComplete hooks run before the service's, so the watchdog is
    // armed regardless of how service teardown goes. It reaps the app or
    // driver if either outlives the run (they hold the stdout pipe) and
    // SIGKILLs this process if teardown wedges past 45s.
    armTeardownWatchdog(appBinary);
  },
};
