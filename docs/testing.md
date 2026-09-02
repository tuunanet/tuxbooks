# Testing

Four layers, all runnable locally via `just`:

| Layer             | Command              | What it covers                        |
| ----------------- | -------------------- | ------------------------------------- |
| Rust unit/prop    | `just test-rust`     | parsers, scanner, repos, search, db   |
| Rust integration  | `just test-rust`     | fixture → scan → DB → search slice    |
| Frontend (Vitest) | `just test-frontend` | shell, library view, mocked IPC       |
| E2E (WebdriverIO) | `just test-e2e`      | real binary, real window, real SQLite |

## Timeouts and termination

Every test invocation is guaranteed to terminate; a wedged run is killed,
never left blocking development. Healthy runtimes are a small fraction of
each bound.

| What                       | Guard                                              |
| -------------------------- | -------------------------------------------------- |
| Unit tests (rust/frontend) | `timeout 900` wrapper in the justfile (linux only) |
| E2E phase                  | `timeout 300` wrapper in the justfile              |
| Single E2E test            | `mochaOpts.timeout` 120s (`wdio.conf.ts`)          |
| E2E teardown               | watchdog (`e2e/setup/watchdog.mjs`), see below     |
| CI jobs                    | `timeout-minutes` per job in `.github/workflows`   |

The E2E watchdog reaps the app, `tauri-driver`, `WebKitWebDriver`, and —
for headless phases (`E2E_XVFB=1`) — the phase's private `Xvfb` server if
`timeout` had to SIGKILL `xvfb-run` before its own cleanup. The sweep only
kills processes that predate the watchdog, so the next phase's processes
(`just test-e2e` runs two phases back to back) are never caught by the
previous phase's teardown. `onPrepare` additionally sweeps stale
app/driver processes so a crashed run cannot poison the next one.

## Parallelism

- `just check` runs five independent toolchains concurrently via
  `scripts/run-parallel.sh` (rust fmt+clippy+tests, vitest, eslint, tsc,
  prettier); wall time is the slowest stream (usually rust). `just test`
  runs the cargo and vitest layers concurrently the same way. Cargo work
  stays in a single stream: parallel cargo commands only block each other
  on the target-dir file lock.
- Within layers, parallelism is already the default: cargo runs test
  threads, vitest runs worker processes.
- E2E phases stay sequential on purpose. Specs share one app session per
  phase (`maxInstances: 1`), and every session in a run inherits the
  phase's scratch env (`TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH` are set
  launcher-side before the driver spawns) — per-spec isolation would need
  env injection at driver-spawn time, which the external provider does not
  offer. Scaling path when the E2E suite grows: split more specs into
  phases, or move to the embedded driver provider which can per-session
  env. The stale-process sweep and watchdog kill by binary name, so two
  concurrent E2E invocations would kill each other — never run them in
  parallel.

## Rust (`cargo test`)

- Tests live next to the code (`#[cfg(test)] mod tests`) plus
  `src-tauri/tests/vertical_slice.rs` for the full slice.
- Property tests (`proptest`): `parse_epub` never panics on arbitrary
  bytes; the scanner only ever reports `*.epub` files.
- Filesystem and database tests use `tempfile::tempdir()` — they never
  touch the user's library or home directory. Tests run in parallel and
  each gets its own temp dir/database, so there is no shared state.
- Tests run with `--features custom-protocol` (see `just test-rust`) so
  the debug binary keeps the build-debug feature set; for a single test:
  `cargo test --manifest-path src-tauri/Cargo.toml --features
custom-protocol <test>`.
- Before the first `cargo test`/`clippy` on a fresh clone, build the
  frontend once (`just frontend-dist`): the Tauri context macro embeds
  `frontend/dist` at compile time.

## Frontend (Vitest + RTL)

`pnpm --filter frontend test:ci` (watch mode: drop `:ci`).

- Environment: `jsdom`, matchers from `@testing-library/jest-dom/vitest`,
  automatic `cleanup()` via `tests/setup.ts`.
- The Tauri API is mocked at the boundary: each test file hoists
  `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))` and
  routes responses with `tests/mocks/tauri.ts::mockInvoke`.
  Tests never require a running Tauri app. The mock must be declared in
  each test file — vitest hoists `vi.mock` above imports, so declaring it
  only in a helper module does not work (app code would import the real
  module).
- `tests/factories.ts::makeBook` builds canonical `Book` fixtures.
- PDF reader tests use additional fakes (all in `tests/mocks/`):
  - `pdfEngine.ts` — fake PDF.js documents with per-page sizes, held
    renders (`holdRenderFor` + `releaseRender`), fail-once renders, and
    cancellation tracking; every file still hoists its own
    `vi.mock("@/lib/pdf/pdfEngine", ...)`.
  - `intersectionObserver.ts` — deterministic IntersectionObserver fake;
    tests fire entries per element/observer instead of relying on layout.
  - `dom.ts` — scroll-container geometry stubs (fixed viewport, document
    rect moving with `scrollTop`) for the scroll-tracking tests.
- jsdom gaps papered over in `tests/setup.ts`: pointer capture,
  `scrollIntoView`, `ResizeObserver` (no-op), `IntersectionObserver`
  (the fake), and `canvas.getContext` (returns a stub context).

## E2E (WebdriverIO + @wdio/tauri-service)

`just test-e2e` runs the **real desktop app** headlessly — no display, no
desktop session, safe from SSH/CI/agent environments. `just test-e2e-headed`
runs the same suites on your visible display for debugging.

Stack: `@wdio/tauri-service` → external `tauri-driver` → WebKitWebDriver →
the debug binary built by `just build-debug` (`cargo build --features
custom-protocol` + `VITE_WDIO=1` frontend build; without the feature a
debug binary would load the Vite dev server instead of embedded assets).
Capability sets `"wdio:enforceWebDriverClassic": true` — WebKitWebDriver
has no BiDi support. Driver ports are probed and auto-allocated — never
hardcode 4444/4445 in specs. `just check` / `just test-rust` rebuild the
binary without the `custom-protocol` feature (cargo feature unification),
so run `just build-debug` first — see [build.md](build.md).

The app inherits the driver's environment, so `TEST_DATABASE_PATH` /
`TEST_LIBRARY_PATH` must be set in the wdio config `onPrepare`, which runs
before the service's `onPrepare` spawns the driver — keep that ordering.

Two isolated invocations per run:

1. **empty** (`test:empty`) — fresh scratch env; asserts the app shell,
   sidebar, window title, the empty-library state, and Settings navigation.
2. **seeded** (`test:seeded`, `E2E_SEED_LIBRARY=1`) — copies the four
   committed fixtures (`minimal.epub`, `minimal.pdf`, `large.pdf` — 100
   pages, `mixed.pdf` — six page sizes) into the scratch library; the app
   imports them on startup. Runs `books.e2e.ts` (library navigation: cards,
   stats, EPUB detail, PDF reader shell) and `pdf-reader.e2e.ts`
   (continuous-reader scenarios: fit-width canvas geometry, scroll-driven
   page tracking, bounded canvas count while scrolling a 100-page document
   with eviction, deep-zoom position preservation, mixed page sizes, the
   reopen-restore persistence acceptance test, and a PDF.js worker-asset
   check).

Scroll interactions drive the reader's scroll container (`reader-content`)
with offsets derived from live slot geometry — never hard-coded pixels.

### Headless on Linux (Xvfb)

On Linux the justfile wraps every phase in
`env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run --auto-servernum`, which
provisions a private virtual display for the whole invocation chain
(driver + app inherit it). Nothing needs `DISPLAY`, a window manager, or a
logged-in session. The equivalent manual invocation is:

```sh
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run --auto-servernum \
  env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded
```

The `env -u WAYLAND_DISPLAY` part is **not optional on Wayland desktops**:
`xvfb-run` only overrides `DISPLAY`, but a GTK3 app launched with
`WAYLAND_DISPLAY` still in its environment prefers the Wayland compositor —
the test window then pops up on the real screen while Xvfb sits unused
(tests still pass, since WebDriver automation is display-independent).
`GDK_BACKEND=x11` pins the choice.

Why not WebdriverIO's built-in `autoXvfb`: it only wraps wdio _worker_
processes, but with `maxInstances: 1` the tauri-service spawns tauri-driver
from the _launcher_ process, which would never see the virtual display.
Wrapping the whole invocation is the explicit, reliable mechanism.
Alternatives considered: the `embedded` driver provider (WebDriver server
compiled into the app via `tauri-plugin-wdio-webdriver`) removes tauri-driver
and WebKitWebDriver entirely but swaps the battle-tested WebKitWebDriver for
a newer in-app implementation; the external provider keeps the proven path.

Linux prerequisites (Debian/Ubuntu):

```sh
sudo apt install xvfb webkit2gtk-driver   # Xvfb + WebKitWebDriver
cargo install tauri-driver                # WebDriver relay (~/.cargo/bin)
```

### Isolation, cleanup, termination

Everything lives in `e2e/setup/` (`environment.ts` single bootstrap,
`fixtures.ts` paths, `watchdog.mjs` termination guard):

- Each invocation gets a unique scratch dir under `$TMPDIR`
  (`/tmp/tuxbooks-e2e-<runId>/`): its own SQLite database, library dir, and
  seeded fixtures. Nothing ever reads a real user library; production
  app-data paths are only used when `TEST_DATABASE_PATH`/`TEST_LIBRARY_PATH`
  are unset.
- `onPrepare` (before the service spawns anything) kills stale app and
  `tauri-driver` processes left by crashed runs — a leftover app would grab
  the new automation session. Driver ports are probed and picked free by the
  service, so stale listeners cannot collide.
- The Tauri app can outlive `tauri-driver`; a detached watchdog
  (`watchdog.mjs`, armed in `onComplete`) reaps leftover app/driver
  processes once the run finishes and SIGKILLs a wedged launcher after 45s.
  Each phase is additionally bounded by `timeout --kill-after=15 600` in the
  justfile, so `just test-e2e` always terminates and always returns a
  meaningful exit code.
- Failed tests capture a screenshot into `artifacts/e2e/<runId>/`
  (gitignored, pruned after 7 days) next to the per-run wdio/driver logs;
  backend and frontend console logs are forwarded into those logs by
  `tauri-plugin-wdio` (debug-only test infrastructure: the plugin is
  registered under `#[cfg(debug_assertions)]` in `lib.rs` and the frontend
  bridge is only bundled when `VITE_WDIO=1`, set by `just build-debug` —
  release builds must never include it. The crate stays a non-optional
  dependency so the `wdio:default` capability permission resolves in every
  build).
- WebKitGTK quirk: WebDriver `getText` walks the accessibility tree and
  omits text inside `line-clamp`/`truncate` boxes, so specs assert on DOM
  `textContent` for book and reader titles.
- Do not run two E2E invocations concurrently on the same machine: the
  stale-process sweep intentionally kills matching app/driver processes.

## Test data rules

- Fixtures are committed under `tests/fixtures/books/` and generated by
  `scripts/make-fixture.py` (original content only — no copyrighted books,
  ever). Deterministic: byte-identical across runs (no timestamps), so
  imported book ids stay stable. Current set: `minimal.epub`,
  `minimal.pdf` (3 pages), `large.pdf` (100 pages, virtualization proof),
  `mixed.pdf` (six MediaBoxes, per-page geometry).
- Exception: `tests/fixtures/books/EBooks/` holds a real user-created
  library (real copyrighted files). It is gitignored and must never be
  committed. `src-tauri/tests/realistic_library.rs` runs against it and
  skips itself when the directory is absent; `REALISTIC_LIBRARY_PATH`
  overrides its location.
- `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH` / `REALISTIC_LIBRARY_PATH`
  are the only override hooks; production code resolves the OS app-data
  dir when the first two are unset.
