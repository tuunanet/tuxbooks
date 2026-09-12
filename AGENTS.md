# AGENTS.md

Instructions for coding agents working in this repository. Verified commands
only — run them, don't assume. Each layer's non-obvious gotchas live in its
doc under `docs/` — read the relevant doc before touching that layer.

## Keep this file compact

AGENTS.md loads into every session. High-signal detail lives in the `docs/`
files it refers to; before adding anything here, check whether an existing
doc in `docs/` is the right home for it. If no suitable `.md` exists, create
one in `docs/` and refer to it from the appropriate section — do not inline.

## What this project is

Local-first desktop ebook library (bookshelf style). **Rust is the
application/domain language; React/TypeScript is only the presentation
layer; Chromium (via Electron) is the sole desktop web runtime.**

- Business logic in Rust (`domain/`, `services/`), UI logic in TypeScript,
  SQL only in `repository/`. Module boundaries and process model:
  `docs/architecture.md`.
- Electron `main`/`preload` are plumbing only; the renderer never sees
  Node.js. The Rust sidecar (`sidecar/`) owns DB, filesystem, scanner,
  and metadata.
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

Use the following tools when repository context alone is insufficient. Prefer the most specific source for the question rather than using a generic web search.

* **Context7 — official/current documentation:** Use for up-to-date, version-specific documentation, API references, configuration, and usage examples for libraries, frameworks, SDKs, and tools. Prefer Context7 over remembered API details.

* **GitHits — source-level investigation:** Use for open-source dependency internals, implementation details, call paths, version changes, existing patterns, and behavior that is unclear or undocumented. Prefer GitHits when debugging how a dependency actually works rather than simply learning its public API.

* **Firecrawl — web research:** Use `firecrawl-search` whenever information must be obtained from the public web, including current information, technical research, GitHub issues/discussions, release information, comparisons, news, prices, or other information not available in the repository or through Context7/GitHits. Prefer official documentation, upstream repositories, and other primary sources. Do not guess when external verification is available.

**Tool selection:**

1. Current library/API documentation → **Context7**
2. Dependency implementation or runtime behavior → **GitHits**
3. General/current information or web research → **Firecrawl**
4. If multiple sources are relevant, use them together and cross-check important technical conclusions.

Do not invoke graphify merely because the question is being asked from within this repository. The question itself must concern the TuxBooks codebase.

### E2E for agents

`just test-e2e` is safe to run from an automated environment (SSH/CI/agent,
headless) and always terminates with failure artifacts left behind — the
full contract, isolation gate, and opt-in flavors are in `docs/testing.md`.
Never run two E2E invocations concurrently.

## Conventions

Coding standards — Rust errors/DTOs, frontend rules, dependency policy:
`docs/STANDARDS.md`. Update docs in `docs/` when you change module
boundaries, schema, or the reader layers.

## Working documents

Read the one that fits the task; each is short.

- `docs/STANDARDS.md` — coding standards.
- `docs/architecture.md` — module boundaries, process model, frontend
  structure.
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

This project has a codebase knowledge graph in `graphify-out/`.

**Scope:** Use graphify **only for questions about this project's codebase, architecture, dependencies, implementation, or relationships between source files/concepts. Do not use graphify for general knowledge, web research, current information, weather, news, prices, or other questions unrelated to the codebase.

* When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.
* For codebase questions, first run `graphify query "<question>"` when `graphify-out/graph.json` exists.
* Use `graphify path "<A>" "<B>"` when investigating relationships between two entities.
* Use `graphify explain "<concept>"` for focused investigation of a specific concept.
* Dirty `graphify-out/` files are expected after hooks or incremental updates; do not skip graphify because the files are dirty.
* Skip graphify when the task concerns stale or incorrect graph output, or when the user explicitly asks not to use it.
* If `graphify-out/wiki/index.md` exists, use it for broad codebase navigation instead of raw source browsing.
* Read `graphify-out/GRAPH_REPORT.md` only for broad architecture reviews or when `query`, `path`, or `explain` do not provide sufficient context.
* After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
