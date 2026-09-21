# Coding standards

Write code that matches the surrounding code. If a local convention conflicts with this document, follow the local convention and mention the difference.

## Keep it small

- Keep functions and modules focused.
- Name concepts plainly.
- Keep each derived value or business rule in one clear location.
- Delete unused code rather than commenting it out.

## Do not over-engineer

- Build the requested behavior, not a framework for hypothetical future behavior.
- Add an abstraction only after a second real caller needs it.
- Handle errors that are expected at a boundary. Do not add fallbacks for impossible states.
- Do not add configuration, flags, options, or dependencies that have no caller.
- Check installed versions before using an API from memory.

## Comments

Comments explain a constraint, trap, root cause, or decision that code cannot express on its own. Do not narrate the next line of code.

## Writing and agent behavior

- Use plain language in prose, comments, logs, and commit messages.
- Do not add decorative emoji, generic summaries, marketing language, or ceremonial comment banners.
- Do not rename or reformat unrelated code.

## Rust

- Errors via `thiserror` enums; no `anyhow` at layer boundaries.
- Wire DTOs serialize `camelCase` — JSON-RPC payloads and the preload
  bridge alike.
- Business logic lives in `domain/`/`services/`; SQL only in
  `repository/` (module table in [ARCHITECTURE.md](ARCHITECTURE.md)).
- `epub/` and `domain/` stay independent of any runtime (Electron, Tauri).

## Frontend

- No synchronous `setState` inside effects (lint rule
  `react-hooks/set-state-in-effect`): do state updates after an `await`
  (see `frontend/src/hooks/useLibrary.ts` for the pattern).
- TypeScript is strict; `any` is banned via lint rule.
- Do not suppress lints globally. A targeted `eslint-disable` needs a
  reason comment (the shadcn `*Variants` exports in `components/ui/` are
  the known cases).
- Components grouped by feature under `src/components/`; the only files
  allowed to talk to the outside world are `src/lib/bridge.ts` (IPC via
  the preload API) and the two engine seams
  (`lib/epub/readiumEngine.ts`, `lib/pdf/pdfEngine.ts`) —
  [ARCHITECTURE.md](ARCHITECTURE.md).
- Only the PDF engine adapters under `frontend/src/lib/pdf/` import an
  engine package (`@embedpdf/pdfium`), its worker module, or its WASM URL
  (`virtual:pdfium-wasm-url`). Reader components depend on the seam's
  re-exported types and helpers, never on an engine directly. ESLint
  `no-restricted-imports` enforces this (ADR 0002, `tuxbooks-koe.10`); add a
  new engine package to the rule when the engine changes.

## Dependencies

- No new dependency (Rust crate or npm package) without a clear, stated
  reason.
- Reader engines are deliberate choices: Readium TS Toolkit (EPUB) and
  PDFium-WASM (PDF). Do not add competing engines or renderers alongside
  them.
- UI primitives come from shadcn/ui (`pnpm dlx shadcn add <component>`;
  config in `frontend/components.json`); icons from `lucide-react` — do
  not hand-roll SVG icons or primitive replacements.
- Local-first desktop app, SQLite only: no network services, Docker,
  PostgreSQL, Redis, or backend server.

## User interface

- Preserve accessibility and use meaningful controls and labels.
- Review the whole affected layout when changing spacing, color, typography, or responsive behavior.

## Commits

- Conventional Commits, required: `type: imperative subject` (e.g. `feat: add
reading progress command`, `fix: keep FTS index in sync on book update`,
  `test:`, `docs:`, `refactor:`, `chore:`). Scope optional; use the layer as
  scope when helpful (`feat(rust):`, `fix(frontend):`).
- Nothing enforces this (no commitlint/husky) — do not commit until the message
  conforms.

A completed change has passed the required checks and been verified. Report intentional gaps, unexpected findings, and unverified behavior plainly.

## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).

The `graft` skill holds the full tool guide (tool choice per task, output
flags, `graft grep` fallbacks, and the per-turn savings tally).
