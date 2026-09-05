# TuxBooks

A local-first, bookshelf-style desktop ebook library for Linux
(additional desktop targets supported by Tauri). Point it at a folder of EPUB
files; it indexes
metadata and covers into a local SQLite database, keeps collections and reading
progress, and provides an EPUB reading experience.

## Stack

- **Desktop:** Tauri 2 + Rust (tokio, serde, sqlx/SQLite, thiserror, proptest)
- **Frontend:** React 19, TypeScript (strict), Vite, Tailwind CSS 4, shadcn/ui
- **Testing:** Vitest + React Testing Library, WebdriverIO + Tauri WebDriver, cargo test
- **Tooling:** pnpm, just, rustfmt, clippy, ESLint, Prettier, GitHub Actions

## Install

Prebuilt packages (deb, AppImage) are on the
[releases page](https://github.com/tuunanet/tuxbooks/releases) — TuxBooks is
pre-1.0, so releases are marked pre-release:

```sh
# Ubuntu/Debian
sudo apt install ./tuxbooks_<version>_amd64.deb
# Any other Linux — portable, no installation
chmod +x tuxbooks_<version>_amd64.AppImage && ./tuxbooks_<version>_amd64.AppImage
```

Verify downloads against `SHA256SUMS.txt` in the same release. See
[docs/release.md](docs/release.md) for how releases are cut and packaged.

## Getting started

Prerequisites: Node ≥ 22, pnpm 10, Rust (stable), Linux Tauri deps
(`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`).

```sh
pnpm install
git submodule update --init   # fetches the vendored foliate-js EPUB engine
just dev        # native window with hot reload
just build      # release bundle
```

## Commands

| Command                | Does                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `just dev`             | Run the app in dev mode (Vite + Tauri, hot reload)                 |
| `just build`           | Release build + bundle                                             |
| `just test`            | All unit tests (Rust + frontend)                                   |
| `just test-rust`       | `cargo test` (unit + integration + property tests)                 |
| `just test-frontend`   | Vitest in CI mode                                                  |
| `just test-e2e`        | Real-app desktop E2E — headless on Linux (Xvfb), no display needed |
| `just test-e2e-headed` | Same E2E on your visible display (debugging)                       |
| `just lint`            | clippy (`-D warnings`) + ESLint                                    |
| `just format`          | rustfmt + Prettier                                                 |
| `just check`           | format-check → lint → typecheck → tests (daily driver)             |
| `just ci`              | `check` + E2E + release build + packaging gate (what CI runs)      |
| `just package-check`   | Build the deb and verify its contents (docs/release.md)            |

Individual pieces: `pnpm dev`, `pnpm tauri dev`, `pnpm --filter frontend test`,
`cargo test --manifest-path src-tauri/Cargo.toml`.

E2E needs the Linux packages `xvfb` and `webkit2gtk-driver`
(`sudo apt install xvfb webkit2gtk-driver` on Debian/Ubuntu) plus
`cargo install tauri-driver`. `just test-e2e` is safe to run from SSH, CI, or
anywhere without a desktop session. See [docs/testing.md](docs/testing.md).

## Layout

```
frontend/          React app (presentation only)
src-tauri/         Rust: commands/ domain/ services/ repository/ db/ epub/
src-tauri/migrations/  SQLx migrations (embedded, run automatically)
e2e/               WebdriverIO suites, environment bootstrap, watchdog
tests/fixtures/    committed test data (books/minimal.epub, books/minimal.pdf)
artifacts/e2e/     E2E failure artifacts (screenshots, logs; gitignored)
docs/              architecture, database, epub, testing
scripts/           fixture/icon generators, env helper
```

## Documentation

Start with [docs/architecture.md](docs/architecture.md), then
[docs/database.md](docs/database.md), [docs/epub.md](docs/epub.md), and
[docs/testing.md](docs/testing.md). Agents: read `AGENTS.md` first.

## License

GPL-3.0-or-later — see [LICENSE.md](LICENSE.md).
