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

## Frontend

- No synchronous `setState` inside effects (lint rule
  `react-hooks/set-state-in-effect`): do state updates after an `await`
  (see `frontend/src/hooks/useLibrary.ts` for the pattern).

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
