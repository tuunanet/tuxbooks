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
    type: "error" | "warning";
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

interface RecoveryDialog {
  type: "error" | "warning";
  title: string;
  message: string;
  detail: string;
}

/**
 * Show one recovery dialog with the single "Open data folder" button, opening
 * the data root when it is chosen. Never throws: a dialog that cannot open
 * must not crash the recovery path.
 */
async function showRecoveryDialog(
  deps: Pick<StartupRecoveryDeps, "dialog" | "shell" | "paths">,
  options: RecoveryDialog,
): Promise<void> {
  try {
    const { response } = await deps.dialog.showMessageBox({
      ...options,
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
 * Show the native error dialog with the plain failure sentence and the log
 * path, and open the data root when its one button is chosen. Never throws.
 */
export async function showStartupErrorDialog(
  deps: Pick<StartupRecoveryDeps, "dialog" | "shell" | "paths">,
  failure: unknown,
): Promise<void> {
  await showRecoveryDialog(deps, {
    type: "error",
    title: "TuxBooks could not start",
    message: `TuxBooks could not start. ${describeStartupFailure(failure)}.`,
    detail: `A startup error log was written to:\n${startupErrorLogPath(deps.paths.dataDir)}`,
  });
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
  safeStderr(deps, message);
  await showStartupErrorDialog(deps, failure);
}

/**
 * Startup database quarantine (data-management spec): where a broken
 * database was found and where the sidecar moved it. Reported before the
 * window opens so the user knows the old file was kept.
 */
export interface QuarantineReport {
  from: string;
  to: string;
}

/** The read-only sidecar call the recovery report needs; injected from main. */
export interface StartupSidecarSurface {
  call(method: string): Promise<unknown>;
}

export interface StartupQuarantineDeps extends Pick<
  StartupRecoveryDeps,
  "dialog" | "shell" | "paths"
> {
  sidecar: StartupSidecarSurface;
  stderr: (message: string) => void;
}

/**
 * Read the sidecar's startup-recovery report. Null, missing, or malformed
 * values read as no quarantine: only a non-empty from/to pair counts, so a
 * healthy database can never produce a dialog.
 */
export function parseQuarantineReport(value: unknown): QuarantineReport | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.from !== "string" || record.from.length === 0) return null;
  if (typeof record.to !== "string" || record.to.length === 0) return null;
  return { from: record.from, to: record.to };
}

/**
 * Tell the user the previous database was found broken and moved aside,
 * naming where it went. Never throws.
 */
export async function showQuarantineDialog(
  deps: Pick<StartupRecoveryDeps, "dialog" | "shell" | "paths">,
  report: QuarantineReport,
): Promise<void> {
  await showRecoveryDialog(deps, {
    type: "warning",
    title: "TuxBooks repaired its database",
    message: "TuxBooks found a damaged database and started a new one.",
    detail:
      `The damaged file was kept here:\n${report.to}\n\n` +
      "TuxBooks moved it and its WAL and shared-memory files aside; nothing was deleted.",
  });
}

/**
 * Query the sidecar for a startup quarantine and surface it. Returns the
 * report when one happened, or null when the database was healthy or the
 * query failed. Never throws: a missing report must not block the window.
 */
export async function surfaceStartupQuarantine(
  deps: StartupQuarantineDeps,
): Promise<QuarantineReport | null> {
  let result: unknown;
  try {
    result = await deps.sidecar.call("get_startup_recovery");
  } catch (error) {
    safeStderr(
      deps,
      `[recovery] could not read the startup recovery report: ${describeStartupFailure(error)}`,
    );
    return null;
  }
  const report = parseQuarantineReport(result);
  if (!report) return null;
  safeStderr(deps, `[recovery] quarantined a broken database: ${report.from} -> ${report.to}`);
  await showQuarantineDialog(deps, report);
  return report;
}

function safeStderr(deps: Pick<StartupQuarantineDeps, "stderr">, message: string): void {
  try {
    deps.stderr(message);
  } catch {
    // stderr can be closed under a GUI launch; startup continues.
  }
}
