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
 * plus `--disable-gpu`) from counting as unknown options. Writers, version,
 * and exit are injected, so the policy unit-tests without Electron.
 */

export interface CliDeps {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  exit: (code: number) => void;
  /** The app version reported by `--version`; injected from `app.getVersion()`. */
  version: string;
  runDryRun: () => void;
  runResetData: () => Promise<unknown>;
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "usage-error"; message: string }
  | { kind: "dry-run" }
  | { kind: "reset-data" }
  | { kind: "gui" };

/**
 * Exact `--help` text; the fixed program name is never derived from
 * argv[0], so the output is identical for packaged, dev, and e2e launches.
 */
export const HELP_TEXT = `Usage: tuxbooks [options]

TuxBooks: a local-first ebook library and reader.

Options:
  -h, --help     Show this help and exit
  -v, --version  Show version and exit
  --dry-run      Print app data locations and sizes; change nothing
  --reset-data   Clear app data and caches; never touch book files`;

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

/** Recognize the command; every scan runs, precedence breaks all ties. */
export function parseCli(argv: readonly string[]): CliCommand {
  let help = false;
  let version = false;
  let dryRun = false;
  let resetData = false;
  let error: string | null = null;

  for (const token of argv) {
    if (token === "--") break;
    if (token === "-h" || token === "--help") {
      help = true;
      continue;
    }
    if (token === "-v" || token === "--version") {
      version = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--reset-data") {
      resetData = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") continue;
    const separator = token.indexOf("=");
    const name = separator === -1 ? token : token.slice(0, separator);
    if (PASSTHROUGH_OPTIONS.has(name)) continue;
    if (separator !== -1 && BOOLEAN_OPTIONS.has(name)) {
      error ??= `option '${name}' does not take a value`;
      continue;
    }
    error ??= `unknown option '${name}'`;
  }

  if (help) return { kind: "help" };
  if (version) return { kind: "version" };
  if (error !== null) return { kind: "usage-error", message: error };
  if (dryRun) return { kind: "dry-run" };
  if (resetData) return { kind: "reset-data" };
  return { kind: "gui" };
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
      return false;
  }
}
