# AGENTS.md

Instructions for coding agents working in this repository. Verified commands
only — run them, don't assume.

## What this project is

Local-first desktop ebook library (bookshelf style). **Rust is the
application/domain language; React/TypeScript is only the presentation layer.**

- Business logic goes in Rust (`domain/`, `services/`), never in React
  components.
- UI logic stays in TypeScript, never in Rust.
- Tauri commands (`src-tauri/src/commands/`) are IPC boundaries: they translate
  requests into service calls. No business logic there.
- Database access only through `repository/`. SQL never appears in commands,
  services, or the frontend.
- `epub/` and `domain/` must stay independent of Tauri (they never import it).
- Do not silently change these architectural conventions.

## Commands (in this order)

```sh
pnpm install          # first thing after cloning
just check            # daily driver: format-check -> lint -> typecheck -> all unit tests
just dev              # launch the app (Tauri + Vite hot reload)
just test-e2e         # real-app desktop E2E, headless on Linux (builds first)
just test-e2e-headed  # same E2E on the visible display (debugging only)
just ci               # everything CI runs: check + e2e + release build
```

Single layers:

```sh
just test-rust                      # cargo test
cargo test --manifest-path src-tauri/Cargo.toml <test_name>   # one test
just test-frontend                  # vitest run (CI mode)
pnpm --filter frontend exec vitest run <file-or-pattern>      # one frontend test
pnpm --filter frontend dev          # vite only, no Tauri
```

Run `just check` (or at minimum the relevant test layer) before declaring any
task complete, and run `just format` if you touched formatting-sensitive code.

### E2E contract for agents

`just test-e2e` is **safe to run from an automated environment** (SSH, CI,
containers, no desktop session). It provisions its own virtual display via
`xvfb-run`, builds the app, runs both suites against the real Tauri binary,
always terminates (watchdog + `timeout` guard), returns a non-zero exit code
on failure, and leaves failure artifacts (screenshots, wdio/driver logs) in
`artifacts/e2e/<runId>/`. You never need to: launch the app, start or
configure Xvfb/DISPLAY, click anything, or clean up stale processes — but do
not launch a second E2E run while one is still going.

## Non-obvious gotchas (each one has bitten before)

1. **Debug binaries load the dev server, not your code.** A plain
   `cargo build` binary opens `http://localhost:1420` (empty page if Vite isn't
   running). Binaries that embed `frontend/dist` need the feature:
   `cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol`.
   `just build-debug` does this; `tauri build` does it automatically.
2. **`frontend/dist` must exist before `cargo build/test/clippy`.** The Tauri
   context macro embeds it at compile time. `just frontend-dist` builds it on
   demand. A fresh clone: `pnpm install && just frontend-dist` before Rust work.
3. **SQLx is runtime-query only.** Do not introduce `sqlx::query!` macros —
   they require a live `DATABASE_URL` and `sqlx prepare`. Use `sqlx::query` /
   `query_as` with `FromRow` types.
4. **Migrations are embedded** via `sqlx::migrate!()` (crate-relative
   `src-tauri/migrations/`). Add numbered `.sql` files; never create schema
   procedurally at runtime.
5. **FTS5 is trigger-synced.** `books_fts` is an external-content table kept in
   sync by triggers in `0002_books_fts.sql`. If you change `books` columns
   covered by the index, update those triggers and the search test
   `updating_book_keeps_fts_index_in_sync` must still pass.
6. **Vitest mock hoisting:** `vi.mock("@tauri-apps/api/core", ...)` must be
   called in each test file (vitest hoists it above imports). Mocking it only
   in a helper module does not work — app code will import the real module.
7. **React lint rule `react-hooks/set-state-in-effect`**: no synchronous
   `setState` inside effects. Do state updates after an `await` (see
   `frontend/src/hooks/useLibrary.ts` for the pattern).
8. **E2E driver chain and protocol:** `@wdio/tauri-service` (external
   provider) spawns `tauri-driver`, which relays to WebKitWebDriver and the
   app. Ports are probed and auto-allocated — never hardcode 4444/4445 in
   specs. Capability sets `"wdio:enforceWebDriverClassic": true` —
   WebKitWebDriver has no BiDi support.
9. **E2E env must be set before the driver spawns.** The app inherits the
   driver's environment, so `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH` are
   set in config `onPrepare` (which runs before the service's `onPrepare`).
   Keep it that way.
10. **This dev machine may lack sudo.** If webkit2gtk-4.1 was extracted to
    `~/.local` from .deb files, `scripts/dev-env.sh` (used by the justfile)
    appends the right `PKG_CONFIG_PATH`/`LD_LIBRARY_PATH` and only puts
    `~/.local/usr/bin` on `PATH` when the system `WebKitWebDriver` is missing.
    On normal machines it is a pass-through. Don't hardcode these paths.
11. **The Tauri app can outlive `tauri-driver` at teardown.** E2E arms a
    detached watchdog (`e2e/setup/watchdog.mjs`) that reaps leftover
    app/driver processes and SIGKILLs a wedged launcher; the justfile adds an
    outer `timeout` guard. If you touch E2E teardown, keep both layers — a
    leftover app holding the stdout pipe wedges the whole invocation.
12. **`tauri-plugin-wdio` is debug-only test infrastructure.** Registered
    under `#[cfg(debug_assertions)]` in `lib.rs`; the frontend bridge is only
    bundled when `VITE_WDIO=1` (set by `just build-debug`). Release builds
    must never include it, but the crate stays a non-optional dependency so
    the `wdio:default` capability permission resolves in every build.
13. **`xvfb-run` alone is not headless on a Wayland desktop.** It only
    overrides `DISPLAY`; a GTK3 app still prefers an inherited
    `WAYLAND_DISPLAY` and pops up on the real screen. The headless E2E
    prefix therefore also does `env -u WAYLAND_DISPLAY GDK_BACKEND=x11` —
    keep that when touching the justfile or running phases manually.
14. **`cargo test` invalidates the E2E binary.** `just check` /
    `just test-rust` rebuild `target/debug/tuxbooks` WITHOUT the
    `custom-protocol` feature (cargo feature unification), and the
    `test-e2e-empty` / `test-e2e-seeded` sub-recipes do not depend on
    `build-debug`. Running them right after `just check` launches a binary
    that loads the (absent) Vite dev server — every test fails with
    "Could not connect to localhost". Run `just build-debug` first, or use
    `just test-e2e`, which depends on it.
15. **PDF reader invariants** (see `docs/pdf.md` for the full contract):
    `frontend/src/lib/pdf/pdfEngine.ts` is the only module that imports
    `pdfjs-dist`; rendering is serialized (one page at a time, reading
    anchor first — the worker is single-threaded, so concurrent renders are
    FIFO starvation); the visible canvas is written only by the final blit
    of an offscreen-buffer render (never paint into it directly); reading
    position writes are debounced and page-number-based. Behavior is pinned
    by stable DOM attributes (`data-pdf-slot`, `data-render-state`,
    `data-pdf-worker-src`) — keep them when refactoring.

## Testing rules

- Tests must never read or write the user's real ebook library or real app
  database. Use `tempfile::tempdir()` (Rust) and the `TEST_*` env overrides
  (app/E2E). No global mutable test state; parallel tests get isolated dirs/DBs.
- Test fixture books live in `tests/fixtures/books/` and are regenerated by
  `python3 scripts/make-fixture.py` (writes `minimal.epub` and `minimal.pdf`).
  Never download copyrighted books; fixture content is original.
- Add or update tests when changing behavior. Meaningful behavior only — no
  coverage-filler tests. Property tests (`proptest`) exist for parser
  crash-safety and scanner extension filtering; keep those invariants intact.
- Frontend tests mock the Tauri IPC (see `frontend/tests/mocks/tauri.ts`) and
  must run without a Tauri app: `pnpm --filter frontend test:ci`.
- E2E runs two isolated invocations: empty library (`test:empty`) and seeded
  fixture library (`E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded`). Both
  get a unique temp database/library per run (`e2e/setup/environment.ts`);
  never point them at a real library.

## Dependencies

- No new dependency (Rust crate or npm package) without a clear, stated reason.
- UI primitives come from shadcn/ui (`pnpm dlx shadcn add <component>`;
  config in `frontend/components.json`, radix-nova style); icons from
  `lucide-react`. Do not hand-roll SVG icons or primitive replacements.
- No network services, Docker, PostgreSQL, Redis, or backend server — this is a
  local-first desktop app. SQLite only.
- Do not suppress lints globally. A targeted `eslint-disable` needs a reason
  comment (the shadcn `*Variants` exports in `components/ui/` are the known
  cases).
- TypeScript is strict; `any` is banned via lint rule.

## Conventions

- Rust: modules per the table in `docs/architecture.md`; errors via
  `thiserror` enums (`AppError` at the boundary, `EpubError`/`ScanError` in
  layers); IPC DTOs serialize `camelCase`.
- Frontend: components grouped by feature under `src/components/`; the only
  file allowed to call Tauri's `invoke` is `src/lib/tauri.ts`; use the `@/`
  path alias for cross-directory imports.
- Docs in `docs/` describe the architecture contract — update them when you
  change module boundaries, schema, or the EPUB layer.

## Working documents

Read the one that fits the task; each is short.

- `docs/STANDARDS.md` describes coding standards.
