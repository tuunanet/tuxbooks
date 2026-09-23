# AGENTS.md

TuxBooks is a local-first ebook library and reader: an Electron + React +
TypeScript frontend, a Rust sidecar, and Readium/PDFium reader layers.

## Preparing for a task

Work happens in a fresh git worktree branched from `origin/main` under `.worktrees/`;
never build on `main`. When creating a new worktree, make sure related uncommitted
changes are switched from `main` to the worktree, especially files in `.beads`.

## Completing a task

1. Keep changes limited to the assigned task.
2. Run the full gate once: `just check` (run `just format` first if needed).
3. Assemble the evidence captured along the way into before/after pairs.
4. Commit with a clear message (conventional commits), rebase onto the latest
   `origin/main`, and rerun the gate.
5. Push (`git push -u origin <branch>`; after rebasing a pushed branch,
   `--force-with-lease`). Open the PR with what changed, how it was tested
   (every claim backed by evidence), before/after proof, and any risks or
   follow-up work. Run the title and body through `unslop` before posting.
6. Remove the worktree after the PR merges.

## Multi-agent rules

- Never commit directly to `main`.
- One worktree and one branch per task and per agent — never reuse or modify
  another agent's worktree, branch, or uncommitted work.
- **Scope check** before starting: skim open PRs' changed files
  (`gh pr list`, `gh pr diff <n> --name-only`) and look for uncommitted work
  in shared checkouts. On overlap, stop and ask for direction.
- Never force-push to `main` — and never plain `--force` anywhere; only
  `--force-with-lease`, only on your own task branch.
- Resolve lockfile conflicts by regenerating, never by hand-merging.
- Worktrees don't isolate shared resources: confirm a dev-server port
  answers _your_ process before trusting it, and don't run schema
  experiments against a shared database.
- If a conflict can't be resolved confidently, stop and report instead of
  guessing.

## Route the task, then work

Choose the cheapest path that fits. Do not explore "just in case".

| Task                                        | First move                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A symbol or behavior you can already name   | Locate it (`graft` or Grep), read only the range you need, edit, run one focused test.      |
| An unfamiliar area                          | Delegate discovery to the `explore` agent, then read only the files and symbols it returns. |
| Architecture, security, or reader contracts | Read the one relevant doc (below), then inspect only the affected module.                   |
| Multi-file refactor                         | Plan first; keep discovery separate from editing.                                           |

Exploration rules:

- `Grep`/`Glob` respect `.gitignore`. Use them. Never `ls -R`, `find`, or crawl the tree.
- Read the smallest range that answers the question, not whole large files.
- Never run the same search with reworded queries. If 2-3 searches have not found it, stop and launch `explore`.
- For structural questions (who calls what, where a behavior lives), use `graft` before grep or a file read.

## Graft: repo context graph

`graft/` is a prebuilt graph of this repo, kept in sync with the code. Use the
**graft CLI** (the MCP server is off by design); most tasks need one call.

```sh
graft ask "<question>" --source   # locate + understand; inlines the code crux
graft skeleton <file>             # a file's API in ~200 tokens
graft grep "<pattern>"            # exhaustive, ranked by coupling
graft callers <symbol> --depth 2  # blast radius before a rename or refactor
graft map                         # orientation in an unfamiliar area
```

Load the `graft` skill for the full guide. Trust the answer and act; do not
re-open or re-grep a file to double-check a span graft already gave you.

## Lazy documentation

Do not read docs at session start. Load only the one that matches the task, and
skip it when `graft` already answers the question.

- Reader rendering and performance: `docs/PERFORMANCE.md`, then `docs/EPUB.md` or `docs/PDF.md`.
- Parser quotas and limits: `docs/RESOURCE_LIMITS.md`.
- DB schema or migrations: `docs/DATABASE.md`.
- Test layers, fixtures, E2E: `docs/TESTING.md`.
- Build flavors and packaging: `docs/BUILD.md`, `docs/RELEASE.md`.
- Module boundaries and process model: `docs/ARCHITECTURE.md`.
- Coding standards: `docs/STANDARDS.md`; coverage floors: `docs/COVERAGE.md`.
- Dependency and SBOM policy: `docs/SUPPLY_CHAIN.md`; project overview: `docs/ABOUT.md`.

## Commands and verification

Use the narrowest command first. Run the full gate once, near the end, not
during iteration.

```sh
# frontend (React + vitest)
pnpm --filter frontend exec vitest run <file-or-pattern>
pnpm --filter frontend typecheck && pnpm --filter frontend lint

# rust sidecar
cargo test --manifest-path sidecar/Cargo.toml <target>
cargo clippy --manifest-path sidecar/Cargo.toml --all-targets --all-features -- -D warnings

# electron (main + preload)
pnpm exec tsc -p electron --noEmit

# full gate, once before you declare done
just check          # format + lint + typecheck + unit tests, parallel streams
just format         # only if you touched formatting-sensitive code
```

Do not run `just check`, `just test`, or `just test-e2e` after every edit.
Iterate with the single narrowest command, then run the full gate once.
Area-specific layout and commands live in the nearest `AGENTS.md`
(`frontend/`, `sidecar/`, `electron/`, `e2e/`) and load automatically in that subtree.

## Writing for humans

Invoke the `unslop` skill over anything a person will read before you commit,
post, or send it: commit messages, the PR title and body, README and doc edits,
code comments, and the closing reply. It strips AI tells (em dashes, filler,
hedging, chatbot phrases, puffery, bold-label lists), swaps fancy words for
plain ones and passive voice for active. Apply it to text you wrote or changed,
not to prose you did not touch.

## Agent skills

- Issue tracker: bd (Beads), the repo's tracker; use the `bd` CLI. See `docs/agents/issue-tracker.md`.
- Triage labels: the five canonical roles use their default strings as bd labels. See `docs/agents/triage-labels.md`.
- Domain docs: single context, one `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## External knowledge

Only for library, API, or dependency questions, not routine repo work: Context7
for current library docs, GitHits for dependency internals, Firecrawl
(`firecrawl-search`) for the public web. Cross-check when more than one applies.
Full policy: `docs/RESEARCH.md`.
