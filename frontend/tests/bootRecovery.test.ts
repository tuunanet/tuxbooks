import { describe, expect, it, vi } from "vitest";

import {
  parseQuarantineReport,
  reportStartupFailure,
  RESET_DATA_COMMAND,
  STARTUP_ERROR_LOG,
  startupErrorLogPath,
  surfaceStartupQuarantine,
  type StartupDialogSurface,
  type StartupQuarantineDeps,
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

function quarantineHarness(reported: unknown): {
  deps: StartupQuarantineDeps;
  showMessageBox: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
  stderr: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  const showMessageBox = vi.fn(async () => ({ response: 0 }));
  const openPath = vi.fn(async () => "");
  const stderr = vi.fn();
  const call = vi.fn(async () => reported);
  const deps: StartupQuarantineDeps = {
    sidecar: { call },
    dialog: { showMessageBox },
    shell: { openPath },
    stderr,
    paths: PATHS,
  };
  return { deps, showMessageBox, openPath, stderr, call };
}

describe("startup database quarantine", () => {
  it("accepts only a non-empty from/to pair", () => {
    const report = { from: "/d/tuxbooks.db", to: "/d/tuxbooks.db.corrupt-1" };
    expect(parseQuarantineReport(report)).toEqual(report);
    expect(parseQuarantineReport(null)).toBeNull();
    expect(parseQuarantineReport({ from: "", to: "/d/x" })).toBeNull();
    expect(parseQuarantineReport({ from: "/d/x" })).toBeNull();
    expect(parseQuarantineReport({ from: 1, to: "/d/x" })).toBeNull();
    expect(parseQuarantineReport("nope")).toBeNull();
  });

  it("names where the broken file went and returns the report", async () => {
    const moved = "/app/data/tuxbooks.db.corrupt-20260922T080000.000Z";
    const { deps, showMessageBox, openPath, stderr, call } = quarantineHarness({
      from: "/app/data/tuxbooks.db",
      to: moved,
    });

    const report = await surfaceStartupQuarantine(deps);

    expect(call).toHaveBeenCalledWith("get_startup_recovery");
    expect(report).toEqual({ from: "/app/data/tuxbooks.db", to: moved });
    expect(showMessageBox).toHaveBeenCalledOnce();
    const options = showMessageBox.mock.calls[0]![0] as DialogOptions;
    expect(options.type).toBe("warning");
    expect(options.detail).toContain(moved);
    expect(options.buttons).toEqual(["Open data folder"]);
    expect(openPath).toHaveBeenCalledWith(PATHS.dataDir);
    expect(stderr.mock.calls[0]![0]).toContain("quarantined");
  });

  it("stays silent for a healthy database", async () => {
    const { deps, showMessageBox, stderr } = quarantineHarness(null);

    await expect(surfaceStartupQuarantine(deps)).resolves.toBeNull();

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("does not throw when the sidecar call fails", async () => {
    const call = vi.fn(async () => {
      throw new Error("sidecar not running");
    });
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    const stderr = vi.fn();
    const deps: StartupQuarantineDeps = {
      sidecar: { call },
      dialog: { showMessageBox },
      shell: { openPath: vi.fn() },
      stderr,
      paths: PATHS,
    };

    await expect(surfaceStartupQuarantine(deps)).resolves.toBeNull();

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toContain("sidecar not running");
  });

  it("still reports the quarantine when the dialog fails", async () => {
    const report = { from: "/a/tuxbooks.db", to: "/a/tuxbooks.db.corrupt-1" };
    const { deps } = quarantineHarness(report);
    deps.dialog.showMessageBox = vi.fn(async () => {
      throw new Error("no display");
    });

    await expect(surfaceStartupQuarantine(deps)).resolves.toEqual(report);
  });
});
