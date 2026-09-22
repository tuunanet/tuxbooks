import path from "node:path";

import type { StorageDirs } from "./storageSizing";

/**
 * Fatal startup recovery (data-management spec): when the sidecar cannot
 * start, main leaves a durable trace instead of quitting silently. The fs,
 * dialog, shell, and stderr surfaces are injected, so the policy unit-tests
 * without Electron and every action runs best effort: one failing surface
 * never hides the failure from the others.
 */

/** Startup error log filename, placed in the data root next to the database. */
export const STARTUP_ERROR_LOG = "startup-error.log";

/** The copy-paste recovery command printed to stderr and the log. */
export const RESET_DATA_COMMAND = "tuxbooks --reset-data";

/** The fs surface the recovery uses; injected from the main process. */
export interface StartupFsSurface {
  mkdirSync(dir: string, options: { recursive: boolean }): unknown;
  appendFileSync(file: string, data: string): void;
}

/** The native dialog surface the recovery uses; injected from main. */
export interface StartupDialogSurface {
  showMessageBox(options: {
    type: "error";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
  }): Promise<{ response: number }>;
}

/** The native shell surface the recovery uses; injected from main. */
export interface StartupShellSurface {
  openPath(fullPath: string): Promise<string>;
}

export interface StartupRecoveryDeps {
  fs: StartupFsSurface;
  dialog: StartupDialogSurface;
  shell: StartupShellSurface;
  stderr: (message: string) => void;
  paths: StorageDirs;
}

export function startupErrorLogPath(dataDir: string): string {
  return path.join(dataDir, STARTUP_ERROR_LOG);
}

/** One-line description of an unknown thrown value; empty messages fall back. */
export function describeStartupFailure(failure: unknown): string {
  if (failure instanceof Error) return failure.message || failure.name;
  if (typeof failure === "string") return failure;
  return String(failure);
}

/** The message written to the log and printed to stderr (one shared text). */
export function startupFailureMessage(failure: unknown, paths: StorageDirs): string {
  return (
    `TuxBooks could not start. Startup failure: ${describeStartupFailure(failure)}.` +
    ` Data directory: ${paths.dataDir}.` +
    ` Config directory: ${paths.configDir}.` +
    ` To recover, run: ${RESET_DATA_COMMAND}`
  );
}

/**
 * Append one timestamped line to the startup error log, creating the data
 * root if needed. Never throws: the log is diagnostics, and a read-only or
 * missing directory must not mask the failure from the dialog and stderr.
 */
export function writeStartupErrorLog(
  fs: StartupFsSurface,
  paths: StorageDirs,
  message: string,
  now: Date = new Date(),
): void {
  try {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.appendFileSync(startupErrorLogPath(paths.dataDir), `${now.toISOString()} ${message}\n`);
  } catch {
    // Diagnostics only; the other surfaces still run.
  }
}

/**
 * Show the native error dialog with the plain failure sentence and the log
 * path, and open the data root when its one button is chosen. Never throws.
 */
export async function showStartupErrorDialog(
  deps: Pick<StartupRecoveryDeps, "dialog" | "shell" | "paths">,
  failure: unknown,
): Promise<void> {
  try {
    const { response } = await deps.dialog.showMessageBox({
      type: "error",
      title: "TuxBooks could not start",
      message: `TuxBooks could not start. ${describeStartupFailure(failure)}.`,
      detail: `A startup error log was written to:\n${startupErrorLogPath(deps.paths.dataDir)}`,
      buttons: ["Open data folder"],
    });
    if (response === 0) {
      await deps.shell.openPath(deps.paths.dataDir);
    }
  } catch {
    // A dialog that cannot open must not crash the recovery path.
  }
}

/**
 * Report a fatal startup failure: a timestamped log line, the same message
 * on stderr for shell launches, and the native dialog. Resolves even when
 * every surface fails.
 */
export async function reportStartupFailure(
  deps: StartupRecoveryDeps,
  failure: unknown,
  now: Date = new Date(),
): Promise<void> {
  const message = startupFailureMessage(failure, deps.paths);
  writeStartupErrorLog(deps.fs, deps.paths, message, now);
  try {
    deps.stderr(message);
  } catch {
    // stderr can be closed under a GUI launch; the dialog still runs.
  }
  await showStartupErrorDialog(deps, failure);
}
