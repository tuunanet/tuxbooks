# Testing

Four layers, all runnable locally via `just`:

| Layer             | Command              | What it covers                                                               |
| ----------------- | -------------------- | ---------------------------------------------------------------------------- |
| Rust unit/prop    | `just test-rust`     | parsers, scanner, repos, search, db, watcher batching, progress migration    |
| Rust integration  | `just test-rust`     | fixture → scan → DB → search slice; filesystem sync; multi-device cloud sync |
| Frontend (Vitest) | `just test-frontend` | shell, library view, mocked IPC bridge                                       |
| E2E (Playwright)  | `just test-e2e`      | real Electron binary, real window, real SQLite                               |

## What CI runs

CI is `ci.yml`. It always runs, so its `CI gate` job is always reported and is
the single required check for `main` in branch protection.

A first job, `Detect changes`, classifies the diff into two flags. `code` is
false when every changed file is non-code (markdown anywhere, `docs/`, `site/`,
`.beads/`, `.agents/`, `.opencode/`, `graft/`, `oracle/`, `vendor/`,
or `.gitignore`); the heavy jobs (`Frontend`, `Coverage`, `Rust`, `Release
build`) then skip. `packaging` is true only when the diff touches a path that
can reach the deb payload (`electron/`, `sidecar/`, the builder config, the
packaging scripts). `CI gate` treats a skipped job as a pass, so a docs or
site change merges on the cheap jobs alone, in about fifteen seconds — a
workflow-level `paths-ignore` cannot express this (skipping the workflow
leaves the required check pending and blocks the merge).

The `Release build` job needs only `Detect changes`, so it starts in parallel
with the lint and test jobs. It always builds the renderer, the Electron
bundles, and the sidecar; the deb packaging and its gate run only when
`packaging` is true, and a non-packaging change compiles the sidecar on the
host instead of in the pinned-glibc container. The `Coverage` job owns the
frontend test run (the `Frontend` job runs lint, typecheck, and format), so
the vitest suite runs once per push. Electron and electron-builder downloads
and the sidecar container's BuildKit layers are cached across runs.

`codeql.yml` is advisory and keeps `paths-ignore` over the same non-code set.
`audit.yml` runs only when dependency manifests change, plus its weekly sweep.
The `Release` workflow runs the headless E2E (`just test-e2e`) on every `v*`
tag; the unit and integration suites were already proven by CI on the tagged
commit.

### Manual E2E on a PR

E2E is not a required PR check (it takes several minutes). `e2e-pr.yml` runs
it on demand: add the `run-e2e` label to a PR, or
`gh workflow run e2e-pr.yml -f pr=<number>`. The workflow resolves the PR
head, runs `just test-e2e`, and uploads failure artifacts. The run appears as
the optional `E2E (manual)` check; it never blocks merge.

## Timeouts and termination

Every test invocation is guaranteed to terminate; a wedged run is killed,
never left blocking development. Healthy runtimes are a small fraction of
each bound.

| What                       | Guard                                              |
| -------------------------- | -------------------------------------------------- |
| Unit tests (rust/frontend) | `timeout 900` wrapper in the justfile (linux only) |
| E2E phase                  | `timeout 300` wrapper in the justfile              |
| Single E2E test            | `timeout` 120s (`playwright.config.ts`)            |
| E2E teardown               | watchdog (`e2e/setup/watchdog.mjs`), see below     |
| CI jobs                    | `timeout-minutes` per job in `.github/workflows`   |

The E2E watchdog and the stale-process sweep guarantee every run
terminates; their mechanics are described under "Isolation, cleanup,
termination" below.

## Parallelism

- `just check` runs independent toolchains concurrently via `scripts/run-parallel.sh` (rust fmt+clippy+tests, vitest via `vp test`, oxlint, tsc, oxfmt); wall time is the slowest stream (usually rust). `just test` runs the cargo and vitest layers concurrently the same way. Cargo work stays in a single stream: parallel cargo commands only block each other on the target-dir file lock.
- Within layers, parallelism is already the default: cargo runs test threads, vitest runs worker processes.
- E2E phases stay sequential on purpose. Specs share one app session per phase (`workers: 1`, one worker-scoped `electronApp` fixture), and every session in a run inherits the phase's scratch env (`TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH` are set launcher-side before the app spawns). The stale-process sweep and watchdog kill by binary path, so two concurrent E2E invocations would kill each other — never run them in parallel.

## Rust (`cargo test`)

- Tests live next to the code (`#[cfg(test)] mod tests`) plus the integration tests (`sidecar/tests/`). The worker integration tests (`worker_handoff`, `worker_ops`, `worker_embed`, `worker_sandbox`, `worker_routing`, `worker_containment`) spawn the real `tuxbooks-worker` binary; the kernel-gated sandbox tests skip with a printed notice on kernels without Landlock (5.13+), mirroring the PDFium skip convention — production fails closed there instead.
- Property tests (`proptest`): `parse_epub` never panics on arbitrary bytes; the scanner only ever reports `*.epub` files. Keep those invariants intact.
- Progress-migration tests (required): representative foliate records — beginning of book, mid-chapter, chapter boundary, last-read, varied spine structures, large chapters, reflowable + fixed-layout, malformed/stale locators, missing EPUB files, older-version records — each asserted to land the Readium reader at the same **logical** location (small pagination drift allowed). See [EPUB.md](EPUB.md).
- `sidecar/tests/library_sync.rs` drives the real `notify` watcher against a real database in tempdirs. These tests need the tokio runtime to be multi-threaded (`#[tokio::test(flavor = "multi_thread")]`): watcher threads drive sqlx work via `Handle::block_on`, which deadlocks on the current-thread runtime.
- Filesystem and database tests use `tempfile::tempdir()` — they never touch the user's library or home directory. Tests run in parallel and each gets its own temp dir/database, so there is no shared state.

## Frontend (Vitest + RTL)

`pnpm --filter frontend test:ci` (watch mode: drop `:ci`).

- Environment: `jsdom`, matchers from `@testing-library/jest-dom/vitest`,
  automatic `cleanup()` via `tests/setup.ts`.
- The IPC bridge is mocked at the boundary: each test file hoists `vi.mock` over the preload-bridge module and routes responses with `tests/mocks/`. Tests never require a running Electron app. The mock must be declared in each test file — vitest hoists `vi.mock` above imports, so declaring it only in a helper module does not work (app code would import the real module).
- `tests/factories.ts::makeBook` builds canonical `Book` fixtures.
- Reader tests use additional fakes (all in `tests/mocks/`):
  - `readiumEngine.ts` / `pdfEngine.ts` — fake engines (per-page sizes, held renders, fail-once renders, cancellation tracking, locator round-trips); every file still hoists its own `vi.mock` over the seam.
  - `intersectionObserver.ts` — deterministic IntersectionObserver fake; tests fire entries per element/observer instead of relying on layout.
  - `dom.ts` — scroll-container geometry stubs (fixed viewport, document rect moving with `scrollTop`) for the scroll-tracking tests.
- jsdom gaps papered over in `tests/setup.ts`: pointer capture, `scrollIntoView`, `ResizeObserver` (no-op), `IntersectionObserver` (the fake), and `canvas.getContext` (returns a stub context).

## Rules for agents

- Tests must never read or write the user's real ebook library or real app database: `tempfile::tempdir()` in Rust, the `TEST_*` env overrides in app/E2E. Parallel tests get isolated dirs/DBs; no global mutable test state.
- Add or update tests when changing behavior — meaningful behavior only, no coverage-filler tests. Keep the `proptest` invariants (parser crash-safety, scanner extension filtering) intact.
- A test earns its place by failing when user-visible behavior changes and passing through a behavior-preserving refactor. Delete on sight: assertions that recompute the expectation the way the code does (tautologies), assertions on mock call sequences/counts or internal event names that no behavior depends on, and pins of constants or fixture counts that other tests already exercise. When a test guards real behavior but asserts it clumsily, slim it: keep the behavior assertion, drop the internals.
- New sync journey tests go in their own file under `sidecar/tests/` instead of appending to a shared suite file: parallel branches editing one hot test file collide (the five-ticket sync test batch paid that conflict twice, which is why `reset_forget/` and `cloud_sync/` are split targets).
- The coverage gate (`docs/COVERAGE.md`) is part of the contract: frontend floors bind every `just check`/`just test` run (the frontend test recipe runs with `--coverage`) and CI's coverage job; Rust floors run via `just coverage`.
- Never download copyrighted books; fixture content is original (generated by `scripts/make-fixture.py` / `make-epub-fixtures.py`, size budget enforced by `just check-epub-fixtures`).

## E2E (Playwright against Electron)

`just test-e2e` runs the **real desktop app** headlessly — no display, no
desktop session, safe from SSH/CI/agent environments. `just
test-e2e-headed` runs the same suites on your visible display for
debugging.

Stack: `@playwright/test` with Playwright's Electron API. The app fixture
(`e2e/fixtures/electron-app.ts`) launches the unpackaged app — the
electron binary from `e2e/node_modules` pointed at the built
`electron/dist/main.cjs` — through `_electron.launch()` and hands tests
the `electronApp` handle and the app's first window as `page`. There is no
external browser driver: Playwright attaches to the app over its own
bridge, so there is no driver download, cache, or version-matching to
maintain. Tests never launch Electron themselves.

Version determinism is recorded at startup (`e2e/setup/versions.ts`): every
run writes the Electron, Playwright, `@playwright/test`, Node, and OS
versions into the run banner and
`artifacts/e2e/<runId>/environment.json`, completed with the Chromium
build the running app reports. Do not remove that record — a failed E2E
test must be reproducible from the artifacts alone.

The launch fixture runs an **isolation gate**: it refuses to launch
anything unless `TEST_DATABASE_PATH` points at this run's scratch dir
(`tuxbooks-e2e-`), and it fails before the first test executes unless the
sidecar actually wrote the schema into the scratch database. A broken
environment setup must never silently degrade into testing the real user
library: if the gate fires, fix the environment; never bypass the gate.

Two Chromium-only traps are pinned in the harness: the app launches with
`--ozone-platform=x11` (a Wayland desktop is reachable through the
compositor socket even with `WAYLAND_DISPLAY` unset — without the pin, E2E
windows land on the real desktop), and the teardown watchdog
(`e2e/setup/watchdog.mjs`) is armed in `globalSetup`, so an aborted run
still sweeps the app tree, sidecar, and the phase's private Xvfb the
moment the runner dies. Sweep patterns are precise binary paths — a coarse
pattern raced and killed the next phase's recipes once.

The worker-scoped app fixture serves a whole worker's spec files against
the shared scratch library; reading-position/view state accumulates across
specs, so helpers re-navigate to a known state before asserting
(order-independent tests). The previous instance's sidecar is reaped via
`PR_SET_PDEATHSIG` (armed in the service binary) — without it, orphaned
sidecars kept watching the library and raced the live one for imports.

The app inherits the runner's environment, so `TEST_DATABASE_PATH` /
`TEST_LIBRARY_PATH` must be set before the first Electron launch
(globalSetup; the fixture re-asserts them) — keep that ordering.

Every invocation gets a fresh scratch env. The default `just test-e2e`
phases:

| Phase                                                  | Specs                                                  | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Own phase because                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| empty (`test:empty`)                                   | —                                                      | app shell, sidebar, window title, the empty-library state, Settings navigation                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                           |
| shell (`test:shell`)                                   | `desktop-shell.e2e.ts`                                 | native window title + sidebar branding, deterministic startup geometry (centered, unmaximized, 1280×820), min-size clamping, resize after a maximize/restore cycle, icon resolution, repeated-launch policy (relaunch after a maximized session opens the default window)                                                                                                                                                                                                         | the relaunch scenario closes and relaunches the app; true maximize/restore is an EWMH round-trip a bare Xvfb cannot serve (maximize is a no-op there — probed), so those scenarios run under `just test-e2e-headed-shell` on a real desktop |
| gpu (`test:gpu`)                                       | `gpu-fallback.e2e.ts`                                  | GPU-crash fallback policy: an active fallback marker boots the app software-rendered, PDF reading still works in that degraded mode, a software session never clears an active marker, a clean hardware-accelerated session removes an expired one; the crash-count → arming step is pinned by unit tests (real GPU crashes are not deterministically reproducible headlessly)                                                                                                    | the scenarios relaunch the app with different marker states                                                                                                                                                                                 |
| security (`test:security`)                             | `epub-content-security.e2e.ts`, `app-hardening.e2e.ts` | hostile EPUBs generated at runtime: a scripted book opens with its scripts inert, a book carrying active content opens with sanitized CSP-fenced frames and no completed external request (#82); X-1..X-5 window hardening on the production load path — no Node.js in the renderer, the app CSP enforcing, permissions denied by default with fullscreen granted to the reader, unsafe `window.open` spawning nothing, top-frame navigation unable to leave the app origin (#85) | the hostile books must never appear in the seeded suites' book counts                                                                                                                                                                       |
| seeded (`test:seeded`, `E2E_SEED_LIBRARY=1`)           | nine specs, below                                      | imports the committed fixtures (`minimal.epub`, `minimal.pdf`, `large.pdf` — 100 pages with a nested 15-entry outline, `mixed.pdf` — six page sizes) on startup and exercises the readers on them                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                           |
| collections (`test:collections`, `E2E_SEED_LIBRARY=1`) | `collections-journey.e2e.ts`                           | create, pin and unpin, drag reorder inside Pinned and across the Pinned/Unpinned boundary, Ctrl/Shift multi-select and the union title, Added-to-collection sorting, rename, confirmed delete, command-palette collection selection; a relaunch proves the per-device pin state and custom order persist                                                                                                                                                                          | the restart closes and relaunches the worker's app                                                                                                                                                                                          |

Seeded specs and what they pin:

- `books.e2e.ts` — library navigation: cards, stats, EPUB detail, PDF reader shell.
- `engine-smoke.e2e.ts` — each renderer initializes end to end (engine ready → metadata/geometry → visible content → location/progression); PDF adds worker-asset reachability, page navigation, zoom. Fails fast when an engine or asset breaks.
- `pdf-reader.e2e.ts` — fit-width canvas geometry, scroll-driven page tracking, bounded canvas count while scrolling a 100-page document with eviction, deep-zoom position preservation, mixed page sizes, outline navigation, the bounded virtualized thumbnails sidebar with current-page synchronization, reopen-restore persistence, bitmap-cache budget after the scroll-oscillation stress.
- `epub-reader.e2e.ts` — chapter navigation, arrow-key page turns, MathML, appearance preferences, reopen-restore, in-book search, exact-locator persistence (the engine's CFI captured before close must come back identical on reopen).
- `progress-migration.e2e.ts` — seeds the scratch database with reading-progress rows in the previous app's format (foliate CFI + chapter href + percent, PDF page rows) and asserts the same LOGICAL location restores: beginning, chapter boundary, late book, a stale row degrading to a defined state, the PDF page. Mid-chapter offsets and multi-structure corpora stay in the Rust tier.
- `reader-lifecycle.e2e.ts` — document-type switching, rapid repeated open/close, close-while-rendering recovery, rapid navigation convergence, window-resize re-anchoring, memory-bound assertions.
- `annotations.e2e.ts` — a PDF highlight from a real text-layer selection, its attached note, and a bookmark on both formats, each revisited after close/reopen; an EPUB highlight that must paint again after reopen and after a drawer jump.
- `metadata.e2e.ts` — edit → save writes the storeable fields into the file behind a one-time `.bak`; grid/detail/search update; reset disables itself once nothing is overridden.
- `collections.e2e.ts` — create from the sidebar, add and remove through the card context menu, mark finished, delete the collection.

Additional invocations exist beyond the default set:

- **hidpi** (`just test-e2e-hidpi`) — the seeded reader scenarios against
  an app forced to `devicePixelRatio` 2 (`E2E_DEVICE_SCALE_FACTOR` →
  `--force-device-scale-factor`): the doubled backing stores, the PERF-1
  caps at the high-DPI reference condition, and a rapid page-turn sweep
  staying inside the render budget. Xvfb cannot emulate refresh rates
  above 60 Hz — the dpr dimension is what this configuration guards.
- **release flavor** (`just test-e2e-release`) — empty + seeded against the
  RELEASE sidecar binary via `TUXBOOKS_SIDECAR` (the packaged-app resource
  resolution path; packaging is documented in [RELEASE.md](RELEASE.md)). A
  build that works from the source tree but loses its sidecar/resources in
  production form fails here.

Scroll interactions drive the reader's scroll container (`reader-content`)
with offsets derived from live slot geometry — never hard-coded pixels.

### Library Grid benchmark (headed, opt-in)

`just bench-library` measures All Books in Grid view against 10,000 generated
books (explicit target only, never `just test-e2e` or CI). E2E setup writes
the corpus to the gitignored `.build/fixtures/library-bench/` directory (same
deterministic generator as the 1,500-book structural suite, the committed
library-bench cover in every EPUB). The spec imports it through the real
`import_paths` bulk path, samples idle frame cadence, drives a full-library
programmatic scroll, and records frame p50/p95/max, dropped-frame shares,
scroll distance, wall time, and the peak mounted-card count in
`bench-results.json`.

Import timing is the sharp edge: `import_paths` is one RPC behind a flat 60 s
guard with no progress reset (`electron/main/sidecar.ts`), and one folder call
over 10,000 covered books measures 130 s on the release sidecar (the debug
sidecar the recipe uses is slower), so a single bulk call cannot clear the
guard. Import big corpora one partitioned subdirectory per call — the pattern
in `generateLibraryThumbCorpus` (e2e/setup/environment.ts); per-file calls are
quadratic because each file's parent takes the folder treatment. The bench
spec's own single-call import exceeds the guard as written (tuxbooks-grk).
Timings carry no machine-independent assertion; set `BENCH_ENFORCE_P95_MS` to
enforce one locally (`BENCH_ENFORCE_P95_MS=32 just bench-library`).

### Scrollbar thumb-drag regression (opt-in)

`just test-e2e-library-thumb` is the regression loop for the 10,000-book
scrollbar thumb fix (tuxbooks-y9s): a trusted grab of the Grid's real native
scrollbar thumb, dragged the length of the track downward from the top and
upward from the bottom (on a freshly remounted view), asserting the thumb
stays under the held cursor — the unfixed build diverged hundreds of track px
and died mid-way. A static-overlay control drag in the same window guards the
harness: if the grid fails while the control tracks, the divergence is
app-caused. Runs under Xvfb on the explicit target only; generates a
cover-less corpus variant in `.build/fixtures/library-thumb/` (same card
geometry, cheap enough to import inside the 60 s RPC guard) and uses the
release sidecar because the renderer is what's under test.

### Benchmark suite (headed, opt-in)

`just bench-reader [WxH]` runs `bench-reader.e2e.ts` — the suite that
MEASURES instead of asserting structure. Excluded from
`test:empty`/`test:seeded` and from CI by policy (headless timings are
unreliable; `docs/PERFORMANCE.md` — E2E asserts deterministic attributes
only); runs headed on the real display, window maximized (explicit `WxH`
overrides; sizing goes through the renderer's `window.resizeTo` because the
real OS window is what the reader lays out against); seeds the free-corpus
fixtures (`just fetch-ebooks`) from `tests/fixtures/books/EBooks/` (missing
fixtures skip with a notice). The PDF walk and scroll scenarios start
mid-book. Measured, per reader:

- frame-time p50/p95/max under a synthetic scrollbar drag (~16 ms ticks) and while idle, plus the dropped-frame share over 16.7/32/50 ms — a regression shows up as "95% → 82% of frames under 16.7 ms", not as "rendering completed";
- PDF page-walk render→blit latency (`data-pdf-render-ms`, p50/p95);
- rapid scroll on GeoTopo (real wheel input, 25 ms `data-render-state` samples): the render-state distribution during motion, the longest white streak, and stop-to-sharp (last scroll-position change → every visible slot rendered); the distribution samples the slot under the viewport's top edge — the page the reader is looking at, matching the recorded baseline capture;
- native far-thumb drag (`far-drag-capture.e2e.ts`): a trusted scrollbar grab to 90% of the document, then the same motion measures plus final visible-slot states and render-window diagnostics. GeoTopo is the default; `FAR_DRAG_BOOK_TITLE="Thumb Capture Mixed (PDF)"` runs the committed mixed-size fixture (the bench seeds it when that variable is present);
- interaction latency (automation-visible click → observable effect): rapid page turns, zoom steps, large-document scroll jumps, EPUB chapter changes through the contents drawer;
- first-render latency (launch → first rendered page);
- live canvas memory (PERF-4), bitmap-cache occupancy after the oscillation (PERF-3), buffer caps (PERF-1).

Deterministic budget assertions still hold in this suite — policy, not
timing: PERF-1/3/4. Results land in
`artifacts/e2e/<runId>/bench-results.json`, written per scenario as each
finishes so a late failure or worker restart cannot wipe earlier results,
plus one summary line per run in `bench-trend.jsonl` for drift comparison.
Timing thresholds are opt-in (`BENCH_ENFORCE_P95_MS`) — never CI policy.

### Thumb-drag capture (opt-in, issue tuxbooks-x27.4)

`just test-e2e-capture` runs `thumb-drag-capture.e2e.ts` against a one-book
scratch library: the committed mixed-size fixture
(`tests/fixtures/books/thumb-capture-mixed.pdf`, byte-deterministic, from
`scripts/make-thumb-capture-fixture.py`). It drives a real native scrollbar
thumb drag through trusted input over 600 cursor px and records
scroll-height events, thumb-versus-cursor error against the grab-time
geometry, and re-anchor firings (programmatic `scrollTop` writes; native
drags never write the property). An evidence instrument for the thumb fix,
not an assertion suite: only harness sanity is asserted; the verdict lives
in the report (`artifacts/e2e/<runId>/thumb-drag-capture.json`) and the
procedure plus findings in `docs/research/pdf-viewer-perf-findings.md`
(Symptom 2). Never CI.

### Headless on Linux (Xvfb)

On Linux the justfile wraps every phase in `xvfb-run --auto-servernum`,
which provisions a private virtual display for the whole invocation chain
(the launched app inherits it). Nothing needs `DISPLAY`, a window manager,
or a logged-in session. On Wayland desktops, unset `WAYLAND_DISPLAY` for
the invocation so the app cannot escape the virtual display:

```sh
env -u WAYLAND_DISPLAY xvfb-run --auto-servernum \
  env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded
```

### Isolation, cleanup, termination

Everything lives in `e2e/setup/` (`environment.ts` single bootstrap,
`fixtures.ts` paths, `watchdog.mjs` termination guard) plus the launch
fixture `e2e/fixtures/electron-app.ts`:

- Each invocation gets a unique scratch dir under `$TMPDIR` (`/tmp/tuxbooks-e2e-<runId>/`): its own SQLite database, library dir, and seeded fixtures. Nothing ever reads a real user library; production app-data paths are only used when `TEST_DATABASE_PATH`/`TEST_LIBRARY_PATH` are unset. Scratch dirs older than 24h are pruned on the next run (left behind only by a machine crash or a kill before the watchdog arms).
- `globalSetup` SIGKILLs stale processes left by crashed runs — the Electron app tree and its dist helpers (matched via the dist directory, so `chrome_crashpad_handler` is covered too) and the sidecar; a leftover app would hold the single-instance lock and a leftover sidecar would race the live one. Playwright's own teardown closes the launched app; the detached watchdog (armed in `globalSetup`) covers the rest — an aborted runner never reaches `globalTeardown`, and the sweep fires the moment it dies. The watchdog only kills processes that predate it, so the next phase's processes are never caught by the previous phase's teardown. Each phase is additionally bounded by `timeout --kill-after=15 600` in the justfile, so `just test-e2e` always terminates with a meaningful exit code.
- Failed tests capture a screenshot AND a `failure-<runId>-<test>.json` metadata record (suite, test, error + stack, full stack-version record) into `artifacts/e2e/<runId>/` (gitignored, pruned after 7 days), next to the retained Playwright trace. Every run writes `environment.json` (versions, phase) and per-run `electron-main.log` / `electron-renderer.log` files — a failed E2E test can be diagnosed from the artifacts alone. Under `TUXBOOKS_DEBUG_IPC=1` the app additionally appends bridge/protocol/event traces to per-run files in `/tmp`.
- Do not run two E2E invocations concurrently on the same machine: the stale-process sweep intentionally kills matching app/sidecar processes.

Known environment note: `library-sync` and `reader-lifecycle` pass in
isolation and on developer hardware, but can time out as the last heavy
suites of a full seeded phase on constrained CI/sandbox machines (app
instances slower than the 30s view waits). The failure artifacts above are
the diagnostic path; do not loosen the waits to make a constrained machine
pass.

## Test data rules

- Fixtures are committed under `tests/fixtures/books/` and generated by `scripts/make-fixture.py` (original content only — no copyrighted books, ever). Deterministic: byte-identical across runs (no timestamps), so imported book ids stay stable. Current set: `minimal.epub`, `minimal.pdf` (3 pages), `large.pdf` (100 pages with a nested outline, virtualization + outline-navigation proof), `mixed.pdf` (six MediaBoxes, per-page geometry), and `thumb-capture-mixed.pdf` (392 mixed-height pages for the thumb-drag capture, `scripts/make-thumb-capture-fixture.py`; see its section above).
- Free ebook corpus: `tests/fixtures/books/EBooks/` holds freely licensed sample books (IDPF EPUB 3 samples, py-pdf sample-files — CC-BY-SA, ~11 MB). Download with `just fetch-ebooks` (network, explicit — never part of `just check`/`just test`); the committed `manifest.json` pins every file's URL + sha256 + size and `just check-ebooks` verifies the corpus offline. Only `manifest.json` is committed; tests that use the corpus (`sidecar/tests/realistic_library.rs`, `sidecar/tests/scripted_content.rs`, bench-reader seeding) skip with a notice when it is absent; `REALISTIC_LIBRARY_PATH` overrides its location.
- `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH` / `REALISTIC_LIBRARY_PATH` are the only override hooks; production code resolves the OS app-data dir when the first two are unset.
- PDF cover tests need the PDFium shared library (`just fetch-pdfium`, automatic in the justfile flows — see `docs/BUILD.md`). When it is absent (bare `cargo test` on a fresh clone), those tests print a notice and skip instead of failing.

## Security corpus (issue #87)

A dedicated negative-input corpus and boundary-test layer, separate from the
functional suites. Everything is generated at runtime; no hostile file is
committed. When a fuzzing run or review finds a minimized crashing input,
it comes back here as a builder, not a blob.

| Side     | Location                                   | Contents                                                                              |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Rust     | `sidecar/tests/fixtures/security/`         | Hostile EPUB/PDF fixture builders (README inside documents the layout)                |
| Rust     | `sidecar/tests/security_corpus.rs`         | Corpus index target: one test per invariant, hostile shapes through the real worker   |
| Frontend | `frontend/tests/security/corpus/`          | Per-invariant index (`index.ts`), hostile EPUB builders (`hostileEpub.ts`), pins test |
| Frontend | `frontend/tests/security/attackVectors.ts` | The shared vector arrays (traversal, scheme confusion, scripted fragments, ...)       |

Every assertion is fail-closed behavior, not just "does not crash": a typed
error (`LimitExceeded`, `EpubError`, `PdfError`, `WorkerError`) or a bounded,
inert result. The corpus index maps every invariant (E-1..E-5, R-1..R-3,
T-1..T-7, the W-2/W-3/W-5/W-8/W-9 boundary subset, P-1) to its vectors and
the tests that enforce them, pointing at existing tests instead of
duplicating them. Worker boundary tests drive hostile documents through the
real `tuxbooks-worker` and pin that the typed error comes back and the
worker still serves the next benign job.

One known soft spot, kept honest rather than papered over: the PDF
decompression-bomb fixture trips typed for the eager-load class (lopdf
answers cross-reference and object-stream inflation past
`max_stream_decompressed_bytes` with the limits table's typed error, pinned
by `stream_inflation_over_the_decompression_cap_fails_typed`). Inflation
lopdf does not bound (content streams PDFium decodes at render time, for
example) stays containment-only, answered by the worker's RLIMIT_AS and
deadline; #88 fuzzing hunts those residual classes and lands minimized
inputs here as builders.

`just test` and `just check` run the corpus layers with everything else
(`security_corpus.rs` on the Rust stream, the corpus vitest file on the
frontend stream); no extra command is needed.

## Fuzzing (issue #88)

Four libFuzzer targets (cargo-fuzz) cover the highest-risk parser and
boundary surfaces from #81-#83, proving the P, R, and T invariants under
mutation. Nightly CI cadence, never per-PR.

| Target       | Surface                                    | Entry points (`sidecar/src`)                                                                         |
| ------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `epub-parse` | EPUB ZIP/member/path handling              | `epub/parser.rs` `parse_epub_reader`; `epub/session.rs` `read_member_reader`, `build_session_reader` |
| `opf-xml`    | OPF/XML manifest parsing                   | `epub/metadata.rs` `parse_opf`; `epub/parser.rs` `parse_container_xml`                               |
| `pdf-parse`  | PDF object parsing and metadata extraction | `pdf/parser.rs` `parse_pdf_bytes` (lopdf load + bounded page-tree walk)                              |
| `json-rpc`   | JSON-RPC parameter decoding (T-6)          | `rpc.rs` `handle_request_line` against a real scratch `AppState`                                     |

### Running locally

Prerequisites (nightly toolchain + cargo-fuzz):

```sh
rustup toolchain install nightly --profile minimal
cargo install cargo-fuzz --locked
```

Bounded runs (`just fuzz <target> <seconds>`, default 60):

```sh
just fuzz epub-parse 60      # one target, time-boxed
just fuzz-smoke              # 30s per target, the end-to-end proof run
just fuzz-ci                 # the nightly cadence: 300s per target
```

The first invocation compiles the instrumented build (minutes); later runs
are incremental. Every run is time-boxed with `-max_total_time`, capped with
`-rss_limit_mb=4096` and `-timeout=25` per exec, and writes only inside the
workspace: `sidecar/fuzz/corpus/<target>/` (runtime corpus) and
`sidecar/fuzz/artifacts/` (crash files), both gitignored.

### Seeds and harness shape

- Seeds are committed under `sidecar/fuzz/seeds/<target>/`: derived from the checked-in fixtures (`tests/fixtures/books/minimal.epub` / `minimal.pdf`), the parser tests' valid OPF/container XML, and one JSON-RPC request per seed file. `just fuzz` copies them into the runtime corpus at the start of each run.
- `epub-parse` dispatches on the first input byte: `0x00` + NUL-terminated member path + archive bytes drives the member lookup (E-5 path gate), `0x01` + archive bytes drives the reading-session build, anything else is the import parse. Real EPUB files seed the default mode directly.
- Fuzz runs use a tightened quota table (`fuzz/fuzz_targets/fuzz_limits.rs`): the production `ResourceLimits` with byte caps around 1 MiB, so hostile archives trip a quota in microseconds instead of inflating toward the 512 MiB production ceilings. Quota trips are typed errors, not hangs.
- `json-rpc` builds one process-lifetime scratch state (SQLite in the gitignored fuzz target dir, seeded book row, real schema) and drives `handle_request_line`, the exact boundary code `handle_line` runs. Filesystem-path parameters (`scan_library`, `import_paths`, `unwatch_locations`, `reconnect_book`, `set_book_cover`) and `create_collection` names are pinned into the scratch directory first — without the pins, collections and annotations would grow the scratch database without bound. Non-string shapes stay untouched, so -32602 parameter decoding stays reachable. Every produced response line is asserted to be valid JSON.

### Crash triage

A crash stops the target and writes
`sidecar/fuzz/artifacts/<target>/crash-*` (named by input hash). Reproduce
and minimize from `sidecar/` with the nightly toolchain active (or
`RUSTUP_TOOLCHAIN=nightly` exported):

```sh
cargo fuzz run <target> <crash-file>                        # reproduce
cargo fuzz run <target> -- -minimize_crash=1 <crash-file>   # minimize
```

A confirmed crash lands as a deterministic builder in
`sidecar/tests/fixtures/security/` (never a blob — see that directory's
README) with the fix referencing the fuzz case that found it.

A libFuzzer `-timeout` hit in these targets is a bug — the tightened quota
table bounds decompression and parsing work, so unbounded behavior cannot
hide behind a quota. The one known residual class stays outside these
targets by construction: content streams PDFium decodes at render time are
not bounded by lopdf and remain containment-only (worker RLIMIT_AS +
deadline, docs/RESOURCE_LIMITS.md); fuzzing that class is PDFium/OSS-Fuzz
work, not sidecar-harness work. Renderer (TypeScript) surfaces are out of
scope for #88.

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
  message. `sidecar/tests/epub_corpus.rs` additionally pins the
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
  version ships zero configured datasets. `sidecar/tests/
  extended_epub.rs` skips with a notice when no dataset is present.
- If extended testing is ever added to CI, cache on
  `dataset id + version + archive_sha256` so the corpus is downloaded
  once, not per build. The default CI path must remain corpus-free.
- There is no Git LFS and no plan to add one: large material stays out of
  the checkout entirely.
