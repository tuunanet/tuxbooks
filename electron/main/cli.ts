import { describeStartupFailure } from "./bootRecovery";

/**
 * Command-line interface (standard CLI practice): `--help`/`-h` and
 * `--version`/`-v` print to stdout and exit 0 without starting the GUI;
 * `--dry-run` and `--reset-data` run the data-management recovery actions
 * (policy in resetData.ts) and also exit without starting the GUI; any
 * other unknown option is a usage error on stderr with exit 2. Precedence
 * is fixed and order-independent: help, then version, then the first usage
 * error, then dry-run over reset-data. `--` ends option parsing, positionals
 * (executable and entry paths included) are ignored, and the pass-through
 * list keeps the Chromium switches launchers put in argv (the e2e fixture's,
 * plus `--disable-gpu`) from counting as unknown options. Switches after
 * `--` are forwarded to Chromium verbatim (via the injected `forwardSwitch`)
 * so any debugging switch can reach the GPU/compositor stack without
 * widening the strict option set — typo strictness before `--` is
 * unchanged. Writers, version, and exit are injected, so the policy
 * unit-tests without Electron.
 */

export interface CliDeps {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  exit: (code: number) => void;
  /** The app version reported by `--version`; injected from `app.getVersion()`. */
  version: string;
  runDryRun: () => void;
  runResetData: () => Promise<unknown>;
  /**
   * Forwards one post-`--` switch to Chromium (`app.commandLine.appendSwitch`
   * in the app); `value` is the part after `=`, undefined for a bare switch.
   */
  forwardSwitch: (name: string, value: string | undefined) => void;
}

type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "usage-error"; message: string }
  | { kind: "dry-run" }
  | { kind: "reset-data" }
  | { kind: "gui"; forwarded: string[] };

/**
 * Exact `--help` text; the fixed program name is never derived from
 * argv[0], so the output is identical for packaged, dev, and e2e launches.
 */
const HELP_TEXT = `Usage: tuxbooks [options]

TuxBooks: a local-first ebook library and reader.

Options:
  -h, --help     Show this help and exit
  -v, --version  Show version and exit
  --dry-run      Print app data locations and sizes; change nothing
  --reset-data   Clear app data and caches; never touch book files
  -- <switches>  Pass every following switch to Chromium
                 (e.g. tuxbooks -- --force-gpu-mem-available-mb=256)`;

const USAGE_HINT = "Run 'tuxbooks --help' for usage.";

/** TuxBooks options take no value, so `--flag=value` is a usage error. */
const BOOLEAN_OPTIONS = new Set(["-h", "-v", "--help", "--version", "--dry-run", "--reset-data"]);

/**
 * Chromium switches that launchers place in argv (the e2e fixture's four,
 * plus `--disable-gpu` for users): Chromium consumes them but never removes
 * them from process.argv, so they pass through instead of erroring. Matched
 * on the name before any `=`.
 */
const PASSTHROUGH_OPTIONS = new Set([
  "--no-sandbox",
  "--ozone-platform",
  "--force-device-scale-factor",
  "--use-fake-device-for-media-stream",
  "--disable-gpu",
]);

/** What one token contributes; null means ignore it (positional or pass-through). */
type TokenEvent = "help" | "version" | "dry-run" | "reset-data" | { error: string };

function classify(token: string): TokenEvent | null {
  if (token === "-h" || token === "--help") return "help";
  if (token === "-v" || token === "--version") return "version";
  if (token === "--dry-run") return "dry-run";
  if (token === "--reset-data") return "reset-data";
  if (!token.startsWith("-") || token === "-") return null;
  const separator = token.indexOf("=");
  const name = separator === -1 ? token : token.slice(0, separator);
  if (PASSTHROUGH_OPTIONS.has(name)) return null;
  if (separator !== -1 && BOOLEAN_OPTIONS.has(name)) {
    return { error: `option '${name}' does not take a value` };
  }
  return { error: `unknown option '${name}'` };
}

/** One forward pass over the tokens: flags found, first error, pass-through. */
interface CliScan {
  help: boolean;
  version: boolean;
  dryRun: boolean;
  resetData: boolean;
  error: string | null;
  /** Everything after `--`, handed to Chromium verbatim; empty when absent. */
  forwarded: string[];
}

/** Recognize the command; every scan runs, precedence breaks all ties. */
function parseCli(argv: readonly string[]): CliCommand {
  const scan = scanArgv(argv);
  if (scan.help) return { kind: "help" };
  if (scan.version) return { kind: "version" };
  if (scan.error !== null) return { kind: "usage-error", message: scan.error };
  if (scan.dryRun) return { kind: "dry-run" };
  if (scan.resetData) return { kind: "reset-data" };
  return { kind: "gui", forwarded: scan.forwarded };
}

/**
 * One forward scan of the tokens. `--` ends option parsing and everything
 * after it is forwarded verbatim; the first usage error wins, so the report
 * names the earliest typo.
 */
function scanArgv(argv: readonly string[]): CliScan {
  const scan: CliScan = {
    help: false,
    version: false,
    dryRun: false,
    resetData: false,
    error: null,
    forwarded: [],
  };
  for (const [index, token] of argv.entries()) {
    if (token === "--") {
      // Everything after the separator is handed to Chromium verbatim.
      scan.forwarded = [...argv.slice(index + 1)];
      break;
    }
    const event = classify(token);
    if (event === null) continue;
    if (typeof event !== "string") {
      scan.error ??= event.error;
      continue;
    }
    if (event === "help") scan.help = true;
    else if (event === "version") scan.version = true;
    else if (event === "dry-run") scan.dryRun = true;
    else scan.resetData = true;
  }
  return scan;
}

/**
 * Run the recognized command, then exit; returns false only for a plain
 * launch, meaning the caller starts the graphical app. Help, version, and
 * usage errors exit synchronously; `--dry-run` exits after its report;
 * `--reset-data` exits when its work settles (exit 1 with the failure
 * message on stderr).
 */
export function runCli(argv: readonly string[], deps: CliDeps): boolean {
  const command = parseCli(argv);
  switch (command.kind) {
    case "help":
      deps.stdout(HELP_TEXT);
      deps.exit(0);
      return true;
    case "version":
      deps.stdout(`tuxbooks ${deps.version}`);
      deps.exit(0);
      return true;
    case "usage-error":
      deps.stderr(`tuxbooks: ${command.message}`);
      deps.stderr(USAGE_HINT);
      deps.exit(2);
      return true;
    case "dry-run":
      deps.runDryRun();
      deps.exit(0);
      return true;
    case "reset-data":
      void deps.runResetData().then(
        () => deps.exit(0),
        (error: unknown) => {
          deps.stderr(`TuxBooks could not reset app data: ${describeStartupFailure(error)}`);
          deps.exit(1);
        },
      );
      return true;
    case "gui":
      // Post-`--` switches reach Chromium (this runs before app ready, where
      // appendSwitch is legal); bare positionals after the separator stay
      // ignored, exactly like positionals before it.
      for (const token of command.forwarded) {
        if (!token.startsWith("-") || token === "-" || token === "--") continue;
        const separator = token.indexOf("=");
        const name = separator === -1 ? token : token.slice(0, separator);
        deps.forwardSwitch(name, separator === -1 ? undefined : token.slice(separator + 1));
      }
      return false;
  }
}
