# Build and dev environment

## The `custom-protocol` feature

A plain `cargo build` debug binary opens `http://localhost:1420` — the Vite
dev server, not your code (an empty page if Vite isn't running). Binaries
that embed `frontend/dist` need the feature:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

`just build-debug` does this (and sets `VITE_WDIO=1`); `tauri build` does it
automatically. Every cargo invocation in the justfile pins the feature —
`just test-rust` and `just lint-rust` included — so `just check` leaves
`target/debug/tuxbooks` E2E-capable and the `test-e2e-empty` /
`test-e2e-seeded` sub-recipes (which do not depend on `build-debug`) work
right after it.

The trap survives as: any **bare** `cargo build`/`test`/`clippy` (outside
the justfile) rebuilds the binary without the feature. If E2E fails with
"Could not connect to localhost", run `just build-debug` and retry.

## `frontend/dist` must exist before cargo

The Tauri context macro embeds `frontend/dist` at compile time; `cargo
build`/`test`/`clippy` fail without it. `just frontend-dist` builds it on
demand. A fresh clone: `pnpm install && just frontend-dist` before Rust work.

## PDFium shared library (PDF covers)

`pdf/render.rs` rasterizes PDF page 1 to a cover at import time using
`pdfium-render`, which is bindings-only: the actual `libpdfium.so` is
downloaded by `scripts/fetch-pdfium.sh` (bblanchon/pdfium-binaries, pinned
to the build pdfium-render's `pdfium_latest` feature targets) into
`src-tauri/pdfium/` (gitignored). `just fetch-pdfium` runs it; `just
test-rust`, `just build-debug`, and `just build` run it automatically. CI
fetches explicitly in the rust / build / release jobs.

Probe order at runtime (`pdfium_library_dirs` in `lib.rs`):
`PDFIUM_LIB_DIR` → bundled resources (`<resource_dir>/pdfium/`, present in
deb/rpm builds) → next to the executable → the dev checkout's
`src-tauri/pdfium/` → the system loader. When nothing binds, imports
continue without PDF covers and the cover tests skip — plain `cargo test`
outside the justfile therefore passes, just with skips. Bump
`PDFIUM_BUILD` in the script when upgrading pdfium-render so the library
matches the generated bindings.

## Dev machines without sudo

If webkit2gtk-4.1 was extracted to `~/.local` from .deb files,
`scripts/dev-env.sh` (used by the justfile) appends the right
`PKG_CONFIG_PATH`/`LD_LIBRARY_PATH` and only puts `~/.local/usr/bin` on
`PATH` when the system `WebKitWebDriver` is missing. On normal machines it
is a pass-through. Don't hardcode these paths.

## Debug-build performance

`[profile.dev.package."*"] opt-level = 2` in `src-tauri/Cargo.toml` compiles
dependencies optimized while `tuxbooks` code stays unoptimized for fast
iteration. Without it, unoptimized `lopdf`/`image`/`png` made a 25-PDF
import take ~15s in dev builds (vs ~3s release); with it, the same import
runs ~5s and cover rasterization stops being the bottleneck.
