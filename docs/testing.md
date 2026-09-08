# Testing

Four layers, all runnable locally via `just`:

| Layer             | Command              | What it covers                                                            |
| ----------------- | -------------------- | ------------------------------------------------------------------------- |
| Rust unit/prop    | `just test-rust`     | parsers, scanner, repos, search, db, watcher batching, progress migration |
| Rust integration  | `just test-rust`     | fixture → scan → DB → search slice; filesystem sync scenarios             |
| Frontend (Vitest) | `just test-frontend` | shell, library view, mocked IPC bridge                                    |
| E2E (WebdriverIO) | `just test-e2e`      | real Electron binary, real window, real SQLite                            |

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

The E2E watchdog reaps the app tree (including Chromium's helper
processes from the Electron dist), sidecar, chromedriver, orphaned wdio
workers, and the phase's private Xvfb left by a wedged run; it only kills
processes that predate the watchdog, so the next phase's processes are
never caught by the previous phase's teardown. `onPrepare` additionally
SIGKILLs stale app/helper/driver/worker processes so a crashed run
cannot poison the next one, and prunes scratch dirs older than 24h
(left behind only by a machine crash or a kill before the watchdog arms).

## Parallelism

- `just check` runs independent toolchains concurrently via
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
  launcher-side before the app spawns). The stale-process sweep and
  watchdog kill by binary name, so two concurrent E2E invocations would
  kill each other — never run them in parallel.

## Rust (`cargo test`)

- Tests live next to the code (`#[cfg(test)] mod tests`) plus the
  integration tests (`src-tauri/tests/`).
- Property tests (`proptest`): `parse_epub` never panics on arbitrary
  bytes; the scanner only ever reports `*.epub` files. Keep those
  invariants intact.
- Progress-migration tests (required, phase 3): representative foliate
  records — beginning of book, mid-chapter, chapter boundary, last-read,
  varied spine structures, large chapters, reflowable + fixed-layout,
  malformed/stale locators, missing EPUB files, older-version records —
  each asserted to land the Readium reader at the same **logical**
  location (small pagination drift allowed). See
  [epub.md](epub.md), [electron-migration.md](electron-migration.md).
- `src-tauri/tests/library_sync.rs` drives the real `notify` watcher
  against a real database in tempdirs. These tests need the tokio runtime
  to be multi-threaded (`#[tokio::test(flavor = "multi_thread")]`):
  watcher threads drive sqlx work via `Handle::block_on`, which deadlocks
  on the current-thread runtime.
- Filesystem and database tests use `tempfile::tempdir()` — they never
  touch the user's library or home directory. Tests run in parallel and
  each gets its own temp dir/database, so there is no shared state.
- No Tauri context macro and no `custom-protocol` feature anymore: cargo
  tests run without any frontend precondition.

## Frontend (Vitest + RTL)

`pnpm --filter frontend test:ci` (watch mode: drop `:ci`).

- Environment: `jsdom`, matchers from `@testing-library/jest-dom/vitest`,
  automatic `cleanup()` via `tests/setup.ts`.
- The IPC bridge is mocked at the boundary: each test file hoists
  `vi.mock` over the preload-bridge module and routes responses with
  `tests/mocks/`. Tests never require a running Electron app. The mock
  must be declared in each test file — vitest hoists `vi.mock` above
  imports, so declaring it only in a helper module does not work (app code
  would import the real module).
- `tests/factories.ts::makeBook` builds canonical `Book` fixtures.
- Reader tests use additional fakes (all in `tests/mocks/`):
  - `readiumEngine.ts` / `pdfEngine.ts` — fake engines (per-page sizes,
    held renders, fail-once renders, cancellation tracking, locator
    round-trips); every file still hoists its own `vi.mock` over the seam.
  - `intersectionObserver.ts` — deterministic IntersectionObserver fake;
    tests fire entries per element/observer instead of relying on layout.
  - `dom.ts` — scroll-container geometry stubs (fixed viewport, document
    rect moving with `scrollTop`) for the scroll-tracking tests.
- jsdom gaps papered over in `tests/setup.ts`: pointer capture,
  `scrollIntoView`, `ResizeObserver` (no-op), `IntersectionObserver`
  (the fake), and `canvas.getContext` (returns a stub context).

## Rules for agents

- Tests must never read or write the user's real ebook library or real
  app database: `tempfile::tempdir()` in Rust, the `TEST_*` env
  overrides in app/E2E. Parallel tests get isolated dirs/DBs; no global
  mutable test state.
- Add or update tests when changing behavior — meaningful behavior
  only, no coverage-filler tests. Keep the `proptest` invariants
  (parser crash-safety, scanner extension filtering) intact.
- The coverage gate (`docs/coverage.md`) is part of the contract:
  frontend floors fail any vitest run, Rust floors run via
  `just coverage`.
- Never download copyrighted books; fixture content is original
  (generated by `scripts/make-fixture.py` / `make-epub-fixtures.py`,
  size budget enforced by `just check-epub-fixtures`).

## E2E (WebdriverIO against Electron)

`just test-e2e` runs the **real desktop app** headlessly — no display, no
desktop session, safe from SSH/CI/agent environments. `just
test-e2e-headed` runs the same suites on your visible display for
debugging.

Stack: `@wdio/electron-service` (the first-party, scoped successor of the
community `wdio-electron-service`; the unscoped name is deprecated) launches
the unpackaged app (the electron binary from `e2e/node_modules` pointed at
the built `electron/dist/main.cjs`) and manages a chromedriver matching the
Electron version. Driver **resolution** is service-managed: the service
derives the Electron version from the installed `electron` package and the
matching Chrome-for-Testing build id. Only the **download** goes through the
repo's deterministic fetcher (`e2e/setup/fetch-chromedriver.mjs`) into a
pinned, gitignored cache (`.build/chromedriver-cache/`), because wdio-utils'
own `@puppeteer/browsers` downloader hangs on some networks and a killed
download poisons its cache (the fetcher + the `onPrepare` pruner make the
setup self-healing — see `docs/build.md` for the full story). WebdriverIO
stays on the current 9.x line — a WebdriverIO 10 does not exist yet; the
service's own versioning (10.x) is independent. Driver ports are probed and
auto-allocated — never hardcode 4444/4445 in specs.

Version determinism is logged and checked at startup (see
`e2e/setup/versions.ts`): every run writes the Electron, Chromium, chromedriver,
WebdriverIO, and service versions into the run banner and
`artifacts/e2e/<runId>/environment.json`, and a worker-side sanity check
fails with a clear error when the chromedriver that actually connected does
not match the Chromium build the installed Electron maps to. Do not silence
that check to make a run pass — fix the driver resolution instead.

The worker `before` hook also runs an **isolation gate**: it verifies
`TEST_DATABASE_PATH` points at this run's scratch dir and that the sidecar
actually wrote the schema there before any test executes. This exists
because wdio logs launcher-hook errors and then CONTINUES the run — without
the gate, a broken `onPrepare` would silently test against the real user
library. If the gate fires, fix the launcher failure; never bypass the
gate.

Two Chromium-only traps are pinned in the harness: the app launches with
`--ozone-platform=x11` (a Wayland desktop is reachable through the
compositor socket even with `WAYLAND_DISPLAY` unset — without the pin, E2E
windows land on the real desktop), and the teardown watchdog
(`e2e/setup/watchdog.mjs`) is armed in `onPrepare`, so an aborted run
still sweeps the app tree, sidecar, chromedriver, and the phase's private
Xvfb the moment the launcher dies. Sweep patterns are precise binary
paths — a coarse pattern raced and killed the next phase's recipes once.

Each spec file gets a fresh app instance against the shared scratch
library; the previous instance's sidecar is reaped via `PR_SET_PDEATHSIG`
(armed in the service binary) — without it, orphaned sidecars kept
watching the library and raced the live one for imports.

The app inherits the launcher's environment, so `TEST_DATABASE_PATH` /
`TEST_LIBRARY_PATH` must be set in the wdio config `onPrepare` — keep that
ordering.

Two isolated invocations per run:

1. **empty** (`test:empty`) — fresh scratch env; asserts the app shell,
   sidebar, window title, the empty-library state, and Settings navigation.
2. **seeded** (`test:seeded`, `E2E_SEED_LIBRARY=1`) — copies the committed
   fixtures (`minimal.epub`, `minimal.pdf`, `large.pdf` — 100 pages with a
   nested 15-entry outline, `mixed.pdf` — six page sizes) into the scratch
   library; the app imports them on startup. Runs `books.e2e.ts` (library
   navigation: cards, stats, EPUB detail, PDF reader shell),
   `engine-smoke.e2e.ts` (fast deterministic proof that each renderer
   initialized end to end: engine ready → metadata/geometry → visible
   content → location/progression; PDF adds worker-asset reachability,
   page navigation, zoom — fails quickly and clearly when an engine or
   asset breaks) and `pdf-reader.e2e.ts` (continuous-reader scenarios:
   fit-width canvas geometry, scroll-driven page tracking, bounded canvas
   count while scrolling a 100-page document with eviction, deep-zoom
   position preservation, mixed page sizes, outline navigation, the bounded
   virtualized thumbnails sidebar with current-page synchronization, the
   reopen-restore persistence acceptance test, the worker-asset check, and
   bitmap-cache budget assertions after the scroll-oscillation stress) and
   `epub-reader.e2e.ts` (chapter navigation, arrow-key page turns, MathML,
   appearance preferences, the reopen-restore acceptance test, in-book
   search, and the exact-locator persistence regression: the engine's CFI
   is captured before close and must come back identical on reopen) and
   `progress-migration.e2e.ts` (seeds the scratch database with
   reading-progress rows in the previous app's format — canonical foliate
   CFI + chapter href + percent, and PDF page rows — and asserts the same
   LOGICAL location restores: beginning, chapter boundary, late book, a
   stale row degrading to a defined state, the PDF page; mid-chapter
   offsets and multi-structure corpora stay in the Rust tier) and
   `reader-lifecycle.e2e.ts` (document-type switching, rapid repeated
   open/close, close-while-rendering recovery, rapid navigation
   convergence, window-resize re-anchoring, and memory-bound assertions)
   and `annotations.e2e.ts` (a PDF highlight created from a real
   text-layer selection, its attached note, and a bookmark on both
   formats, each revisited after close/reopen) and `metadata.e2e.ts`
   (edit → grid/detail/search update, source bytes untouched, reset round
   trip) and `collections.e2e.ts` (create a collection from the sidebar,
   add and remove a book through the card context menu, mark a book
   finished, delete the collection).

Two more invocations exist beyond the default pair:

- **hidpi** (`just test-e2e-hidpi`) — the seeded reader scenarios against
  an app forced to `devicePixelRatio` 2 (`E2E_DEVICE_SCALE_FACTOR` →
  `--force-device-scale-factor`): the doubled backing stores, the PERF-1
  caps at the high-DPI reference condition, and a rapid page-turn sweep
  staying inside the render budget. Xvfb cannot emulate refresh rates
  above 60 Hz — the dpr dimension is what this configuration guards.
- **release flavor** (`just test-e2e-release`) — empty + seeded against the
  RELEASE sidecar binary via `TUXBOOKS_SIDECAR` (the packaged-app resource
  resolution path; full electron-builder packaging lands in migration
  phase 5, docs/electron-migration.md). A build that works from the source
  tree but loses its sidecar/resources in production form fails here.

Scroll interactions drive the reader's scroll container (`reader-content`)
with offsets derived from live slot geometry — never hard-coded pixels.

### Benchmark suite (headed, opt-in)

`just bench-reader [WxH]` runs `bench-reader.e2e.ts` — the suite that
MEASURES instead of asserting structure. It is excluded from
`test:empty`/`test:seeded` and from CI by policy (headless timings are
unreliable; `docs/performance.md` — E2E asserts deterministic attributes
only), runs headed on the real display with the window maximized (explicit
`WxH` overrides; sizing goes through the renderer's `window.resizeTo`
because chromedriver ≥ 152 removed the CDP endpoint behind the WebDriver
window commands), and seeds the real-book fixtures in
`tests/fixtures/books/EBooks/Agents/` (missing fixtures are skipped with a
notice). Both scenarios start mid-book. Measured, per reader:

- frame-time p50/p95/max while a synthetic scrollbar drag runs (continuous
  scroll deltas per ~16 ms tick) and while idle — plus the dropped-frame
  share over 16.7/32/50 ms, so a regression shows up as "95% → 82% of
  frames under 16.7 ms", not as "rendering completed";
- PDF page-walk render→blit latency (`data-pdf-render-ms`, p50/p95);
- interaction latency (automation-visible click → observable effect):
  rapid page turns, zoom in/out steps, large-document scroll jumps, and
  EPUB chapter changes through the contents drawer;
- first-render latency (launch → first rendered page);
- live canvas memory where measurable (PERF-4 bound), bitmap-cache
  occupancy after the oscillation (PERF-3), buffer caps (PERF-1).

Deterministic budget assertions still hold in this suite — they are
policy, not timing: PERF-1/3/4. Timing results land in
`artifacts/e2e/<runId>/bench-results.json`, and one summary line per run
is appended to `bench-trend.jsonl` for run-over-run drift comparison.
Timing thresholds are opt-in (`BENCH_ENFORCE_P95_MS`) — never CI policy.

### Headless on Linux (Xvfb)

On Linux the justfile wraps every phase in `xvfb-run --auto-servernum`,
which provisions a private virtual display for the whole invocation chain
(app + driver inherit it). Nothing needs `DISPLAY`, a window manager, or a
logged-in session. On Wayland desktops, unset `WAYLAND_DISPLAY` for the
invocation so the app cannot escape the virtual display:

```sh
env -u WAYLAND_DISPLAY xvfb-run --auto-servernum \
  env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded
```

### Isolation, cleanup, termination

Everything lives in `e2e/setup/` (`environment.ts` single bootstrap,
`fixtures.ts` paths, `watchdog.mjs` termination guard):

- Each invocation gets a unique scratch dir under `$TMPDIR`
  (`/tmp/tuxbooks-e2e-<runId>/`): its own SQLite database, library dir,
  and seeded fixtures. Nothing ever reads a real user library; production
  app-data paths are only used when `TEST_DATABASE_PATH`/`TEST_LIBRARY_PATH`
  are unset.
- `onPrepare` SIGKILLs stale processes left by crashed runs — the Electron
  app tree and its dist helpers (matched via the dist directory, so
  `chrome_crashpad_handler` is covered too), the sidecar, chromedriver, and
  orphaned wdio workers (matched via `@wdio/local-runner`'s run.js — never
  the launcher, whose onPrepare would kill itself). A leftover app would
  grab the new automation session. Driver ports are probed and picked free
  by the service, so stale listeners cannot collide.
- The app can outlive the driver; the detached watchdog (`watchdog.mjs`,
  armed in `onComplete`) reaps leftover processes once the run finishes
  and SIGKILLs a wedged launcher. Each phase is additionally bounded by
  `timeout --kill-after=15 600` in the justfile, so `just test-e2e` always
  terminates and always returns a meaningful exit code. Scratch dirs
  (`/tmp/tuxbooks-e2e-*`) older than 24h are pruned on the next run.
- Failed tests capture a screenshot AND a `failure-<runId>-<test>.json`
  metadata record (suite, test, error + stack, full stack-version record,
  connected chromedriver) into `artifacts/e2e/<runId>/` (gitignored,
  pruned after 7 days) next to the per-run driver logs. Every run writes
  `environment.json` (Electron, Chromium mapping, chromedriver,
  WebdriverIO, service versions, phase, app args) — a failed E2E test can
  be diagnosed from the artifacts alone. The service captures Electron
  main-process and renderer console output into the wdio logs
  (`captureMainProcessLogs` / `captureRendererLogs`); under
  `TUXBOOKS_DEBUG_IPC=1` the app additionally appends bridge/protocol/
  event traces to per-run files in `/tmp`.
- Do not run two E2E invocations concurrently on the same machine: the
  stale-process sweep intentionally kills matching app/driver processes.

Known environment note: `library-sync` and `reader-lifecycle` pass in
isolation and on developer hardware, but can time out as the last heavy
suites of a full seeded phase on constrained CI/sandbox machines (app
instances slower than the 30s view waits). The failure artifacts above are
the diagnostic path; do not loosen the waits to make a constrained machine
pass.

## Test data rules

- Fixtures are committed under `tests/fixtures/books/` and generated by
  `scripts/make-fixture.py` (original content only — no copyrighted books,
  ever). Deterministic: byte-identical across runs (no timestamps), so
  imported book ids stay stable. Current set: `minimal.epub`,
  `minimal.pdf` (3 pages), `large.pdf` (100 pages with a nested outline,
  virtualization + outline-navigation proof), `mixed.pdf` (six MediaBoxes,
  per-page geometry).
- Exception: `tests/fixtures/books/EBooks/` holds a real user-created
  library (real copyrighted files). It is gitignored and must never be
  committed. `src-tauri/tests/realistic_library.rs` runs against it and
  skips itself when the directory is absent; `REALISTIC_LIBRARY_PATH`
  overrides its location.
- `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH` / `REALISTIC_LIBRARY_PATH`
  are the only override hooks; production code resolves the OS app-data
  dir when the first two are unset.
- PDF cover tests need the PDFium shared library (`just fetch-pdfium`,
  automatic in the justfile flows — see `docs/build.md`). When it is
  absent (bare `cargo test` on a fresh clone), those tests print a notice
  and skip instead of failing.

## EPUB fixture corpus (three tiers)

The dedicated EPUB corpus lives in `tests/fixtures/epub/` (see its
[README](../tests/fixtures/epub/README.md)). Same rule as everywhere else:
**small synthetic fixtures in Git; large publications outside Git; the
default suite never downloads fixtures.**

| Tier                 | Contents                                       | Storage                             | How to run                                                   |
| -------------------- | ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| Core (always)        | 30 tiny EPUB 2 + EPUB 3 fixtures, ~57 KB total | committed (`core/`, `sources/`)     | `just test` (runs `epub_corpus.rs`)                          |
| Extended (opt-in)    | Real-world public-domain books                 | `.build/fixtures/epub/extended/`    | `just fetch-epub-extended` then `just test-epub-extended`    |
| Conformance (opt-in) | External W3C EPUB tests and similar corpora    | `.build/fixtures/epub/conformance/` | `just fetch-epub-extended` then `just test-epub-conformance` |

- Core corpus: generated by `scripts/make-epub-fixtures.py` (`just
make-epub-fixtures`), validated by `just check-epub-fixtures` — a `just
check` stream and a CI step. The check byte-compares a fresh generation
  (determinism), verifies manifest checksums/sizes, EPUB version identity
  (2.0 vs 3.0), malformed markers, and enforces the committed size budget
  (100 KB/fixture, 512 KB corpus) with the move-it-to-extended error
  message. `src-tauri/tests/epub_corpus.rs` additionally pins the
  parser-facing contract on every `cargo test`: valid fixtures parse,
  malformed fixtures are rejected.
- Extended/conformance: `[[dataset]]` entries in
  `tests/fixtures/epub/fixtures.toml` carry full provenance (source URL,
  exact version, license, sha256 of the exact archive, retrieval date).
  The fetcher (`scripts/fetch-epub-extended.py`) downloads **one versioned
  archive per dataset**, verifies the checksum before extraction, caches
  under `.build/fixtures/epub/` (gitignored), and skips the download when
  the cached version's checksum still matches. Entries without verified
  provenance are rejected — checksums are never invented. The first
  version ships zero configured datasets. `src-tauri/tests/
extended_epub.rs` skips with a notice when no dataset is present.
- If extended testing is ever added to CI, cache on
  `dataset id + version + archive_sha256` so the corpus is downloaded
  once, not per build. The default CI path must remain corpus-free.
- There is no Git LFS and no plan to add one: large material stays out of
  the checkout entirely.
