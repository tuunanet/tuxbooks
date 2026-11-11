# Contributing

1. Fork the repository and create a branch off `main`.
2. Make your change. Keep each pull request to one task.
   Optionally enable the repo's git hooks with `just setup-hooks` (format
   staged files and typecheck on commit, line-count limits on push, plus
   beads' own hooks). Fresh clones do not enable them automatically.

3. Run the full gate before opening the PR:

   ```sh
   just check
   ```

4. Open a pull request against `main`. Describe what changed and how you
   tested it.

For the repo layout, commands, and agent workflow, see
[AGENTS.md](AGENTS.md). Coding standards live in
[docs/STANDARDS.md](docs/STANDARDS.md), coverage floors in
[docs/COVERAGE.md](docs/COVERAGE.md).
