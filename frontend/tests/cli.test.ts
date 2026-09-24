import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../electron/main/cli";

/**
 * Command-line tests (standard CLI practice): fixed order-independent
 * precedence, strict unknown-flag errors, the launcher pass-through list,
 * exact help/version/error text, and exit codes. External behavior only:
 * what is printed, what is called, and which exit code is requested.
 * parseCli stays module-private, so recognition cases observe runCli's
 * outputs instead of importing the parser.
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

const USAGE_HINT_LINE = "Run 'tuxbooks --help' for usage.";

describe("command recognition", () => {
  it("recognizes the help and version flags in both spellings", () => {
    for (const flag of ["-h", "--help"]) {
      const { deps, out, err, exits } = harness();
      expect(runCli(["tuxbooks", flag], deps)).toBe(true);
      expect(out.join("\n")).toContain("Usage: tuxbooks [options]");
      expect(err).toEqual([]);
      expect(exits).toEqual([0]);
    }
    for (const flag of ["-v", "--version"]) {
      const { deps, out, err, exits } = harness();
      expect(runCli(["tuxbooks", flag], deps)).toBe(true);
      expect(out).toEqual(["tuxbooks 1.2.3"]);
      expect(err).toEqual([]);
      expect(exits).toEqual([0]);
    }
  });

  it("lets help win over version, usage errors, and actions in any order", () => {
    const cases = [
      ["tuxbooks", "--version", "--help"],
      ["tuxbooks", "--bogus", "--help"],
      ["tuxbooks", "--help", "--reset-data"],
      ["tuxbooks", "--dry-run", "-h"],
      ["electron", ".", "--bogus", "-h"],
    ];
    for (const argv of cases) {
      const { deps, out, err, exits, calls } = harness();
      expect(runCli(argv, deps)).toBe(true);
      expect(out.join("\n")).toContain("Usage: tuxbooks [options]");
      expect(err).toEqual([]);
      expect(exits).toEqual([0]);
      expect(calls).toEqual({ dryRun: 0, resetData: 0 });
    }
  });

  it("lets version win over usage errors and actions", () => {
    const cases = [
      ["tuxbooks", "--bogus", "-v"],
      ["tuxbooks", "--dry-run", "--version"],
    ];
    for (const argv of cases) {
      const { deps, out, err, exits, calls } = harness();
      expect(runCli(argv, deps)).toBe(true);
      expect(out).toEqual(["tuxbooks 1.2.3"]);
      expect(err).toEqual([]);
      expect(exits).toEqual([0]);
      expect(calls).toEqual({ dryRun: 0, resetData: 0 });
    }
  });

  it("rejects unknown options, clustered short flags, and option values", () => {
    const cases: [string[], string][] = [
      [["tuxbooks", "--bogus"], "unknown option '--bogus'"],
      [["tuxbooks", "-hv"], "unknown option '-hv'"],
      [["tuxbooks", "--reset-data=1"], "option '--reset-data' does not take a value"],
      [["tuxbooks", "--help=1"], "option '--help' does not take a value"],
    ];
    for (const [argv, reason] of cases) {
      const { deps, out, err, exits, calls } = harness();
      expect(runCli(argv, deps)).toBe(true);
      expect(out).toEqual([]);
      expect(err).toEqual([`tuxbooks: ${reason}`, USAGE_HINT_LINE]);
      expect(exits).toEqual([2]);
      expect(calls).toEqual({ dryRun: 0, resetData: 0 });
    }
  });

  it("reports the first usage error when several options are bad", () => {
    const multi = harness();
    expect(runCli(["tuxbooks", "--bogus", "--worse"], multi.deps)).toBe(true);
    expect(multi.err).toEqual(["tuxbooks: unknown option '--bogus'", USAGE_HINT_LINE]);
    expect(multi.exits).toEqual([2]);

    const withAction = harness();
    expect(runCli(["tuxbooks", "--dry-run", "--bogus"], withAction.deps)).toBe(true);
    expect(withAction.err).toEqual(["tuxbooks: unknown option '--bogus'", USAGE_HINT_LINE]);
    expect(withAction.calls).toEqual({ dryRun: 0, resetData: 0 });
    expect(withAction.exits).toEqual([2]);
  });

  it("runs the non-destructive dry run when both action flags are given", () => {
    const cases = [
      ["tuxbooks", "--dry-run", "--reset-data"],
      ["tuxbooks", "--reset-data", "--dry-run"],
    ];
    for (const argv of cases) {
      const { deps, out, err, exits, calls } = harness();
      expect(runCli(argv, deps)).toBe(true);
      expect(calls).toEqual({ dryRun: 1, resetData: 0 });
      expect(out).toEqual([]);
      expect(err).toEqual([]);
      expect(exits).toEqual([0]);
    }
  });

  it("starts the GUI when only positionals are given", () => {
    const cases = [
      ["tuxbooks"],
      ["electron", "."],
      ["tuxbooks", "book.epub"],
      ["electron", "/path/main.cjs", "book.epub"],
    ];
    for (const argv of cases) {
      const { deps, out, err, exits, calls } = harness();
      expect(runCli(argv, deps)).toBe(false);
      expect(out).toEqual([]);
      expect(err).toEqual([]);
      expect(exits).toEqual([]);
      expect(calls).toEqual({ dryRun: 0, resetData: 0 });
    }
  });

  it("treats a lone dash as a positional, not an option", () => {
    const { deps, out, err, exits, calls } = harness();
    expect(runCli(["tuxbooks", "-"], deps)).toBe(false);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(exits).toEqual([]);
    expect(calls).toEqual({ dryRun: 0, resetData: 0 });
  });

  it("stops option parsing at the end-of-options marker", () => {
    const guiHelp = harness();
    expect(runCli(["tuxbooks", "--", "--help"], guiHelp.deps)).toBe(false);
    expect(guiHelp.out).toEqual([]);
    expect(guiHelp.exits).toEqual([]);

    const guiError = harness();
    expect(runCli(["tuxbooks", "--", "--bogus"], guiError.deps)).toBe(false);
    expect(guiError.err).toEqual([]);
    expect(guiError.exits).toEqual([]);

    const action = harness();
    expect(runCli(["tuxbooks", "--dry-run", "--", "--reset-data"], action.deps)).toBe(true);
    expect(action.calls).toEqual({ dryRun: 1, resetData: 0 });
    expect(action.exits).toEqual([0]);

    const help = harness();
    expect(runCli(["tuxbooks", "--help", "--"], help.deps)).toBe(true);
    expect(help.out.join("\n")).toContain("Usage: tuxbooks [options]");
    expect(help.exits).toEqual([0]);
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
    const gui = harness();
    expect(runCli(launcherArgs, gui.deps)).toBe(false);
    expect(gui.exits).toEqual([]);

    const dry = harness();
    expect(runCli([...launcherArgs, "--dry-run"], dry.deps)).toBe(true);
    expect(dry.calls).toEqual({ dryRun: 1, resetData: 0 });
    expect(dry.exits).toEqual([0]);

    // Near-miss typos in the pass-through list stay strict.
    const typo = harness();
    expect(runCli(["tuxbooks", "--no-sandbos"], typo.deps)).toBe(true);
    expect(typo.err).toEqual(["tuxbooks: unknown option '--no-sandbos'", USAGE_HINT_LINE]);
    expect(typo.exits).toEqual([2]);
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
    expect(err).toEqual(["tuxbooks: unknown option '--bogus'", USAGE_HINT_LINE]);
    expect(exits).toEqual([2]);
    expect(calls).toEqual({ dryRun: 0, resetData: 0 });
  });

  it("prints a value-on-boolean failure the same way and exits 2", () => {
    const { deps, out, err, exits, calls } = harness();
    expect(runCli(["tuxbooks", "--reset-data=1"], deps)).toBe(true);
    expect(out).toEqual([]);
    expect(err).toEqual(["tuxbooks: option '--reset-data' does not take a value", USAGE_HINT_LINE]);
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
