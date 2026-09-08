/**
 * Version determinism for the E2E stack (docs/testing.md § versions): every
 * run logs and records the Electron / Chromium / chromedriver / WebdriverIO /
 * service versions, and a sanity check fails fast — with a name-the-mismatch
 * error — when the chromedriver that actually connects does not match the
 * Chromium build the installed Electron maps to. Silent driver drift is the
 * classic cause of obscure WebDriver failures; this makes it loud instead.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { repoRoot } from "./fixtures.js";

const requireFromE2e = createRequire(path.join(repoRoot, "e2e", "package.json"));

interface PkgVersion {
  name: string;
  version: string;
}

/**
 * Version of a direct dependency of the e2e package, read from its manifest
 * file under e2e/node_modules. A plain file read (not require("pkg/package.json"))
 * because several packages (webdriverio among them) do not export that
 * subpath from their `exports` map.
 */
function pkgVersion(name: string): PkgVersion {
  const manifestPath = path.join(repoRoot, "e2e", "node_modules", name, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name: string;
    version: string;
  };
  return { name: manifest.name, version: manifest.version };
}

function electronToChromium(electronVersion: string): string | null {
  // Resolve through the service's realpath: pnpm does not hoist
  // electron-to-chromium into e2e/node_modules (it is a service dependency),
  // and a symlinked start would resolve from the wrong directory.
  const serviceReal = fs.realpathSync(
    path.join(repoRoot, "e2e", "node_modules", "@wdio", "electron-service"),
  );
  const requireFromService = createRequire(path.join(serviceReal, "package.json"));
  const map = requireFromService("electron-to-chromium") as {
    fullVersions: Record<string, string>;
  };
  return map.fullVersions[electronVersion] ?? null;
}

export interface StackVersions {
  electron: string;
  chromium: string | null;
  webdriverio: string;
  electronService: string;
  wdioCli: string;
}

/**
 * Launcher-side (config onPrepare) versions, read from the installed
 * packages — no network, no spawning. The Electron version is the resolved
 * `electron` dependency of the e2e package (the binary the service will
 * actually launch).
 */
export function stackVersions(): StackVersions {
  const electron = pkgVersion("electron").version;
  return {
    electron,
    chromium: electronToChromium(electron),
    webdriverio: pkgVersion("webdriverio").version,
    electronService: pkgVersion("@wdio/electron-service").version,
    wdioCli: pkgVersion("@wdio/cli").version,
  };
}

/**
 * The chromedriver version the installed Electron requires, derived through
 * the same electron-to-chromium mapping the service uses. `null` means the
 * mapping has no entry — the sanity check then skips (nothing to compare).
 */
export function requiredChromedriverVersion(): string | null {
  return stackVersions().chromium;
}

/** The chromedriver version reported in the connected session's capabilities, or null. */
function connectedChromedriverVersion(capabilities: WebdriverIO.Capabilities): string | null {
  const chrome = (capabilities as { chrome?: { chromedriverVersion?: string } }).chrome;
  const raw = chrome?.chromedriverVersion;
  if (typeof raw !== "string") return null;
  // Chromedriver reports e.g. "152.0.7977.76 (hash-here)" — leading version.
  return /^(\d+\.\d+\.\d+\.\d+)/.exec(raw)?.[1] ?? null;
}

function majorOf(version: string): string {
  return version.split(".")[0] ?? "";
}

/**
 * Fail with a clear, name-the-versions error when the chromedriver that
 * connected does not match the installed Electron's Chromium build.
 * ChromeDriver's compatibility contract is major-version alignment, so the
 * hard check is on the major; a patch drift within the major is allowed by
 * the driver but still logged. Runs in the worker (`before` hook) where
 * session capabilities are available.
 */
export function assertDriverCompatibility(capabilities: WebdriverIO.Capabilities): void {
  const expected = requiredChromedriverVersion();
  const actual = connectedChromedriverVersion(capabilities);
  if (expected === null || actual === null) return;
  if (majorOf(expected) !== majorOf(actual)) {
    throw new Error(
      `chromedriver/Electron mismatch: session connected with chromedriver ${actual} ` +
        `but the installed Electron maps to Chromium ${expected}. Clear the driver cache ` +
        "(.build/chromedriver-cache) and re-run; fix the environment instead of silencing " +
        "this check (docs/testing.md).",
    );
  }
  if (expected !== actual) {
    console.warn(
      `[e2e] chromedriver patch drift (same major, allowed by the driver): ` +
        `driver=${actual} expected=${expected}`,
    );
  }
}

/** One banner line per run; the same object lands in the artifacts dir. */
export function formatVersionBanner(versions: StackVersions): string {
  return (
    `[e2e] stack versions: electron=${versions.electron}` +
    ` chromium=${versions.chromium ?? "unknown"}` +
    ` webdriverio=${versions.webdriverio}` +
    ` @wdio/electron-service=${versions.electronService}` +
    ` @wdio/cli=${versions.wdioCli}`
  );
}

/** Persist the environment record next to the other failure artifacts. */
export function writeEnvironmentRecord(
  file: string,
  versions: StackVersions,
  extra: Record<string, unknown> = {},
): void {
  const record = { ...versions, ...extra, recordedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  } catch {
    // Diagnostics only — never fail a run over its own log.
  }
}
