# AGENTS.md

TuxBooks is a local-first ebook library and reader: an Electron + React +
TypeScript frontend, a Rust sidecar, and Readium/PDFium reader layers.

## Preparing for a task

Work happens in a fresh git worktree branched from `origin/main` under `.worktrees/`;
never build on `main`. After creating a worktree, run `vp install` at its root
before running tests; `just check` assumes installed dependencies.

Work is tracked in bd (Beads), the repo's issue tracker; see
`docs/agents/issue-tracker.md` for the workflow. Triage uses the five
canonical roles as bd labels (`docs/agents/triage-labels.md`).

## Completing a task

1. Keep changes limited to the assigned task.
2. Run the full gate once: `just check` (run `just format` first if needed).
   Skip it for docs-only changes, meaning the diff touches only `*.md` files
   or other non-code scopes; `.github/workflows/ci.yml`'s classify step
   defines that set and skips CI's heavy jobs for it. Proofread the diff
   instead.
3. Review the branch with the `code-review` skill (Standards + Spec, fixed
   point `origin/main`) and fold findings in before pushing. Docs-only
   changes use one pass instead of both axes: check each factual claim
   against the doc it cites.
4. Assemble the evidence captured along the way into before/after pairs.
5. Commit with a clear message (conventional commits), rebase onto the latest
   `origin/main`, and rerun the gate (the docs-only skip in step 2 applies).
6. Push (`git push -u origin <branch>`; after rebasing a pushed branch,
   `--force-with-lease`). Open the PR with the `pr` skill's body template
   (summary, evidence, merge danger) and run the title and body through
   `unslop` before posting.
7. Tracker data rides Dolt, not git: `bd dolt pull` before tracker work in a
   session, `bd dolt push` after it. Beads never adds files to a task PR
   (`.beads/*.jsonl` are local-only). Full rules live in
   `docs/agents/issue-tracker.md`.
8. Remove the worktree after the PR merges.

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
The CLI is a devDependency, so `vp install` provides it; like vp, bare `graft`
uses a global install when one exists, and without a global prefix `pnpm exec`.

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
- Domain model and decisions: `CONTEXT.md` plus `docs/adr/` (conventions: `docs/agents/domain.md`).

## Commands and verification

Use the narrowest command first. Run the full gate once, near the end, not
during iteration. The frontend stack is vite-plus (`vp`); load the
`vite-plus` skill before running vp commands, running package-manager
commands (vp or pnpm install/update/dedupe/audit), or touching the
toolchain config. Task handovers and agent notes may point at skills but
never narrow that list.

```sh
# frontend (React + vitest via vite-plus)
vp -C frontend test run <file-or-pattern>
vp -C frontend run typecheck && vp lint

# bare vp uses the global CLI when one is installed and delegates to
# this repo's pinned toolchain; without a global (CI, containers) prefix
# pnpm exec, as the justfile does. vp check is the JS slice only (fmt,
# lint, types); just check below is the full polyglot gate.

# rust sidecar
cargo test --manifest-path sidecar/Cargo.toml <target>
cargo clippy --manifest-path sidecar/Cargo.toml --all-targets --all-features -- -D warnings

# electron (main + preload; not a vp project, pnpm exec just resolves tsc)
pnpm exec tsc -p electron --noEmit

# full gate, once before you declare done (docs-only changes skip it)
just check          # format + lint + typecheck + unit tests, parallel streams
just format         # only if you touched formatting-sensitive code
```

Do not run `just check`, `just test`, or `just test-e2e` after every edit.
Iterate with the single narrowest command, then run the full gate once on
code changes; docs-only changes skip it per "Completing a task" step 2.
Area-specific layout and commands live in the nearest `AGENTS.md`
(`frontend/`, `sidecar/`, `electron/`, `e2e/`) and load automatically in that subtree.

## Writing for humans

Invoke the `unslop` skill over anything a person will read before you commit,
post, or send it: commit messages, the PR title and body, README and doc edits,
code comments, and the closing reply. It strips AI tells (em dashes, filler,
hedging, chatbot phrases, puffery, bold-label lists), swaps fancy words for
plain ones and passive voice for active. Apply it to text you wrote or changed,
not to prose you did not touch.

## External knowledge

Only for library, API, or dependency questions, not routine repo work: Context7
for current library docs, GitHits for dependency internals, Firecrawl
(`firecrawl-search`) for the public web. Cross-check when more than one applies.
Full policy: `docs/RESEARCH.md`.
