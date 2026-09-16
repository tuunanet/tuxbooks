# AGENTS.md

Instructions for coding agents in this repository. Verified commands only —
run them, don't assume. Each layer's non-obvious gotchas live in its doc
under `docs/` — read it before touching that layer. This file loads into
every session, so high-signal detail belongs in `docs/`: use an existing doc
before adding anything here, create one in `docs/` if none fits; update docs
when you change module boundaries, schema, or reader layers.

## What this project is

Local-first desktop ebook library (bookshelf style). **Rust is the
application/domain language; React/TypeScript is only the presentation
layer; Chromium (via Electron) is the sole desktop web runtime.**

- Business logic in Rust (`domain/`, `services/`), UI logic in TypeScript, SQL
  only in `repository/` — boundaries and process model: `docs/ARCHITECTURE.md`.
- Electron `main`/`preload` are plumbing only; the renderer never sees Node.js.
  The Rust sidecar (`sidecar/`) owns DB, filesystem, scanner, and metadata.
- Reader engines behind single-module seams: only
  `frontend/src/lib/epub/readiumEngine.ts` imports Readium, only
  `frontend/src/lib/pdf/pdfEngine.ts` imports MuPDF; components use the
  format-agnostic `Reader` abstraction (`docs/EPUB.md` / `docs/PDF.md`).
- Do not silently change these architectural conventions.

## Writing for humans

Invoke the `unslop` skill over anything a person will read, before you commit, post, or
send it: commit messages, the PR title and body, README and doc edits, code
comments, and the closing reply. It strips AI tells (em dashes, filler,
hedging, chatbot phrases, puffery, bold-label lists) and replaces fancy
words with plain ones and passive voice with active. Apply it to text you
wrote or changed, not to prose you didn't touch.

## Commands

The live command set is in the justfile — check `just --list` and
`docs/BUILD.md` for what is wired up in this migration phase. Run `just check`
(or at minimum the relevant test layer) before declaring any task complete;
run `just format` if you touched formatting-sensitive code.

```sh
pnpm install          # first thing after cloning
just check            # format+lint+typecheck+unit tests, parallel streams
just dev              # launch the app (Electron + Vite hot reload)
just test-e2e         # real-app desktop E2E, headless on Linux (builds first)
just test             # unit tests, rust + frontend concurrently
just test-rust        # cargo test (service crate)
just test-frontend    # vitest run (CI mode)
just bump X.Y.Z       # apply a release version to all versioned files
pnpm --filter frontend exec vitest run <file-or-pattern>
```

### External knowledge & source research

When repository context alone is insufficient, prefer the most specific source:
**Context7** → current, version-specific library/API docs; **GitHits** →
dependency internals and undocumented runtime behavior; **Firecrawl**
(`firecrawl-search`) → the public web. Cross-check when multiple apply; don't
guess. Full policy: `docs/RESEARCH.md`.

### E2E for agents

`just test-e2e` is safe from automated environments (SSH/CI/agent, headless)
and always terminates, leaving failure artifacts behind — full contract,
isolation gate, and opt-in flavors in `docs/TESTING.md`. Never run two E2E
invocations concurrently.

## Working documents

Read the one that fits the task; each is short.

- `docs/STANDARDS.md` — coding standards.
- `docs/ARCHITECTURE.md` — module boundaries, process model, frontend structure.
- `docs/BUILD.md` — build flavors, dev environment.
- `docs/DATABASE.md` — schema, migrations, FTS5.
- `docs/EPUB.md` / `docs/PDF.md` — reader layer contracts (Readium / MuPDF.js).
- `docs/PERFORMANCE.md` — reader performance budgets/metrics and verification;
  check before touching reader rendering.
- `docs/RESOURCE_LIMITS.md` — parser resource quotas (issue #83), the
  `ResourceLimits` table every EPUB/PDF parse path enforces.
- `docs/TESTING.md` — test layers, agent rules, and E2E infrastructure.
- `docs/COVERAGE.md` — per-category coverage floors and exclusions.
- `docs/RELEASE.md` — packaging and cutting releases.
