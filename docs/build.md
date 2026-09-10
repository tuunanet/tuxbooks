# Build and dev environment

The renderer is a plain Vite build of `frontend/`; the Electron main and
preload processes are bundled by `scripts/build-electron.mjs` (esbuild,
CJS, `electron` external); the sidecar is a plain Rust binary from the
`sidecar/` crate — no `custom-protocol` feature, no `frontend/dist`
embed, no Tauri context macro. `cargo build`/`test`/`clippy` run without
any frontend precondition.

## Commands

- `just dev` — Vite dev server (port 1420, hot reload) + debug sidecar +
  the Electron shell pointed at `VITE_DEV_SERVER_URL`.
- `just build` — renderer bundle, Electron main/preload bundles, release
  sidecar binary (`fetch-pdfium` runs first so packaging has the library).
- `just build-debug` — same, with the debug sidecar (what E2E runs against).
- `just package [targets]` — electron-builder (`electron-builder.yml`)
  over the `just build` artifacts; default targets deb + rpm + AppImage,
  output in `dist-packages/`. The rpm needs the `rpm` package (rpmbuild)
  installed; the deb and AppImage targets are self-contained.
- `just check-deb` — the packaging gate (below).

## Electron runtime binary

Since electron 44, the npm package publishes no `postinstall` script, so
`pnpm install` no longer downloads the platform runtime binary on its own
(the old `install.js` postinstall is now the explicit `install-electron`
bin). The root `package.json` wires a `postinstall` hook that runs
`node node_modules/electron/install.js` to restore that behavior — it is
idempotent (exits early when `dist/` already matches the installed
version) and is what fresh clones, CI checkouts, and `just dev`/`just
test-e2e` rely on. If pnpm ever reports a missing
`node_modules/electron/dist`, run the hook manually:
`pnpm exec install-electron`.

## Electron bundles

`scripts/build-electron.mjs` produces `electron/dist/main.cjs` and
`electron/dist/preload.cjs`. `package.json`'s `main` points at the main
bundle; asset paths in main resolve relative to its own `__dirname`
(`frontend/dist` for the renderer, `resources/sidecar` for the packaged
sidecar).

## Packaging (electron-builder)

`electron-builder.yml` is the packaging source of truth; the version in
the root `package.json` is the released version. Layout in every bundle:

- `app.asar`: `electron/dist/**` + `frontend/dist/**` + `package.json`.
- `resources/sidecar/tuxbooks`: the release sidecar binary (kept outside
  the asar — it is a real process), with `libpdfium.so` next to it; the
  sidecar probes the executable's directory for PDFium
  (`sidecar/src/lib.rs pdfium_library_dirs`).
- Linux installs to `/opt/tuxbooks`, with the desktop entry at
  `usr/share/applications/tuxbooks.desktop` and hicolor icons from
  `build/icons/` (regenerate from `scripts/icon-source.png`, see
  brand/README.md).

`scripts/check-deb.sh` is the packaging regression gate: it verifies the
built deb's control metadata (package name, exact version match,
non-empty description, **no webkit dependency**), the extracted payload
(Electron binary + executable sidecar + PDFium resource), the desktop
entry (structure plus `desktop-file-validate` when installed), and
hicolor icons. `just check-deb` after `just package`; CI's build job runs
the deb target + gate on every push, and the release workflow gates the
published artifacts (docs/release.md).

## E2E runtime

There is no external browser driver to install: Playwright's Electron
launcher (`e2e/fixtures/electron-app.ts`) spawns the `electron` binary from
`e2e/node_modules` pointed at the built `electron/dist/main.cjs` and
attaches to it directly. The only runtime dependency is the OS-level
`xvfb` package for headless Linux runs (see docs/testing.md).
`just test-e2e-release` exercises the release sidecar path via
`TUXBOOKS_SIDECAR`; packaged-build smoke tests run the probe:
`TUXBOOKS_BOOT_PROBE=1 dist-packages/linux-unpacked/tuxbooks` with
`TEST_DATABASE_PATH`/`TEST_LIBRARY_PATH` set (the boot check is dev-only
except for that probe).

## PDFium shared library (PDF covers)

`pdf/render.rs` rasterizes PDF page 1 to a cover at import time using
`pdfium-render` (bindings-only); the actual `libpdfium.so` is downloaded
by `scripts/fetch-pdfium.sh` into `sidecar/pdfium/` (gitignored). Probe
order at runtime: `PDFIUM_LIB_DIR` → bundled resources → next to the
executable → the dev checkout's `sidecar/pdfium/` → the system loader.
When nothing binds, imports continue without PDF covers and the cover
tests skip. Bump `PDFIUM_BUILD` in the script when upgrading
pdfium-render.

Decision (migration phase 4): MuPDF.js in the renderer does **not**
replace this pipeline — renderer MuPDF rasterizes whole documents for the
reader, while import-time covers need a per-file, no-UI rasterization in
the sidecar; PDFium stays the import-time cover engine (docs/pdf.md).

## Debug-build performance

`[profile.dev.package."*"] opt-level = 2` compiles dependencies optimized
while tuxbooks code stays unoptimized for fast iteration. Without it,
unoptimized `lopdf`/`image`/`png` made a 25-PDF import take ~15s in dev
builds (vs ~3s release); with it, ~5s and cover rasterization stops being
the bottleneck. The same rationale applies to the sidecar under Electron.
