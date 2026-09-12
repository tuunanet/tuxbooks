/**
 * Playwright configuration for the desktop E2E suite (docs/TESTING.md).
 *
 * Run modes map to projects, one Electron invocation per phase, exactly
 * like the previous harness:
 *
 *   empty   — library.e2e.ts (app shell, sidebar, empty state, settings)
 *   seeded  — all application suites against the seeded scratch library
 *   shell   — desktop-shell.e2e.ts: native window lifecycle + branding
 *             (own phase: the relaunch scenario closes and relaunches the
 *             app, which must not share a worker with other suites)
 *   gpu     — gpu-fallback.e2e.ts: the GPU-crash fallback policy
 *             (own phase: it relaunches the app with different marker
 *             states and must not share a worker with other suites)
 *   hidpi   — seeded reader scenarios at devicePixelRatio 2
 *   bench   — the opt-in, headed performance benchmark (never CI)
 *
 * The environment is phase-global (E2E_PHASE / E2E_SEED_LIBRARY /
 * E2E_DEVICE_SCALE_FACTOR, set by the justfile recipes): globalSetup
 * provisions one scratch dir per invocation and every phase project runs
 * serialized (workers: 1) — correctness first, parallelism only after the
 * fixture architecture proves it safe.
 */
import path from "node:path";
import { defineConfig } from "@playwright/test";

import { artifactsDir } from "./setup/environment.js";

const ci = Boolean(process.env.CI);

/** Project spec filters: which spec files each phase runs. */
const SEEDED_EXCLUDE = [
  "library.e2e.ts",
  "desktop-shell.e2e.ts",
  "gpu-fallback.e2e.ts",
  "hidpi.e2e.ts",
  "bench-reader.e2e.ts",
];

function project(testMatch: string[], ignore: string[] = []) {
  return {
    testMatch: testMatch.map((pattern) => path.join("**", pattern)),
    testIgnore: ignore.map((pattern) => path.join("**", pattern)),
  };
}

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./setup/global-setup.ts",
  globalTeardown: "./setup/global-teardown.ts",

  // One Electron session at a time — the phase's tests share the app and
  // the scratch library, so file order matters and two concurrent apps
  // would fight over the single-instance lock and the scratch DB.
  workers: 1,
  fullyParallel: false,

  // Per-test bound. Healthy tests take seconds; without this a wedged test
  // stalls its whole spec file. Bigger than any explicit wait inside the
  // tests so those fail with their own message first.
  timeout: 120_000,
  expect: { timeout: 10_000 },

  // Retries are a CI diagnostics aid, not a stability strategy (docs/
  // TESTING.md): local runs are strict, CI gets one retry so a flaky
  // failure still produces a trace for investigation.
  retries: ci ? 1 : 0,

  outputDir: path.join(artifactsDir, "playwright-output"),

  // Failure artifacts (docs/TESTING.md): trace + screenshot on failure,
  // next to the console logs the launch fixture writes.
  use: {
    trace: { mode: "retain-on-failure" },
    screenshot: "only-on-failure",
  },

  reporter: [["list"], ["json", { outputFile: path.join(artifactsDir, "playwright-report.json") }]],

  projects: [
    { name: "empty", ...project(["library.e2e.ts"]) },
    { name: "shell", ...project(["desktop-shell.e2e.ts"]) },
    { name: "gpu", ...project(["gpu-fallback.e2e.ts"]) },
    { name: "seeded", ...project(["*.e2e.ts"], SEEDED_EXCLUDE) },
    { name: "hidpi", ...project(["hidpi.e2e.ts"]) },
    { name: "bench", ...project(["bench-reader.e2e.ts"]) },
  ],
});
