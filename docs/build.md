# Build and dev environment

**Migration state:** branch `web-reader-prototype-1` moves the shell from
Tauri to Electron. This doc describes the target build; legacy notes (at
the bottom) survive until migration phase 5 removes them.

## Electron + Vite

- `electron/main/` and `electron/preload/` are bundled TypeScript
  (electron-vite or Vite equivalents — wire the actual tooling before
  trusting any command here).
- Renderer: unchanged Vite build of `frontend/` (`frontend/dist`).
- Dev: `just dev` launches Electron against the Vite dev server with hot
  reload; the Rust sidecar is built (`cargo build --release` or a
  justfile-chosen profile) and spawned by main.
- `VITE_WDIO=1` remains the E2E frontend build flag (test hooks excluded
  from release builds).

## Rust sidecar build

The sidecar is a plain Rust binary from the former `src-tauri/` crate — no
`custom-protocol` feature, no `frontend/dist` embed, no Tauri context
macro. `cargo build`/`test`/`clippy` run without any frontend
precondition. The Electron main process locates the sidecar binary
(dev: target dir; packaged: bundled resource) — keep that resolution in
one place in main.

## Chromedriver for E2E

`wdio-electron-service` needs a chromedriver matching the app's Electron
version, and its own downloader hangs (the install promise never
settles). `scripts/fetch-chromedriver.sh` downloads the matching
Chrome-for-Testing build into `.build/chromedriver/` (gitignored,
version-stamped, idempotent); `just test-e2e` and friends run it
automatically. `CHROMEDRIVER_BUILD` overrides the resolved version.

## PDFium shared library (PDF covers)

Unchanged from the Tauri era: `pdf/render.rs` rasterizes PDF page 1 to a
cover at import time using `pdfium-render` (bindings-only); the actual
`libpdfium.so` is downloaded by `scripts/fetch-pdfium.sh` into
`src-tauri/pdfium/` (gitignored). Probe order at runtime:
`PDFIUM_LIB_DIR` → bundled resources → next to the executable → the dev
checkout's `src-tauri/pdfium/` → the system loader. When nothing binds,
imports continue without PDF covers and the cover tests skip. Bump
`PDFIUM_BUILD` in the script when upgrading pdfium-render. Re-evaluate at
migration phase 4 (MuPDF may replace this pipeline).

## Debug-build performance

`[profile.dev.package."*"] opt-level = 2` compiles dependencies optimized
while tuxbooks code stays unoptimized for fast iteration. Without it,
unoptimized `lopdf`/`image`/`png` made a 25-PDF import take ~15s in dev
builds (vs ~3s release); with it, ~5s and cover rasterization stops being
the bottleneck. The same rationale applies to the sidecar under Electron.

## Legacy (pre-migration, until phase 5)

- `--features custom-protocol` debug binaries embed `frontend/dist` via
  the Tauri context macro; bare cargo commands strip the feature and break
  E2E. Gone once the Tauri crate is removed.
- webkit2gtk env plumbing (`scripts/dev-env.sh` PKG_CONFIG_PATH /
  LD_LIBRARY_PATH for no-sudo dev machines) is Tauri/WebKitGTK-specific.
