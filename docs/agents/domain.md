# Domain docs

How the engineering skills consume this repo's domain documentation.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root. This is a single-context repo; if a
  **`CONTEXT-MAP.md`** appears at the root later, it points at one `CONTEXT.md`
  per context — read each one relevant to the topic.
- **`docs/adr/`** — read the ADRs that touch the area you are about to work in
  (for example `0001-sandboxed-document-worker.md`). Single-context, so there
  are no per-context ADR directories.

If these files don't exist, proceed silently. Don't flag their absence or
suggest creating them; `/domain-modeling` (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions
are actually resolved.

## Layout

This repo is single-context:

```
/
├── CONTEXT.md
├── docs/adr/            # system-wide decisions
├── frontend/
└── sidecar/
```

A multi-context repo instead has a root `CONTEXT-MAP.md` pointing at
`<context>/CONTEXT.md` files that keep their own `docs/adr/`.

## Use the glossary's vocabulary

When output names a domain concept (an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift
to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're
inventing language the project doesn't use (reconsider) or there's a real gap
(note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0001 (sandboxed document worker), but worth reopening because…_
