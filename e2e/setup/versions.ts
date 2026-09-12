/**
 * Version determinism for the E2E stack (docs/TESTING.md § versions): every
 * run logs and records the Electron / Chromium / Playwright / Node
 * versions, plus the OS/runtime environment, into the run banner and the
 * run's artifacts directory — a failed E2E test must be reproducible from
 * the artifacts alone. There is no external driver to version-match: the
 * Playwright Electron launcher drives the installed Electron binary
 * directly, so the only version that matters is the one recorded here.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { repoRoot } from "./fixtures.js";

const requireFromE2e = createRequire(path.join(repoRoot, "e2e", "package.json"));

interface PkgVersion {
  name: string;
  version: string;
}

/** Version of a dependency resolvable from the e2e package. */
function pkgVersion(name: string): PkgVersion {
  const manifest = requireFromE2e(`${name}/package.json`) as {
    name: string;
    version: string;
  };
  return { name: manifest.name, version: manifest.version };
}

export interface StackVersions {
  electron: string;
  playwright: string;
  playwrightTest: string;
  node: string;
  os: `${string} ${string}`;
}

/**
 * Launcher-side versions, read from the installed packages — no network, no
 * spawning. The Electron version is the resolved `electron` dependency of
 * the e2e package (the binary the Playwright launcher will actually
 * start); its Chromium build is reported by the app itself once up (the
 * process.versions hash in the main process), so the record is completed
 * by the launch fixture.
 */
export function stackVersions(): StackVersions {
  return {
    electron: pkgVersion("electron").version,
    playwright: pkgVersion("playwright").version,
    playwrightTest: pkgVersion("@playwright/test").version,
    node: process.version,
    os: `${os.type()} ${os.release()}`,
  };
}

/** One banner line per run; the same object lands in the artifacts dir. */
export function formatVersionBanner(versions: StackVersions): string {
  return (
    `[e2e] stack versions: electron=${versions.electron}` +
    ` playwright=${versions.playwright}` +
    ` @playwright/test=${versions.playwrightTest}` +
    ` node=${versions.node}` +
    ` os=${versions.os}`
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
