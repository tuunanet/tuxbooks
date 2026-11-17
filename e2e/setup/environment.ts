/**
 * Single place responsible for E2E environment setup: a unique scratch dir
 * per run (database + library), fixture seeding, stale-process cleanup, and
 * the failure-artifact directory. Nothing here ever touches a real user
 * library — the app only sees `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { sweepProcesses } from "./sweep.mjs";

import {
  benchEpubFixture,
  benchPdfFixture,
  electronDistPath,
  densePdfFixture,
  epubFixture,
  readerRegressionFixtures,
  libraryBenchCorpusDir,
  LIBRARY_THUMB_PART_COUNT,
  libraryThumbCorpusDir,
  libraryThumbPartDir,
  largePdfFixture,
  LIBRARY_CORPUS_BOOK_COUNT,
  mixedPdfFixture,
  pdfFixture,
  repoRoot,
  sidecarBinaryPath,
  smartPdfFixture,
  thumbCapturePdfFixture,
} from "./fixtures.js";

/** Unique per invocation; the launcher (or playwright.config) sets it. */
process.env.E2E_RUN_ID ??= `${process.env.E2E_PHASE ?? "run"}-${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}-${process.pid.toString(36)}`;

export const runId = process.env.E2E_RUN_ID;

/** Screenshots and logs from failed tests land here (never committed). */
export const artifactsDir = path.join(repoRoot, "artifacts", "e2e", runId);

/** Isolated scratch environment the app runs against. */
// pid+timestamp keeps the name unique; a 0700 tree with "wx"/0600 files is what makes shared-tmp writes safe.
export const scratchDir = path.join(os.tmpdir(), `tuxbooks-e2e-${runId}`);
export const libraryDir = path.join(scratchDir, "library");
export const databasePath = path.join(scratchDir, "tuxbooks.db");
export const configDir = path.join(scratchDir, "config");

/**
 * The library-scale corpus (issue #61): generated into its own directory —
 * deliberately outside the watched `libraryDir`, so only the scale spec's
 * bulk import brings it in and the other seeded suites never see it.
 */
export const scaleCorpusDir = path.join(scratchDir, "scale-corpus");
/** How many books the scale corpus carries (issue #61 plan, phase 3). */
export const SCALE_CORPUS_SIZE = 1500;

export function killStaleProcesses(): void {
  // Wedged leftovers hold the single-instance lock or keep watching the old
  // library, so SIGKILL rather than TERM. The sweep matches /proc/<pid>/exe.
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
    } catch {}
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
    } catch {}
  }
}

/** Run the deterministic EPUB corpus generator into `dir`. */
function runEpubCorpusGenerator(dir: string, count: number, withCovers: boolean): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("python3", [
    path.join(repoRoot, "scripts", "make-epub-corpus.py"),
    ...(withCovers ? ["--cover"] : []),
    dir,
    String(count),
  ]);
}

/**
 * The opt-in library benchmark generates its corpus before the app launches.
 * The fixture path and count live with the other test fixtures; the spec
 * reads the same constants, so setup and assertions cannot drift.
 */
function generateLibraryBenchCorpus(): void {
  runEpubCorpusGenerator(libraryBenchCorpusDir, LIBRARY_CORPUS_BOOK_COUNT, true);
}

/**
 * Same corpus shape for the thumb-drag regression loop (tuxbooks-y9s), but
 * without covers: card geometry is CSS-fixed, and the cheaper import keeps
 * the regression loop quick.
 *
 * The books are partitioned into subdirectories afterwards: importing a
 * plain file makes its parent take the folder treatment (scan + watch,
 * ADR 0009), so N flat files in one directory cost N full directory
 * scans — quadratic. One directory import per part is the shape the app's
 * own folder flow uses.
 */
function generateLibraryThumbCorpus(): void {
  runEpubCorpusGenerator(libraryThumbCorpusDir, LIBRARY_CORPUS_BOOK_COUNT, false);
  const partCount = LIBRARY_THUMB_PART_COUNT;
  for (let part = 0; part < partCount; part += 1) {
    rmSync(libraryThumbPartDir(part), { recursive: true, force: true });
    mkdirSync(libraryThumbPartDir(part), { recursive: true });
  }
  const books = readdirSync(libraryThumbCorpusDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".epub"))
    .sort((a, b) => a.name.localeCompare(b.name));
  books.forEach((entry, index) => {
    const target = libraryThumbPartDir(index % partCount);
    renameSync(path.join(libraryThumbCorpusDir, entry.name), path.join(target, entry.name));
  });
}

function seedRegressionFixtures(): void {
  if (process.env.E2E_PHASE !== "regressions") return;
  for (const fixture of readerRegressionFixtures) {
    copyFileSync(fixture.path, path.join(libraryDir, path.basename(fixture.path)));
  }
  // Cross-section jumps need a dense book; a failed generation skips the spec.
  try {
    execFileSync("python3", [
      path.join(repoRoot, "scripts", "make-dense-epub.py"),
      path.join(libraryDir, "reader-dense-sections.epub"),
    ]);
  } catch (err) {
    console.warn(
      "[e2e] dense fixture generation failed; the seek-flash spec will skip:",
      err instanceof Error ? err.message : err,
    );
  }
}

function seedScaleCorpus(): void {
  if (process.env.E2E_PHASE !== "seeded") return;
  mkdirSync(scaleCorpusDir, { recursive: true });
  const generator = path.join(repoRoot, "scripts", "make-epub-corpus.py");
  try {
    execFileSync("python3", [generator, scaleCorpusDir, String(SCALE_CORPUS_SIZE)]);
  } catch (err) {
    console.warn(
      `[e2e] scale corpus generation failed; library-scale.e2e.ts will skip:`,
      err instanceof Error ? err.message : err,
    );
    rmSync(scaleCorpusDir, { recursive: true, force: true });
  }
}

function seedSeededFixtures(): void {
  copyFileSync(epubFixture, path.join(libraryDir, "minimal.epub"));
  seedRegressionFixtures();
  copyFileSync(pdfFixture, path.join(libraryDir, "minimal.pdf"));
  copyFileSync(largePdfFixture, path.join(libraryDir, "large.pdf"));
  copyFileSync(mixedPdfFixture, path.join(libraryDir, "mixed.pdf"));
  copyFileSync(smartPdfFixture, path.join(libraryDir, "smart.pdf"));
  copyFileSync(densePdfFixture, path.join(libraryDir, "dense.pdf"));
  // GeoTopo seeds only when the free corpus is present.
  if (existsSync(benchPdfFixture)) {
    copyFileSync(benchPdfFixture, path.join(libraryDir, "GeoTopo.pdf"));
  }
  seedScaleCorpus();
}

function seedBenchFixtures(): void {
  if (process.env.E2E_PHASE !== "bench") return;
  for (const [source, name] of [
    [benchPdfFixture, "GeoTopo.pdf"],
    [benchEpubFixture, "page-blanche.epub"],
    ...(process.env.FAR_DRAG_BOOK_TITLE
      ? [[thumbCapturePdfFixture, "thumb-capture-mixed.pdf"] as const]
      : []),
  ] as const) {
    if (existsSync(source)) {
      copyFileSync(source, path.join(libraryDir, name));
    } else {
      console.warn(`[e2e] bench fixture missing, skipping: ${source}`);
    }
  }
}

function seedCaptureFixture(): void {
  if (process.env.E2E_PHASE === "capture") {
    copyFileSync(thumbCapturePdfFixture, path.join(libraryDir, "thumb-capture-mixed.pdf"));
  }
}

function seedPhaseFixtures(seeded: boolean): void {
  if (seeded) seedSeededFixtures();
  seedBenchFixtures();
  seedCaptureFixture();
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

  mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

  if (process.env.E2E_PHASE === "bench-library") generateLibraryBenchCorpus();
  if (process.env.E2E_PHASE === "library-thumb") generateLibraryThumbCorpus();

  seedPhaseFixtures(seeded);

  // Set before launch and re-asserted there so a worker restart cannot lose them.
  process.env.TEST_DATABASE_PATH = databasePath;
  process.env.TEST_LIBRARY_PATH = libraryDir;
  // App userData must never touch the real config; a fresh dir also makes
  // window placement start at the Electron default, deterministically.
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
  // E2E_XVFB=1 marks the headless wrapper: DISPLAY then names this phase's
  // private Xvfb, which the watchdog reaps if the launcher dies.
  const display = process.env.E2E_XVFB === "1" ? (process.env.DISPLAY ?? "") : "";
  const targets = [electronDistPath, sidecarBinaryPath];
  const child = spawn(
    process.execPath,
    [watchdog, String(process.pid), scratchDir, targets.join("\u001f"), display],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
