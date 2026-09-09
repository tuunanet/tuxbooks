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
  `repository/` (module table in [architecture.md](architecture.md)).
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
  [architecture.md](architecture.md).

## Dependencies

- No new dependency (Rust crate or npm package) without a clear, stated
  reason.
- Reader engines are deliberate choices: Readium TS Toolkit (EPUB) and
  MuPDF.js (PDF). Do not add competing engines or renderers alongside
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
