#!/usr/bin/env bash
# Fetch the Chrome-for-Testing chromedriver matching the app's Electron
# version (e2e/, gitignored under .build/). wdio-electron-service's own
# downloader hangs on this machine (the install promise never resolves and
# the extraction dies mid-flight), so the E2E harness hands the service an
# explicit binary instead (e2e/wdio.conf.ts). Idempotent: skips when the
# stamped build is already present. Linux-only, like the E2E suite.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache="$root/.build/chromedriver"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "fetch-chromedriver: Linux only (the E2E suite is Linux-only)." >&2
    exit 1
fi

electron_version=$(node -p "require('$root/e2e/package.json').devDependencies.electron.replace(/^[^0-9]*/, '')")

# Resolve the Chromium build for this Electron version through the same
# mapping the service uses (its own electron-to-chromium dependency).
build=${CHROMEDRIVER_BUILD:-$(node --input-type=module -e "
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
// Same resolution order as wdio-electron-service: the live Electron
// releases map first, the pinned electron-to-chromium map as fallback.
// Resolve through the service's realpath: pnpm symlinks would otherwise
// start dependency resolution in the wrong directory.
const require = createRequire(realpathSync('$root/e2e/node_modules/wdio-electron-service/package.json'));
const electronVersion = '$electron_version';
try {
  const releases = await (await fetch('https://electronjs.org/headers/index.json')).json();
  const hit = releases.find((r) => r.version === electronVersion);
  if (hit?.chrome) { console.log(hit.chrome); process.exit(0); }
} catch (e) {
  console.error('live map fetch failed: ' + e.message);
}
const { fullVersions } = require('electron-to-chromium');
const v = fullVersions[electronVersion];
if (!v) { console.error('no chromium mapping for electron ' + electronVersion); process.exit(1); }
console.log(v);
")}
if [[ -z "$build" ]]; then
    echo "fetch-chromedriver: failed to resolve a chromium build for electron $electron_version" >&2
    exit 1
fi

stamp="$cache/version.txt"
binary="$cache/chromedriver-linux64/chromedriver"
if [[ -f "$stamp" && "$(cat "$stamp")" == "$build" && -x "$binary" ]]; then
    echo "chromedriver $build already present"
    exit 0
fi

rm -rf "$cache"
mkdir -p "$cache"
url="https://storage.googleapis.com/chrome-for-testing-public/$build/linux64/chromedriver-linux64.zip"
echo "fetching chromedriver $build (electron $electron_version)"
curl -fsSL "$url" -o "$cache/chromedriver.zip"
unzip -q "$cache/chromedriver.zip" -d "$cache"
rm "$cache/chromedriver.zip"
chmod +x "$binary"
echo "$build" > "$stamp"

version_output=$("$binary" --version)
echo "installed: $version_output"
