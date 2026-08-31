/**
 * Single place responsible for E2E environment setup: a unique scratch dir
 * per run (database + library), fixture seeding, stale-process cleanup, and
 * the failure-artifact directory. Nothing here ever touches a real user
 * library — the app only sees `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { epubFixture, pdfFixture, repoRoot } from "./fixtures.js";

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

export function killStaleProcesses(appBinary: string): void {
  // A crashed run can leave the app (which outlives tauri-driver) or the
  // driver itself alive. Both would interfere with the next run: a leftover
  // app grabs the new automation session, a leftover driver holds ports.
  // Runs happen before the service spawns anything fresh, so this is safe.
  for (const target of [appBinary, "tauri-driver"]) {
    try {
      execFileSync("pkill", ["-f", target]);
    } catch {
      // pkill exits non-zero when nothing matched — that is the good case.
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

export function prepareEnvironment(appBinary: string, seeded: boolean): void {
  killStaleProcesses(appBinary);
  pruneOldArtifacts();

  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(libraryDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  if (seeded) {
    copyFileSync(epubFixture, path.join(libraryDir, "minimal.epub"));
    copyFileSync(pdfFixture, path.join(libraryDir, "minimal.pdf"));
  }

  // The app (spawned by tauri-driver) inherits these; production paths are
  // unaffected. Set before the service spawns the driver (config onPrepare
  // hooks run before service onPrepare hooks).
  process.env.TEST_DATABASE_PATH = databasePath;
  process.env.TEST_LIBRARY_PATH = libraryDir;
}

export function teardownEnvironment(): void {
  rmSync(scratchDir, { recursive: true, force: true });
}

/**
 * Arms the detached teardown watchdog (see setup/watchdog.mjs). Must be
 * called from the config's onComplete: user hooks run before the service
 * tears the driver down, so the watchdog is in place either way.
 */
export function armTeardownWatchdog(appBinaryPath: string): void {
  const watchdog = path.join(repoRoot, "e2e", "setup", "watchdog.mjs");
  const child = spawn(
    process.execPath,
    [watchdog, String(process.pid), "45000", scratchDir, appBinaryPath],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
