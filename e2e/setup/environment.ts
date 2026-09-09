/**
 * Single place responsible for E2E environment setup: a unique scratch dir
 * per run (database + library), fixture seeding, stale-process cleanup, and
 * the failure-artifact directory. Nothing here ever touches a real user
 * library — the app only sees `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { sweepProcesses } from "./sweep.mjs";

import {
  benchEpubFixture,
  benchPdfFixture,
  electronDistPath,
  epubFixture,
  largePdfFixture,
  mixedPdfFixture,
  pdfFixture,
  repoRoot,
  sidecarBinaryPath,
} from "./fixtures.js";

/** Unique per invocation; the launcher (or playwright.config) sets it. */
process.env.E2E_RUN_ID ??= `${process.env.E2E_PHASE ?? "run"}-${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}-${process.pid.toString(36)}`;

export const runId = process.env.E2E_RUN_ID;

/** Screenshots and logs from failed tests land here (never committed). */
export const artifactsDir = path.join(repoRoot, "artifacts", "e2e", runId);

/** Isolated scratch environment the app runs against. */
export const scratchDir = path.join(os.tmpdir(), `tuxbooks-e2e-${runId}`);
export const libraryDir = path.join(scratchDir, "library");
export const databasePath = path.join(scratchDir, "tuxbooks.db");
export const configDir = path.join(scratchDir, "config");

export function killStaleProcesses(): void {
  // A crashed run can leave the app tree (including the dist's crashpad
  // helper) or its sidecar alive. Both would interfere with the next run: a
  // leftover app holds the single-instance lock, a leftover sidecar keeps
  // watching the old library. SIGKILL — these are wedged leftovers, and the
  // sweep must not depend on a wedged process honoring TERM. The sweep
  // matches by /proc/<pid>/exe (setup/sweep.mjs), so a process that merely
  // mentions a target path in its argv — a recipe shell carrying
  // TUXBOOKS_SIDECAR=<path> — is never caught. Runs happen before anything
  // spawns fresh, so this is safe.
  sweepProcesses({ electronDist: electronDistPath, sidecar: sidecarBinaryPath });
}

/**
 * Scratch dirs older than this cannot belong to a live run (a phase is
 * bounded at 600s by the justfile timeout): only a machine crash or a kill
 * that lands before the watchdog arms can leave one behind. The age cutoff
 * keeps concurrent-run collisions (already forbidden) impossible.
 */
const SCRATCH_RETENTION_MS = 24 * 60 * 60 * 1000;

function pruneOldScratchDirs(): void {
  let entries: string[];
  try {
    entries = readdirSync(os.tmpdir());
  } catch {
    return;
  }
  const cutoff = Date.now() - SCRATCH_RETENTION_MS;
  for (const entry of entries) {
    if (!entry.startsWith("tuxbooks-e2e-")) continue;
    const dir = path.join(os.tmpdir(), entry);
    try {
      if (statSync(dir).mtimeMs < cutoff) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Unreadable or already-gone entry — leave it alone.
    }
  }
}

/** Failure artifacts older than this are pruned so the dir stays bounded. */
const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function pruneOldArtifacts(): void {
  const root = path.join(repoRoot, "artifacts", "e2e");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - ARTIFACT_RETENTION_MS;
  for (const entry of entries) {
    try {
      if (statSync(path.join(root, entry)).mtimeMs < cutoff) {
        rmSync(path.join(root, entry), { recursive: true, force: true });
      }
    } catch {
      // Unreadable entry — leave it alone.
    }
  }
}

/**
 * Prepare the isolated scratch environment for one invocation. Playwright's
 * globalSetup calls this exactly once per run; workers inherit the
 * environment through process.env (re-set here and in the launch fixture).
 */
export function prepareEnvironment(seeded: boolean): void {
  killStaleProcesses();
  pruneOldArtifacts();
  pruneOldScratchDirs();

  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(libraryDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  if (seeded) {
    copyFileSync(epubFixture, path.join(libraryDir, "minimal.epub"));
    copyFileSync(pdfFixture, path.join(libraryDir, "minimal.pdf"));
    copyFileSync(largePdfFixture, path.join(libraryDir, "large.pdf"));
    copyFileSync(mixedPdfFixture, path.join(libraryDir, "mixed.pdf"));
  }

  // The benchmark phase (just bench-reader) seeds only the free-corpus
  // fixtures (just fetch-ebooks): the suite measures render/turn latency,
  // and the synthetic fixtures would dilute it. A machine missing one
  // benches the formats it has (the bench suite skips its missing-fixture
  // scenarios with a notice).
  if (process.env.E2E_PHASE === "bench") {
    for (const [source, name] of [
      [benchPdfFixture, "GeoTopo.pdf"],
      [benchEpubFixture, "page-blanche.epub"],
    ] as const) {
      if (existsSync(source)) {
        copyFileSync(source, path.join(libraryDir, name));
      } else {
        console.warn(`[e2e] bench fixture missing, skipping: ${source}`);
      }
    }
  }

  // The app (spawned by the Playwright Electron launcher) inherits these;
  // production paths are unaffected. Set before the fixture launches the
  // app — and re-asserted there so a worker restart can never lose them.
  process.env.TEST_DATABASE_PATH = databasePath;
  process.env.TEST_LIBRARY_PATH = libraryDir;
  // Same isolation rule for the app-config dir: the app's Electron userData
  // (Chromium caches, crashpad state) must never touch the real user's
  // config, and window-derived expectations stay independent of whatever
  // the developer's real desktop sessions left behind. A fresh config dir
  // means the window starts at the Electron main default, deterministically.
  process.env.XDG_CONFIG_HOME = configDir;
}

export function teardownEnvironment(): void {
  rmSync(scratchDir, { recursive: true, force: true });
}

/**
 * Arms the detached teardown watchdog (see setup/watchdog.mjs): it sweeps
 * this run's processes the moment the Playwright process dies — however it
 * dies. Playwright's own teardown closes the launched app; the watchdog
 * covers the paths Playwright cannot guarantee: an aborted/killed runner
 * (Ctrl+C at the wrong moment, OOM, segfault) never reaches globalTeardown,
 * and the sweep fires the moment the parent disappears. The sweep only
 * kills processes that predate the watchdog, so the next phase's processes
 * are safe.
 */
export function armTeardownWatchdog(): void {
  const watchdog = path.join(repoRoot, "e2e", "setup", "watchdog.mjs");
  // E2E_XVFB=1 marks the headless wrapper: DISPLAY then names the private
  // Xvfb of this phase, which the watchdog reaps if the launcher dies
  // before xvfb-run could clean up. Headed runs pass no display.
  const display = process.env.E2E_XVFB === "1" ? (process.env.DISPLAY ?? "") : "";
  const targets = [electronDistPath, sidecarBinaryPath];
  const child = spawn(
    process.execPath,
    [watchdog, String(process.pid), scratchDir, targets.join("\u001f"), display],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
