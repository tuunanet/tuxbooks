import path from "node:path";
import { statSync, writeFileSync } from "node:fs";
import type { Options } from "@wdio/types";

import {
  appEntryPoint,
  chromedriverCacheDir,
  ensureChromedriver,
  pruneIncompleteDriverCache,
} from "./setup/fixtures.js";
import {
  armTeardownWatchdog,
  artifactsDir,
  prepareEnvironment,
  runId,
  teardownEnvironment,
} from "./setup/environment.js";
import {
  assertDriverCompatibility,
  formatVersionBanner,
  stackVersions,
  writeEnvironmentRecord,
} from "./setup/versions.js";

/**
 * Desktop E2E against the real Electron app (docs/testing.md). The app is
 * launched through @wdio/electron-service (the first-party successor of the
 * deprecated unscoped wdio-electron-service): it points the local electron
 * binary at our CJS bundle, resolves a chromedriver matching the Electron
 * version, and drives the app over WebDriver Classic. The driver is
 * service-managed and cached in a pinned, gitignored directory; a worker
 * sanity check fails fast on a driver/Electron major mismatch.
 *
 * Headless: on Linux `just test-e2e` wraps the whole invocation in
 * `xvfb-run --auto-servernum`, so the app inherits a virtual display (the
 * service spawns chromedriver from the launcher/worker chain, which wdio's
 * per-worker autoXvfb wrapping does not cover).
 */

const versions = stackVersions();

// A high-DPI/high-refresh desktop is part of the reference conditions
// (docs/performance.md); the hidpi phase (just test-e2e-hidpi) forces a
// device scale factor through this Chromium switch.
const deviceScaleFactor = Number(process.env.E2E_DEVICE_SCALE_FACTOR ?? "");
const appArgs = ["--no-sandbox", "--ozone-platform=x11"];
if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
  appArgs.push(`--force-device-scale-factor=${deviceScaleFactor}`);
}

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  // wdio worker/driver logs (always, including the captured Electron
  // main/renderer console output) + failure screenshots/metadata (afterTest).
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
        // Main + renderer console output is forwarded into the wdio logs
        // with [Electron:MainProcess] / [Electron:Renderer] prefixes —
        // failures must be diagnosable from CI artifacts alone
        // (docs/testing.md). Main-process capture uses the CDP bridge and
        // needs the default-enabled inspect fuse; renderer capture works
        // regardless.
        captureMainProcessLogs: true,
        captureRendererLogs: true,
        // Pin X11 explicitly: a Wayland desktop session is reachable through
        // the compositor socket in XDG_RUNTIME_DIR even under xvfb-run with
        // WAYLAND_DISPLAY unset, which would put test windows on the real
        // desktop. The ozone env hint alone is belt; this is braces.
        appArgs,
      },
    ],
  ],

  capabilities: [
    {
      browserName: "electron",
      // Service-managed chromedriver (docs/testing.md): the service derives
      // the Electron version from the installed electron package and hands
      // wdio-utils a matching build id; the cache dir is pinned to a
      // gitignored, repo-local path so a stale shared-tmpdir driver can
      // never leak into a run, and the sweep/watchdog can target one precise
      // directory. Driver/Electron compatibility is asserted per session in
      // the `before` hook (setup/versions.ts).
      "wdio:chromedriverOptions": {
        cacheDir: chromedriverCacheDir,
      },
    } as never,
  ],

  onPrepare() {
    // Self-heal the driver cache: prune incomplete entries (an interrupted
    // download must not poison later runs) and fetch the build the service
    // resolved when it is missing. Both precede the launcher's own driver
    // setup, which skips its broken downloader when a complete entry exists.
    pruneIncompleteDriverCache();
    ensureChromedriver();
    // Unique scratch dir per run; stale processes cleared first. Runs before
    // the service spawns the driver, so the env below reaches the app
    // through the chromedriver spawn chain.
    prepareEnvironment(process.env.E2E_SEED_LIBRARY === "1");
    // Version determinism (docs/testing.md): the launcher-side stack record
    // — Electron, its Chromium mapping, WebdriverIO, the service — logged
    // and written to the run's artifacts. The connected chromedriver version
    // is appended by the worker `before` hook once the session exists.
    console.log(formatVersionBanner(versions));
    writeEnvironmentRecord(path.join(artifactsDir, "environment.json"), versions, {
      runId,
      phase: process.env.E2E_PHASE ?? "run",
      seeded: process.env.E2E_SEED_LIBRARY === "1",
      deviceScaleFactor:
        Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? deviceScaleFactor : 1,
      appArgs,
    });
    // Arm the teardown watchdog HERE, not only in onComplete: an aborted or
    // killed launcher never reaches onComplete, and the watchdog sweeps the
    // moment its parent disappears — an interrupted run cannot leak app,
    // sidecar, driver, or Xvfb processes. The sweep only kills processes
    // that predate the watchdog, so the next phase's processes are safe.
    armTeardownWatchdog();
  },

  async before(_capabilities, _specs) {
    // Worker-side stack record: the chromedriver that actually connected.
    // Driver logging through console.log lands in the wdio worker log.
    const caps = browser.capabilities as {
      chrome?: { chromedriverVersion?: string };
      "wdio:chromiumVersion"?: string;
      browserVersion?: string;
    };
    console.log(
      `[e2e] session versions: chromedriver=${caps.chrome?.chromedriverVersion ?? "unknown"}` +
        ` chromium=${caps["wdio:chromiumVersion"] ?? caps.browserVersion ?? "unknown"}`,
    );
    assertDriverCompatibility(browser.capabilities);

    // Isolation gate (docs/testing.md): a launcher-side failure in
    // onPrepare (hook errors are logged, then the run CONTINUES) must never
    // degrade into silently testing against the user's real library. The
    // scratch database must exist and have the schema written by the
    // sidecar by the time the first session is up.
    const dbPath = process.env.TEST_DATABASE_PATH ?? "";
    if (!dbPath.includes("tuxbooks-e2e-")) {
      throw new Error(
        "E2E isolation broken: TEST_DATABASE_PATH does not point at this run's scratch dir",
      );
    }
    await browser.waitUntil(
      () => {
        try {
          return statSync(dbPath).size > 0;
        } catch {
          return false;
        }
      },
      {
        timeout: 10_000,
        timeoutMsg: "the sidecar never wrote the scratch database — isolation cannot be verified",
      },
    );
  },

  afterTest(test, _context, result) {
    if (result.passed) return;
    const sanitized = test.title.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
    // Screenshot-only-on-failure debugging aid; no visual baselines. Best
    // effort: the screenshot itself fails when the app died.
    try {
      browser.saveScreenshot(path.join(artifactsDir, `${runId}-${sanitized}.png`));
    } catch (err) {
      console.warn(`[e2e] failure screenshot unavailable: ${err}`);
    }
    // Failure metadata (docs/testing.md): what failed, where, and against
    // which stack — so CI artifacts answer "React, Electron, engine, IPC,
    // or harness?" without a local reproduction. Electron main/renderer
    // console output rides in the wdio logs next to this file.
    try {
      const failure = {
        runId,
        suite: test.parent,
        test: test.title,
        file: test.file ?? null,
        error: result.error
          ? { message: result.error.message, stack: result.error.stack ?? null }
          : null,
        stack: versions,
        session: {
          chromedriver:
            (browser.capabilities as { chrome?: { chromedriverVersion?: string } }).chrome
              ?.chromedriverVersion ?? null,
        },
        at: new Date().toISOString(),
      };
      writeFileSync(
        path.join(artifactsDir, `failure-${runId}-${sanitized}.json`),
        JSON.stringify(failure, null, 2),
      );
    } catch (err) {
      console.warn(`[e2e] failure metadata unavailable: ${err}`);
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
