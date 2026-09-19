# AGENTS.md

## Writing for humans

Invoke the `unslop` skill over anything a person will read, before you commit,
post, or send it: commit messages, the PR title and body, README and doc edits,
code comments, and the closing reply. It strips AI tells (em dashes, filler,
hedging, chatbot phrases, puffery, bold-label lists) and replaces fancy
words with plain ones and passive voice with active. Apply it to text you
wrote or changed, not to prose you didn't touch.

## Feature work

- Every new feature starts in a fresh Git worktree branched from `origin/main`
  so agents can work in parallel without conflicts. Never build on `main`.
  Place new worktrees inside `.worktrees/` directory and remove the worktree
  after PR has been completed/merged.

## Completing a task

1. Keep changes limited to the assigned task.
2. Run the repo's checks: `just check` (format+lint+typecheck+unit tests;
   run `just format` first if you touched formatting-sensitive code).
3. Assemble the evidence captured along the way into before/after pairs.
4. Commit with a clear message (conventional commits), rebase onto the latest
   `origin/main`, and rerun the checks.
5. Push (`git push -u origin <branch>`; after rebasing an already-pushed
   branch, `--force-with-lease`).
6. Open the PR. The body must explain what changed, how it was tested (every
   claim backed by evidence), before/after proof, and any risks or follow-up
   work. Run the title and body through with `unslop` skill before posting.

## Agent skills

### Issue tracker

Issues and specs live in bd (Beads), the repo's existing tracker; use the `bd`
CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings, as bd labels.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

## Graft — repo context graph

This repo is indexed in `graft/`: small linked
markdown nodes with exact `file:line` spans, kept in sync with the code. For any task,
get context from the graph before grepping or opening source files — it is faster and cheaper.
New to the repo? Run `graft map` first. Use the `graft` skill for the tool guide. Conventions
and details: `docs/STANDARDS.md` (Graft — repo context graph).

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
pnpm --filter frontend exec vitest run <file-or-pattern>
```

Task tracking is bd (Beads) — command reference in
`docs/agents/issue-tracker.md`.

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

Remember to update and evolve information within `./docs` when something important changes.
