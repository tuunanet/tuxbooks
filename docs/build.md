# Build and dev environment

## The `custom-protocol` feature

A plain `cargo build` debug binary opens `http://localhost:1420` — the Vite
dev server, not your code (an empty page if Vite isn't running). Binaries
that embed `frontend/dist` need the feature:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

`just build-debug` does this (and sets `VITE_WDIO=1`); `tauri build` does it
automatically.

Cargo feature unification bites here: `just check` / `just test-rust`
rebuild `target/debug/tuxbooks` WITHOUT the feature, and the
`test-e2e-empty` / `test-e2e-seeded` sub-recipes do not depend on
`build-debug`. Running them right after `just check` launches a binary that
loads the (absent) Vite dev server — every test fails with "Could not
connect to localhost". Run `just build-debug` first, or use `just test-e2e`,
which depends on it.

## `frontend/dist` must exist before cargo

The Tauri context macro embeds `frontend/dist` at compile time; `cargo
build`/`test`/`clippy` fail without it. `just frontend-dist` builds it on
demand. A fresh clone: `pnpm install && just frontend-dist` before Rust work.

## Dev machines without sudo

If webkit2gtk-4.1 was extracted to `~/.local` from .deb files,
`scripts/dev-env.sh` (used by the justfile) appends the right
`PKG_CONFIG_PATH`/`LD_LIBRARY_PATH` and only puts `~/.local/usr/bin` on
`PATH` when the system `WebKitWebDriver` is missing. On normal machines it
is a pass-through. Don't hardcode these paths.
