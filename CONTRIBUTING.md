# Contributing

1. Fork the repository and create a branch off `main`.
2. Make your change. Keep each pull request to one task.
   Optionally enable the repo's git hooks with `just setup-hooks` (format
   staged files and typecheck on commit, comment-budget and line-count limits
   on push, plus beads' own hooks). Fresh clones do not enable them
   automatically.

3. Run the full gate before opening the PR:

   ```sh
   just check
   ```

   This includes the per-file comment budget: 10 explanatory comment lines
   per Rust or TypeScript file, with doc comments, lint directives, and
   `SAFETY:` blocks exempt. Existing files may not grow past their current
   count. If it fails, `just comment-explain <file>` prints every counted and
   exempt line, and `just comment-report` lists the over-budget files. The
   full policy is in [docs/STANDARDS.md](docs/STANDARDS.md#comments).

4. Open a pull request against `main`. Describe what changed and how you
   tested it.

For the repo layout, commands, and agent workflow, see
[AGENTS.md](AGENTS.md). Coding standards live in
[docs/STANDARDS.md](docs/STANDARDS.md), coverage floors in
[docs/COVERAGE.md](docs/COVERAGE.md).
