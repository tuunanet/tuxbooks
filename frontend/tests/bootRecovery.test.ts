import { describe, expect, it, vi } from "vitest";

import {
  reportStartupFailure,
  RESET_DATA_COMMAND,
  STARTUP_ERROR_LOG,
  startupErrorLogPath,
  type StartupDialogSurface,
  type StartupRecoveryDeps,
} from "../../electron/main/bootRecovery";

/**
 * Startup recovery unit tests (data-management spec): the fatal sidecar
 * failure reaches the log, stderr, and the native dialog, and no single
 * failing surface can throw or suppress the others. The fs, dialog, shell,
 * and stderr surfaces are all fakes, so nothing here needs Electron.
 */

const PATHS = { dataDir: "/app/data", configDir: "/app/config" };
const T0 = new Date("2026-09-22T08:00:00.000Z");
const FAILURE = "sidecar exited unexpectedly (code=1 signal=null)";

type DialogOptions = Parameters<StartupDialogSurface["showMessageBox"]>[0];

function harness(overrides: Partial<StartupRecoveryDeps> = {}): {
  deps: StartupRecoveryDeps;
  log: ReturnType<typeof vi.fn>;
  showMessageBox: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
  stderr: ReturnType<typeof vi.fn>;
} {
  const log = vi.fn();
  const showMessageBox = vi.fn(async () => ({ response: 0 }));
  const openPath = vi.fn(async () => "");
  const stderr = vi.fn();
  const deps: StartupRecoveryDeps = {
    fs: { mkdirSync: vi.fn(), appendFileSync: log },
    dialog: { showMessageBox },
    shell: { openPath },
    stderr,
    paths: PATHS,
    ...overrides,
  };
  return { deps, log, showMessageBox, openPath, stderr };
}

function report(deps: StartupRecoveryDeps, failure: unknown = FAILURE): Promise<void> {
  return reportStartupFailure(deps, failure, T0);
}

describe("startup failure recovery", () => {
  it("writes a timestamped log line naming the failure and both resolved paths", async () => {
    const { deps, log } = harness();

    await report(deps);

    expect(log).toHaveBeenCalledOnce();
    const [file, line] = log.mock.calls[0]!;
    expect(file).toBe(startupErrorLogPath(PATHS.dataDir));
    expect(file.endsWith(STARTUP_ERROR_LOG)).toBe(true);
    expect(line).toContain(T0.toISOString());
    expect(line).toContain(FAILURE);
    expect(line).toContain(PATHS.dataDir);
    expect(line).toContain(PATHS.configDir);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toContain("\n");
  });

  it("names the failure in the dialog and shows the log path with one open-folder button", async () => {
    const { deps, showMessageBox, openPath } = harness();

    await report(deps);

    expect(showMessageBox).toHaveBeenCalledOnce();
    const options = showMessageBox.mock.calls[0]![0] as DialogOptions;
    expect(options.type).toBe("error");
    expect(options.message).toContain(FAILURE);
    expect(options.detail).toContain(startupErrorLogPath(PATHS.dataDir));
    expect(options.buttons).toEqual(["Open data folder"]);
    expect(openPath).toHaveBeenCalledWith(PATHS.dataDir);
  });

  it("does not open the data root when the dialog is dismissed another way", async () => {
    const { deps, openPath } = harness({
      dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
    });

    await report(deps);

    expect(openPath).not.toHaveBeenCalled();
  });

  it("prints the same message to stderr with both paths and the reset command", async () => {
    const { deps, stderr } = harness();

    await report(deps);

    expect(stderr).toHaveBeenCalledOnce();
    const message = stderr.mock.calls[0]![0];
    expect(message).toContain(FAILURE);
    expect(message).toContain(PATHS.dataDir);
    expect(message).toContain(PATHS.configDir);
    expect(message).toContain(RESET_DATA_COMMAND);
  });

  it("does not throw when the log write fails, and still shows the dialog", async () => {
    const { deps, showMessageBox } = harness({
      fs: {
        mkdirSync: vi.fn(),
        appendFileSync: vi.fn(() => {
          throw new Error("read-only data dir");
        }),
      },
    });

    await expect(report(deps)).resolves.toBeUndefined();

    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it("does not throw when the dialog fails", async () => {
    const { deps } = harness({
      dialog: {
        showMessageBox: vi.fn(async () => {
          throw new Error("no display");
        }),
      },
    });

    await expect(report(deps)).resolves.toBeUndefined();
  });

  it("does not throw when stderr fails", async () => {
    const { deps } = harness({
      stderr: vi.fn(() => {
        throw new Error("stderr closed");
      }),
    });

    await expect(report(deps)).resolves.toBeUndefined();
  });

  it("describes a non-Error thrown value rather than dropping it", async () => {
    const { deps, log, stderr } = harness();

    await report(deps, "database is locked");

    expect(log.mock.calls[0]![1]).toContain("database is locked");
    expect(stderr.mock.calls[0]![0]).toContain("database is locked");
  });
});
