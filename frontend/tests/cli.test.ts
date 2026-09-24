import { describe, expect, it } from "vitest";

import { HELP_TEXT, parseCli, runCli, type CliDeps } from "../../electron/main/cli";

/**
 * Command-line tests (standard CLI practice): fixed order-independent
 * precedence, strict unknown-flag errors, the launcher pass-through list,
 * exact help/version/error text, and exit codes. External behavior only:
 * what is printed, what is called, and which exit code is requested.
 */

function harness(overrides: Partial<CliDeps> = {}): {
  deps: CliDeps;
  out: string[];
  err: string[];
  exits: number[];
  calls: { dryRun: number; resetData: number };
} {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const calls = { dryRun: 0, resetData: 0 };
  const deps: CliDeps = {
    stdout: (message) => out.push(message),
    stderr: (message) => err.push(message),
    exit: (code) => exits.push(code),
    version: "1.2.3",
    runDryRun: () => {
      calls.dryRun += 1;
    },
    runResetData: async () => {
      calls.resetData += 1;
    },
    ...overrides,
  };
  return { deps, out, err, exits, calls };
}

/** Let runCli's async --reset-data branch settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("parseCli", () => {
  it("recognizes the help and version flags in both spellings", () => {
    expect(parseCli(["tuxbooks", "-h"])).toEqual({ kind: "help" });
    expect(parseCli(["tuxbooks", "--help"])).toEqual({ kind: "help" });
    expect(parseCli(["tuxbooks", "-v"])).toEqual({ kind: "version" });
    expect(parseCli(["tuxbooks", "--version"])).toEqual({ kind: "version" });
  });

  it("lets help win over version, usage errors, and actions in any order", () => {
    expect(parseCli(["tuxbooks", "--version", "--help"])).toEqual({ kind: "help" });
    expect(parseCli(["tuxbooks", "--bogus", "--help"])).toEqual({ kind: "help" });
    expect(parseCli(["tuxbooks", "--help", "--reset-data"])).toEqual({ kind: "help" });
    expect(parseCli(["tuxbooks", "--dry-run", "-h"])).toEqual({ kind: "help" });
  });

  it("lets version win over usage errors and actions", () => {
    expect(parseCli(["tuxbooks", "--bogus", "-v"])).toEqual({ kind: "version" });
    expect(parseCli(["tuxbooks", "--dry-run", "--version"])).toEqual({ kind: "version" });
  });

  it("rejects unknown options, clustered short flags, and option values", () => {
    expect(parseCli(["tuxbooks", "--bogus"])).toEqual({
      kind: "usage-error",
      message: "unknown option '--bogus'",
    });
    expect(parseCli(["tuxbooks", "-hv"])).toEqual({
      kind: "usage-error",
      message: "unknown option '-hv'",
    });
    expect(parseCli(["tuxbooks", "--reset-data=1"])).toEqual({
      kind: "usage-error",
      message: "option '--reset-data' does not take a value",
    });
    expect(parseCli(["tuxbooks", "--help=1"])).toEqual({
      kind: "usage-error",
      message: "option '--help' does not take a value",
    });
  });

  it("reports the first usage error when several options are bad", () => {
    expect(parseCli(["tuxbooks", "--bogus", "--worse"])).toEqual({
      kind: "usage-error",
      message: "unknown option '--bogus'",
    });
    expect(parseCli(["tuxbooks", "--dry-run", "--bogus"])).toEqual({
      kind: "usage-error",
      message: "unknown option '--bogus'",
    });
  });

  it("runs the non-destructive dry run when both action flags are given", () => {
    expect(parseCli(["tuxbooks", "--dry-run", "--reset-data"])).toEqual({ kind: "dry-run" });
    expect(parseCli(["tuxbooks", "--reset-data", "--dry-run"])).toEqual({ kind: "dry-run" });
    expect(parseCli(["tuxbooks", "--reset-data"])).toEqual({ kind: "reset-data" });
    expect(parseCli(["tuxbooks", "--dry-run"])).toEqual({ kind: "dry-run" });
  });

  it("starts the GUI when only positionals are given", () => {
    expect(parseCli(["tuxbooks"])).toEqual({ kind: "gui" });
    expect(parseCli(["electron", "."])).toEqual({ kind: "gui" });
    expect(parseCli(["tuxbooks", "book.epub"])).toEqual({ kind: "gui" });
    expect(parseCli(["electron", "/path/main.cjs", "book.epub"])).toEqual({ kind: "gui" });
  });

  it("treats a lone dash as a positional, not an option", () => {
    expect(parseCli(["tuxbooks", "-"])).toEqual({ kind: "gui" });
  });

  it("stops option parsing at the end-of-options marker", () => {
    expect(parseCli(["tuxbooks", "--", "--help"])).toEqual({ kind: "gui" });
    expect(parseCli(["tuxbooks", "--", "--bogus"])).toEqual({ kind: "gui" });
    expect(parseCli(["tuxbooks", "--dry-run", "--", "--reset-data"])).toEqual({ kind: "dry-run" });
    expect(parseCli(["tuxbooks", "--help", "--"])).toEqual({ kind: "help" });
  });

  it("passes launcher Chromium switches through without treating them as unknown", () => {
    const launcherArgs = [
      "tuxbooks",
      "--no-sandbox",
      "--ozone-platform=x11",
      "--force-device-scale-factor=2",
      "--use-fake-device-for-media-stream",
      "--disable-gpu",
    ];
    expect(parseCli(launcherArgs)).toEqual({ kind: "gui" });
    expect(parseCli([...launcherArgs, "--dry-run"])).toEqual({ kind: "dry-run" });
    // Near-miss typos in the pass-through list stay strict.
    expect(parseCli(["tuxbooks", "--no-sandbos"])).toEqual({
      kind: "usage-error",
      message: "unknown option '--no-sandbos'",
    });
  });
});

describe("runCli", () => {
  it("prints the exact help text to stdout and exits 0", () => {
    const { deps, out, err, exits, calls } = harness();
    expect(runCli(["tuxbooks", "--help"], deps)).toBe(true);
    expect(out).toEqual([
      `Usage: tuxbooks [options]

TuxBooks: a local-first ebook library and reader.

Options:
  -h, --help     Show this help and exit
  -v, --version  Show version and exit
  --dry-run      Print app data locations and sizes; change nothing
  --reset-data   Clear app data and caches; never touch book files`,
    ]);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
    expect(calls).toEqual({ dryRun: 0, resetData: 0 });
  });

  it("prints help for -h next to an unknown option without erroring", () => {
    const { deps, out, err, exits } = harness();
    expect(runCli(["electron", ".", "--bogus", "-h"], deps)).toBe(true);
    expect(out).toEqual([HELP_TEXT]);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
  });

  it("prints the version with the injected version string and exits 0", () => {
    const { deps, out, err, exits } = harness();
    expect(runCli(["tuxbooks", "--version"], deps)).toBe(true);
    expect(out).toEqual(["tuxbooks 1.2.3"]);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
  });

  it("prints an unknown option and the usage hint to stderr and exits 2", () => {
    const { deps, out, err, exits, calls } = harness();
    expect(runCli(["tuxbooks", "--bogus"], deps)).toBe(true);
    expect(out).toEqual([]);
    expect(err).toEqual(["tuxbooks: unknown option '--bogus'", "Run 'tuxbooks --help' for usage."]);
    expect(exits).toEqual([2]);
    expect(calls).toEqual({ dryRun: 0, resetData: 0 });
  });

  it("prints a value-on-boolean failure the same way and exits 2", () => {
    const { deps, out, err, exits, calls } = harness();
    expect(runCli(["tuxbooks", "--reset-data=1"], deps)).toBe(true);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "tuxbooks: option '--reset-data' does not take a value",
      "Run 'tuxbooks --help' for usage.",
    ]);
    expect(exits).toEqual([2]);
    expect(calls).toEqual({ dryRun: 0, resetData: 0 });
  });

  it("runs the dry run, skips the reset, and exits 0", () => {
    const { deps, out, err, exits, calls } = harness();
    expect(runCli(["tuxbooks", "--dry-run"], deps)).toBe(true);
    expect(calls).toEqual({ dryRun: 1, resetData: 0 });
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
  });

  it("prefers the dry run over reset-data when both are given", () => {
    const { deps, exits, calls } = harness();
    expect(runCli(["tuxbooks", "--dry-run", "--reset-data"], deps)).toBe(true);
    expect(calls).toEqual({ dryRun: 1, resetData: 0 });
    expect(exits).toEqual([0]);
  });

  it("runs reset-data and exits 0 when it succeeds", async () => {
    const { deps, err, exits, calls } = harness();
    expect(runCli(["tuxbooks", "--reset-data"], deps)).toBe(true);
    expect(calls).toEqual({ dryRun: 0, resetData: 1 });
    expect(exits).toEqual([]);
    await flush();
    expect(exits).toEqual([0]);
    expect(err).toEqual([]);
  });

  it("exits 1 with the failure on stderr when reset-data rejects", async () => {
    const { deps, out, err, exits } = harness({
      runResetData: async () => {
        throw new Error("boom");
      },
    });
    expect(runCli(["tuxbooks", "--reset-data"], deps)).toBe(true);
    await flush();
    expect(out).toEqual([]);
    expect(err).toEqual(["TuxBooks could not reset app data: boom"]);
    expect(exits).toEqual([1]);
  });

  it("starts the GUI for a plain launch and touches nothing", () => {
    const { deps, out, err, exits, calls } = harness();
    expect(runCli(["tuxbooks"], deps)).toBe(false);
    expect(runCli(["electron", "."], deps)).toBe(false);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(exits).toEqual([]);
    expect(calls).toEqual({ dryRun: 0, resetData: 0 });
  });
});
