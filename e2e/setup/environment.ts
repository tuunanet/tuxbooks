/**
 * Single place responsible for E2E environment setup: a unique scratch dir
 * per run (database + library), fixture seeding, stale-process cleanup, and
 * the failure-artifact directory. Nothing here ever touches a real user
 * library — the app only sees `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  benchEpubFixture,
  benchPdfFixture,
  epubFixture,
  largePdfFixture,
  mixedPdfFixture,
  pdfFixture,
  processTargets,
  repoRoot,
} from "./fixtures.js";

/** Unique per invocation; the launcher sets it and workers inherit it. */
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
  // helper), its sidecar, chromedriver, or orphaned wdio workers alive. All
  // would interfere with the next run: a leftover app grabs the new
  // automation session, a leftover driver holds ports, a leftover worker
  // holds a dead session. SIGKILL, not the default SIGTERM — these are
  // wedged leftovers, and the sweep must not depend on a wedged process
  // honoring TERM. Runs happen before the service spawns anything fresh, so
  // this is safe.
  for (const target of processTargets) {
    try {
      execFileSync("pkill", ["-9", "-f", target]);
    } catch {
      // pkill exits non-zero when nothing matched — that is the good case.
    }
  }
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

  // The benchmark phase (just bench-reader) seeds only the real-book
  // fixtures: the suite measures render/turn latency, and the synthetic
  // fixtures would dilute it. The fixtures are gitignored real files — a
  // machine missing one benches the formats it has (the bench suite skips
  // its missing-fixture scenarios with a notice).
  if (process.env.E2E_PHASE === "bench") {
    for (const [source, name] of [
      [benchPdfFixture, "AI_Agents_and_Applications.pdf"],
      [benchEpubFixture, "AI_Agents_and_Applications.epub"],
    ] as const) {
      if (existsSync(source)) {
        copyFileSync(source, path.join(libraryDir, name));
      } else {
        console.warn(`[e2e] bench fixture missing, skipping: ${source}`);
      }
    }
  }

  // The app (spawned by tauri-driver) inherits these; production paths are
  // unaffected. Set before the service spawns the driver (config onPrepare
  // hooks run before service onPrepare hooks).
  process.env.TEST_DATABASE_PATH = databasePath;
  process.env.TEST_LIBRARY_PATH = libraryDir;
  // Same isolation rule for the app-config dir: the window-state plugin
  // would otherwise restore (and overwrite!) the real user's saved window
  // geometry, making every window-derived expectation depend on whatever
  // size the developer's last real session saved. A fresh config dir means
  // the window starts at the tauri.conf.json default, deterministically.
  process.env.XDG_CONFIG_HOME = configDir;
}

export function teardownEnvironment(): void {
  rmSync(scratchDir, { recursive: true, force: true });
}

/**
 * Arms the detached teardown watchdog (see setup/watchdog.mjs): it sweeps
 * this run's processes the moment the launcher dies — however it dies. The
 * config arms it in onPrepare (before anything spawns, covering aborts) and
 * again in onComplete (belt and braces; a second watcher is harmless).
 */
export function armTeardownWatchdog(): void {
  const watchdog = path.join(repoRoot, "e2e", "setup", "watchdog.mjs");
  // E2E_XVFB=1 marks the headless wrapper: DISPLAY then names the private
  // Xvfb of this phase, which the watchdog reaps if the launcher dies
  // before xvfb-run could clean up. Headed runs pass no display.
  const display = process.env.E2E_XVFB === "1" ? (process.env.DISPLAY ?? "") : "";
  const child = spawn(
    process.execPath,
    [watchdog, String(process.pid), scratchDir, processTargets.join("\u001f"), display],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
