/**
 * Deterministic chromedriver fetcher for the service-managed driver cache
 * (docs/testing.md "Chromedriver").
 *
 * Why this exists: wdio-utils resolves the correct chromedriver build id
 * automatically (the @wdio/electron-service derives it from the installed
 * Electron), but its downloader (@puppeteer/browsers 2.13.2) hangs on this
 * network — the download promise never settles and a killed run leaves a
 * poisoned cache ("the browser folder exists but the executable is
 * missing"). This script performs the SAME resolution and downloads the
 * same Chrome-for-Testing artifact into the same cache layout with a plain
 * fetch + unzip, so wdio-utils finds a complete entry and skips its broken
 * downloader entirely. wdio.conf.ts runs it automatically when the pinned
 * cache entry is missing; `just fetch-chromedriver` runs it explicitly.
 *
 * Self-contained on purpose (bootstrap runs before the wdio TS context
 * exists): plain Node ESM, no imports from e2e/setup/*.ts. Resolution order
 * mirrors the service's: the live Electron releases map, then the pinned
 * electron-to-chromium map.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const cacheDir = path.join(repoRoot, ".build", "chromedriver-cache");

function electronVersion() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "e2e", "node_modules", "electron", "package.json"), "utf8"),
  );
  return manifest.version;
}

async function chromiumBuildFor(electron) {
  // Live map first (same source the service uses), pinned map as fallback.
  try {
    const response = await fetch("https://electronjs.org/headers/index.json");
    if (response.ok) {
      const hit = (await response.json()).find((entry) => entry.version === electron);
      if (hit?.chrome) return hit.chrome;
    }
  } catch {
    // Offline or rate-limited — fall through to the pinned map.
  }
  const serviceReal = fs.realpathSync(
    path.join(repoRoot, "e2e", "node_modules", "@wdio", "electron-service"),
  );
  const requireFromService = createRequire(path.join(serviceReal, "package.json"));
  const { fullVersions } = requireFromService("electron-to-chromium");
  const build = fullVersions[electron];
  if (!build) {
    throw new Error(`no chromium mapping for electron ${electron}`);
  }
  return build;
}

function installedBinary(build) {
  // @puppeteer/browsers computeExecutablePath layout (the exact path
  // wdio-utils probes before deciding to download).
  return path.join(
    cacheDir,
    "chromedriver",
    `linux-${build}`,
    "chromedriver-linux64",
    "chromedriver",
  );
}

async function downloadChromedriver(build) {
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${build}/linux64/chromedriver-linux64.zip`;
  const zipPath = path.join(cacheDir, `${build}-chromedriver-linux64.zip`);
  const target = installedBinary(build);

  if (fs.existsSync(target)) {
    console.log(`chromedriver ${build} already present`);
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  console.log(`fetching chromedriver ${build} (electron ${electronVersion()})`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`chromedriver download failed: ${response.status} ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(zipPath, buffer);
  // The zip carries a top-level chromedriver-linux64/ directory; extracting
  // into the linux-<build> folder yields the layout wdio-utils probes.
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", path.dirname(path.dirname(target))]);
  fs.rmSync(zipPath, { force: true });
  fs.chmodSync(target, 0o755);
  if (!fs.existsSync(target)) {
    throw new Error(`chromedriver extraction did not produce ${target}`);
  }
  console.log(`installed: ${execFileSync(target, ["--version"]).toString().trim()}`);
}

const build = process.env.CHROMEDRIVER_BUILD ?? (await chromiumBuildFor(electronVersion()));
if (!build) {
  console.error("fetch-chromedriver: failed to resolve a chromium build");
  process.exit(1);
}
await downloadChromedriver(build);
