# AGENTS.md

Instructions for coding agents working in this repository. Verified commands
only — run them, don't assume.

## Keep this file compact

AGENTS.md loads into every session. High-signal detail lives in the `docs/`
files it refers to; before adding anything here, check whether an existing
doc in `docs/` is the right home for it. If no suitable `.md` exists, create
one in `docs/` and refer to it from the appropriate section — do not inline.

## Branch state: stack migration

Branch `web-reader-prototype-1` migrates the app from Tauri + WebKitGTK +
foliate-js/PDF.js to **Electron + Readium (EPUB) + MuPDF.js/WASM (PDF)**,
keeping the Rust core as a first-class native service. Until a phase
completes, some code still reflects the old stack — see
`docs/electron-migration.md` for the phase plan and what is current. Do not
add new foliate-js, PDF.js, or Tauri-coupled code while migrating.

## What this project is

Local-first desktop ebook library (bookshelf style). **Rust is the
application/domain language; React/TypeScript is only the presentation
layer; Chromium (via Electron) is the sole desktop web runtime.**

- Business logic in Rust (`domain/`, `services/`), UI logic in TypeScript,
  SQL only in `repository/`. Module boundaries and process model:
  `docs/architecture.md`.
- Electron `main`/`preload` are plumbing only; the renderer never sees
  Node.js. The Rust sidecar (`src-tauri/`) owns DB, filesystem, scanner,
  and metadata, talking JSON-RPC over stdio: `docs/electron-migration.md`.
- Reader engines are behind single-module seams — EPUB: only
  `frontend/src/lib/epub/readiumEngine.ts` imports Readium; PDF: only
  `frontend/src/lib/pdf/pdfEngine.ts` imports MuPDF; components use the
  format-agnostic `Reader` abstraction — `docs/epub.md`, `docs/pdf.md`.
- Do not silently change these architectural conventions.

## Commands (in this order)

During the migration phases, run the current set from the justfile — check
`just --list` and `docs/build.md` for what is wired up in this phase.

```sh
pnpm install          # first thing after cloning
just check            # format+lint+typecheck+unit tests, parallel streams
just dev              # launch the app (Electron + Vite hot reload)
just test-e2e         # real-app desktop E2E, headless on Linux (builds first)
just ci               # everything CI runs
```

Single layers:

```sh
just test                            # unit tests, rust + frontend concurrently
just test-rust                       # cargo test (service crate)
just test-frontend                   # vitest run (CI mode)
pnpm --filter frontend exec vitest run <file-or-pattern>
```

Run `just check` (or at minimum the relevant test layer) before declaring
any task complete, and run `just format` if you touched formatting-sensitive
code.

### External Knowledge & Source Research

- **Context7:** Use for up-to-date, version-specific documentation, API references, configuration, and usage examples for libraries, frameworks, SDKs, and tools. Prefer Context7 before relying on remembered API details.
- **GitHits:** Use for source-level investigation of open-source dependencies: implementation details, internals, call paths, existing patterns, version changes, and behavior that is unclear or undocumented. Prefer it when debugging library/runtime behavior rather than merely learning the public API.

### E2E for agents

`just test-e2e` is safe to run from an automated environment (SSH/CI/agent,
headless) and always terminates with failure artifacts left behind — the
full contract, isolation gate, and opt-in flavors are in `docs/testing.md`.
Never run two E2E invocations concurrently.

## Non-obvious gotchas

Each has bitten before (or is a known trap of the new stack). The details
live with the layer they bite — read the relevant doc before touching it:

- Electron security defaults are non-negotiable; no arbitrary
  `ipcRenderer` passthrough — `docs/electron-migration.md`.
- Sidecar lifecycle: survives renderer reload, shut down on quit, no
  orphaned processes — `docs/electron-migration.md`.
- Book bytes/covers flow through the scoped `tuxbooks://` protocol, never
  an arbitrary local HTTP server — `docs/architecture.md`.
- Database: runtime-query SQLx only, embedded numbered migrations, FTS5
  triggers move with `books` columns — `docs/database.md`.
- Reading progress is user data: locators migrate through the versioned,
  idempotent adapter; never reset or destructively rewrite progress rows
  — `docs/epub.md`, `docs/database.md`.
- Testing rules (real library/DB never touched, coverage gate, fixtures,
  no coverage-filler tests) — `docs/testing.md`.
- Performance budgets are gates, not suggestions — `docs/performance.md`.

## Conventions

Coding standards — Rust errors/DTOs, frontend rules, dependency policy:
`docs/STANDARDS.md`. Update docs in `docs/` when you change module
boundaries, schema, or the reader layers.

## Working documents

Read the one that fits the task; each is short.

- `docs/STANDARDS.md` — coding standards.
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
- `docs/testing.md` — test layers, agent rules, and E2E infrastructure.
- `docs/coverage.md` — per-category coverage floors and what is excluded.
- `docs/release.md` — packaging and cutting releases.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
