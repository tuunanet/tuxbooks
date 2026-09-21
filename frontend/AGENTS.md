# frontend

React + TypeScript renderer, bundled by Vite. `src/components` (UI),
`src/state` (app/store), `src/hooks`, `src/lib/epub` (Readium) and `src/lib/pdf`
(PDFium). Tests live in `tests/` (vitest + Testing Library); `tests/security/`
covers the content-fence policy, `tests/mocks/` holds shared fixtures.

Narrow commands:

```sh
pnpm --filter frontend exec vitest run <file-or-pattern>   # one test file
pnpm --filter frontend typecheck
pnpm --filter frontend lint
```

Before changing reader rendering or scroll behavior, read the relevant budgets
in `docs/PERFORMANCE.md` and the engine contract in `docs/EPUB.md` or
`docs/PDF.md`.
