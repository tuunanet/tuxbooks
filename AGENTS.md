# AGENTS.md

Each layer's non-obvious gotchas live in its doc under `docs/` — read it before
touching that layer. This file loads into every session, so high-signal detail 
belongs in `docs/`: use an existing doc before adding anything here, create one 
in `docs/` if none fits; update docs when you change module boundaries, schema, 
or reader layers.

## Writing for humans

Invoke the `unslop` skill over anything a person will read, before you commit,
post, or send it: commit messages, the PR title and body, README and doc edits,
code comments, and the closing reply. It strips AI tells (em dashes, filler,
hedging, chatbot phrases, puffery, bold-label lists) and replaces fancy
words with plain ones and passive voice with active. Apply it to text you
wrote or changed, not to prose you didn't touch.

## Issue tracking

This project uses bd (beads) for issue tracking. Do not use markdown TODO lists for
task tracking. Use `beads` skill to learn more about beads for issue tracking.
Use `bd remember "insight"` for persistent project memory; do not create MEMORY.md files.

## Commands

The live command set is in the justfile — check `just --list` and
`docs/BUILD.md` for what is wired up in this migration phase. Run `just check`
(or at minimum the relevant test layer) before declaring any task complete;
run `just format` if you touched formatting-sensitive code.

```sh
pnpm install                 # first thing after cloning
just check                   # format+lint+typecheck+unit tests, parallel streams
just dev                     # launch the app (Electron + Vite hot reload)
just test-e2e                # real-app desktop E2E, headless on Linux (builds first)
just test                    # unit tests, rust + frontend concurrently
just test-rust               # cargo test (service crate)
just test-frontend           # vitest run (CI mode)
just bump X.Y.Z              # apply a release version to all versioned files
just audit                   # maturity policies, run this before releases.
bd ready`                    # List tasks with no open blockers.
bd create "Title" -p 0`      # Create a P0 task.
bd update <id> --claim`      # Atomically claim a task (sets assignee + in_progress).
bd dep add <child> <parent>` # Link tasks (blocks, related, parent-child).
bd show <id>`                # View task details and audit trail.
bd prime`                    # Print agent workflow context and persistent memories.
bd remember "insight"`       # Store project memory that `bd prime` injects later.
pnpm --filter frontend exec vitest run <file-or-pattern>
```

### External knowledge & source research

When repository context alone is insufficient, prefer the most specific source:
**Context7** → current, version-specific library/API docs; **GitHits** →
dependency internals and undocumented runtime behavior; **Firecrawl**
(`firecrawl-search`) → the public web. Cross-check when multiple apply; don't
guess. Full policy: `docs/RESEARCH.md`.

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
- `docs/SUPPLY_CHAIN.md` — dependency audits, SBOM, build-script.
- `docs/ABOUT.md` — basic information regarding what this project is.
