# AGENTS.md

Instructions for coding agents working in this repository. Verified commands
only — run them, don't assume.

## Branch state: stack migration

Branch `web-reader-prototype-1` migrates the app from Tauri + WebKitGTK +
foliate-js/PDF.js to **Electron + Readium (EPUB) + MuPDF.js/WASM (PDF)**,
keeping the Rust core as a first-class native service. Until a phase
completes, some code still reflects the old stack — see
`docs/electron-migration.md` for the phase plan and what is current. Do not
add new foliate-js, PDF.js, or Tauri-coupled code while migrating.

## Keep this file compact

AGENTS.md loads into every session, so it must stay short. Before adding
anything here, first check whether an existing doc in `docs/` (see Working
documents) is the right home for that information. If no suitable `.md` file
exists, create one in `docs/` and refer to it from here in the appropriate
section — do not inline the content.

## What this project is

Local-first desktop ebook library (bookshelf style). **Rust is the
application/domain language; React/TypeScript is only the presentation
layer; Chromium (via Electron) is the sole desktop web runtime.**

- Business logic goes in Rust (`domain/`, `services/`), never in React
  components.
- UI logic stays in TypeScript, never in Rust.
- Electron processes:
  - `electron/main/` — main process: window lifecycle, dialogs/shell, the
    custom `tuxbooks://` resource protocol, spawning and proxying the Rust
    sidecar. No business logic beyond this plumbing.
  - `electron/preload/` — exposes a minimal, explicitly enumerated
    `window.tuxbooks` API. `contextIsolation: true`, `nodeIntegration: false`,
    sandbox on. The renderer never sees Node.js.
- The Rust service (`src-tauri/` → native service binary) owns the database,
  filesystem, scanner, importers, and metadata parsing. It talks JSON-RPC
  over stdio with the Electron main process.
- Database access only through `repository/`. SQL never appears in commands,
  services, the main process, or the frontend.
- `epub/` and `domain/` stay independent of any runtime (Electron, Tauri).
- Reader engines are isolated behind single-module seams:
  - EPUB: Readium TS Toolkit — only `frontend/src/lib/epub/readiumEngine.ts`
    (successor of `epubEngine.ts`) imports Readium packages.
  - PDF: MuPDF.js/WASM — only `frontend/src/lib/pdf/pdfEngine.ts` imports
    MuPDF.
  - React components interact with readers only through the format-agnostic
    `Reader` abstraction (`readerModel.ts`); Readium/MuPDF objects never leak
    into unrelated components.
- Do not silently change these architectural conventions.

## Commands (in this order)

During the migration phases, run the current set from the justfile — check
`just --list` and `docs/build.md` for what is wired up in this phase. The
target command surface (verify before relying on it):

```sh
pnpm install          # first thing after cloning
just check            # format+lint+typecheck+unit tests, parallel streams
just dev              # launch the app (Electron + Vite hot reload)
just test-e2e         # real-app desktop E2E, headless on Linux (builds first)
just ci               # everything CI runs
```

Single layers (target):

```sh
just test                            # unit tests, rust + frontend concurrently
just test-rust                       # cargo test (service crate)
just test-frontend                   # vitest run (CI mode)
pnpm --filter frontend exec vitest run <file-or-pattern>
```

Run `just check` (or at minimum the relevant test layer) before declaring any
task complete, and run `just format` if you touched formatting-sensitive code.

### E2E contract for agents

**Migration state:** the E2E suite is being re-anchored from
tauri-driver/WebKitGTK to the Electron binary
(`docs/electron-migration.md`); `just test-e2e` currently fails fast with a
message instead of running. Once it lands, the contract below applies:

`just test-e2e` is **safe to run from an automated environment** (SSH, CI,
containers, no desktop session). It provisions its own virtual display via
`xvfb-run`, builds the app, runs both suites against the real Electron
binary, always terminates (watchdog + `timeout` guard), returns a non-zero
exit code on failure, and leaves failure artifacts (screenshots, wdio/driver
logs) in `artifacts/e2e/<runId>/`. Do not launch a second E2E run while one
is still going.

## Non-obvious gotchas

Each of these has bitten before (or is a known trap of the new stack). The
details live with the layer they bite — read the relevant doc before touching
that layer:

- Electron security defaults are non-negotiable: `contextIsolation: true`,
  `nodeIntegration: false`, sandboxed preload, a restrictive IPC surface.
  No arbitrary `ipcRenderer` passthrough — `docs/electron-migration.md`.
- The Rust sidecar is spawned, health-checked, and restarted by the Electron
  main process; its lifecycle must survive a renderer reload and must be
  shut down on app quit (no orphaned processes) —
  `docs/electron-migration.md`.
- Resource loading: book bytes/covers flow through the scoped `tuxbooks://`
  custom protocol (range requests supported), never an arbitrary local HTTP
  server — `docs/architecture.md`.
- Database: runtime-query SQLx only (no `query!` macros), embedded numbered
  migrations, FTS5 triggers must move with `books` columns —
  `docs/database.md`.
- Reading progress is user data: engine locators migrate (foliate → Readium)
  through the versioned, idempotent migration adapter; never reset or
  destructively rewrite progress rows — `docs/epub.md`, `docs/database.md`.
- Frontend: no synchronous `setState` inside effects — `docs/STANDARDS.md`.
- Testing: `vi.mock` declared per test file; the IPC bridge is mocked at
  `tests/mocks/` (same hoisting rules as before) — `docs/testing.md`.
- Readers: single-module engine seams, position/persistence invariants,
  pinned DOM attributes — `docs/epub.md`, `docs/pdf.md`.
- Performance: reader rendering is budgeted in pixels and bytes, not
  element counts — canvas caps, cache occupancy, compositing hygiene,
  scroll-commit discipline. Budgets are gates, not suggestions —
  `docs/performance.md`.

## Testing rules

- Tests must never read or write the user's real ebook library or real app
  database. Use `tempfile::tempdir()` (Rust) and the `TEST_*` env overrides
  (app/E2E). No global mutable test state; parallel tests get isolated
  dirs/DBs.
- Coverage gate: every category must stay at or above its required
  percentage (default 80%) — frontend floors fail any vitest run, Rust
  floors via `just coverage` — `docs/coverage.md`.
- Test fixture books live in `tests/fixtures/books/` and are regenerated by
  `python3 scripts/make-fixture.py`; the EPUB 2+3 corpus lives in
  `tests/fixtures/epub/` (`just make-epub-fixtures`, size budget enforced —
  see `docs/testing.md`). Never download copyrighted books; fixture content
  is original.
- Progress-migration fixtures (representative foliate progress records:
  mid-chapter, chapter boundaries, malformed/stale locators, missing books)
  are part of the required test data — `docs/epub.md`.
- Add or update tests when changing behavior. Meaningful behavior only — no
  coverage-filler tests. Property tests (`proptest`) exist for parser
  crash-safety and scanner extension filtering; keep those invariants
  intact.
- Frontend tests mock the IPC bridge (see `frontend/tests/mocks/`) and must
  run without the Electron app: `pnpm --filter frontend test:ci`.
- E2E runs two isolated invocations: empty library (`test:empty`) and seeded
  fixture library (`E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded`). Both
  get a unique temp database/library per run; never point them at a real
  library.

## Dependencies

- No new dependency (Rust crate or npm package) without a clear, stated
  reason.
- Reader engines are deliberate choices: Readium TS Toolkit (EPUB) and
  MuPDF.js (PDF). Do not add competing engines or renderers alongside them.
- UI primitives come from shadcn/ui (`pnpm dlx shadcn add <component>`;
  config in `frontend/components.json`, radix-nova style); icons from
  `lucide-react`. Do not hand-roll SVG icons or primitive replacements.
- No network services, Docker, PostgreSQL, Redis, or backend server — this
  is a local-first desktop app. SQLite only.
- Do not suppress lints globally. A targeted `eslint-disable` needs a reason
  comment (the shadcn `*Variants` exports in `components/ui/` are the known
  cases).
- TypeScript is strict; `any` is banned via lint rule.

## Conventions

- Rust: modules per the table in `docs/architecture.md`; errors via
  `thiserror` enums; wire DTOs serialize `camelCase` (JSON-RPC payloads and
  preload bridge alike).
- Frontend: components grouped by feature under `src/components/`; the only
  files allowed to talk to the outside world are `src/lib/bridge.ts` (IPC via
  the preload API) and the two engine seams (`lib/epub/readiumEngine.ts`,
  `lib/pdf/pdfEngine.ts`); use the `@/` path alias for cross-directory
  imports.
- Docs in `docs/` describe the architecture contract — update them when you
  change module boundaries, schema, or the reader layers.

## Working documents

Read the one that fits the task; each is short.

- `docs/STANDARDS.md` describes coding standards.
- `docs/architecture.md` — module boundaries, process model, frontend
  structure.
- `docs/electron-migration.md` — the migration plan, phase status, and
  sidecar/IPC design.
- `docs/build.md` — build flavors, dev environment.
- `docs/database.md` — schema, migrations, FTS5.
- `docs/epub.md` / `docs/pdf.md` — reader layer contracts (Readium /
  MuPDF.js).
- `docs/performance.md` — reader performance budgets/metrics and how each
  is verified; check it before touching reader rendering.
- `docs/testing.md` — test layers and E2E infrastructure.
- `docs/coverage.md` — per-category coverage floors and what is excluded.
- `docs/release.md` — packaging and cutting releases.
