import path from "node:path";
import type { Options } from "@wdio/types";

import { appEntryPoint, chromedriverBinaryPath } from "./setup/fixtures.js";
import {
  armTeardownWatchdog,
  artifactsDir,
  prepareEnvironment,
  runId,
  teardownEnvironment,
} from "./setup/environment.js";

/**
 * Desktop E2E against the real Electron app (docs/testing.md). The app is
 * launched through wdio-electron-service: it points the local electron
 * binary at our CJS bundle, manages a chromedriver matching the Electron
 * version, and drives the app over WebDriver Classic.
 *
 * Headless: on Linux `just test-e2e` wraps the whole invocation in
 * `xvfb-run --auto-servernum`, so the app inherits a virtual display (the
 * service spawns chromedriver from the launcher/worker chain, which wdio's
 * per-worker autoXvfb wrapping does not cover).
 */
export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  // wdio worker/driver logs (always) + failure screenshots (afterTest).
  outputDir: artifactsDir,

  // Session-creation patience: 3 x 45s. A dead app is not fixed by more
  // retries — a fresh run is — and a bigger retry budget lets a wedged
  // startup burn the whole phase before the justfile timeout steps in.
  connectionRetryCount: 3,
  connectionRetryTimeout: 45000,
  waitforTimeout: 10000,
  // Per-test bound (mocha). Healthy tests take seconds; without this a
  // wedged test stalls its whole spec file. Bigger than any explicit
  // waitFor inside the tests so those fail with their own message first.
  mochaOpts: { timeout: 120000 },

  services: [
    [
      "electron",
      {
        // Unpackaged dev app: the service combines the electron binary from
        // this package's node_modules with our built main bundle.
        appEntryPoint,
        // Pin X11 explicitly: a Wayland desktop session is reachable through
        // the compositor socket in XDG_RUNTIME_DIR even under xvfb-run with
        // WAYLAND_DISPLAY unset, which would put test windows on the real
        // desktop. The ozone env hint alone is belt; this is braces.
        appArgs: ["--no-sandbox", "--ozone-platform=x11"],
      },
    ],
  ],

  capabilities: [
    {
      browserName: "electron",
      // Explicit, version-matched chromedriver — the service's own
      // downloader is broken (hangs mid-extraction); scripts/
      // fetch-chromedriver.sh provides the binary instead.
      "wdio:chromedriverOptions": {
        binary: chromedriverBinaryPath(),
      },
    } as never,
  ],

  onPrepare() {
    // Unique scratch dir per run; stale processes cleared first. Runs before
    // the service spawns the driver, so the env below reaches the app
    // through the chromedriver spawn chain.
    prepareEnvironment(process.env.E2E_SEED_LIBRARY === "1");
    // Arm the teardown watchdog HERE, not only in onComplete: an aborted or
    // killed launcher never reaches onComplete, and the watchdog sweeps the
    // moment its parent disappears — an interrupted run cannot leak app,
    // sidecar, driver, or Xvfb processes. The sweep only kills processes
    // that predate the watchdog, so the next phase's processes are safe.
    armTeardownWatchdog();
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
    // armed regardless of how service teardown goes. It reaps the app,
    // sidecar, or chromedriver if any outlives the run (they hold the stdout
    // pipe) and SIGKILLs this process if teardown wedges past 45s.
    armTeardownWatchdog();
  },
};
