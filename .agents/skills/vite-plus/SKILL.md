---
name: vite-plus
description: This project's frontend toolchain is vite-plus (the vp CLI).
  Load before running vp commands, running package-manager commands
  (install, update, dedupe, audit, why, outdated), editing the toolchain
  blocks in vite.config.ts, or debugging vp installs, versions, or the
  task cache.
---

# vite-plus

Vite+ unifies Vite, Rolldown, Vitest, Oxlint, Oxfmt, and Vite Task behind one
CLI, `vp`, which also manages Node and selects this repo's pinned pnpm. Docs
ship in the package at `node_modules/vite-plus/docs` and online at
https://viteplus.dev/guide/.

## Built-in commands vs scripts and tasks

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json`
script or a `vite.config.ts` task, and scripts cannot shadow built-ins, so
`vp dev` and `vp run dev` may do different things. Check `package.json` and
`vite.config.ts` first, then pick the form that matches the target.

## This monorepo

- `vp lint`, `vp fmt`, and `vp check` work from the repo root; their config
  lives in the root `vite.config.ts` (`lint`, `fmt`, and `run` blocks).
- `vp test` from the root discovers `frontend/tests/` but runs it without
  the frontend project config, so every file fails on the `@/` import
  alias. Use the cached task (`vp run frontend:test`) or
  `vp -C frontend test run <file-or-pattern>`.
- The `frontend:test` and `frontend:build` tasks are content-cached with
  automatic input tracking: an unchanged tree replays the recorded run, and
  any changed input forces a real run that names the file which changed.
  `vp run --no-cache <task>` bypasses the cache and `vp cache clean` resets
  it. The input/output exclusions (coverage artifacts, boundary-test
  fixtures) are documented next to the task definitions in the root config.
- Git hooks stay owned by beads (`core.hooksPath` points at `.beads/hooks`),
  so vp's hook dispatcher is intentionally not installed.

## Dependency maintenance

Route package-manager work through vp. With the global CLI installed,
the setup the docs recommend (global plus local together), bare `vp` is
the entry point: it delegates to the project's pinned toolchain and its
help lists the full command set. Where the global is absent (containers),
prefix `pnpm exec` as the fallback note below describes.
The commands forward to the pinned pnpm, so `vp install`, `vp add`,
`vp remove`, `vp update`, `vp dedupe`, `vp outdated`, `vp why`,
`vp info`, and `vp pm audit` cover dependency maintenance. The full
command list lives in
`node_modules/vite-plus/docs/guide/package-management.md`.

Verified behavior worth knowing before you rely on a command:

- In vite-plus 1.3.0 the project-local CLI's `vp --help` lists only
  `install`; the global CLI of the same version lists every command
  under "Manage Dependencies". The local commands still run, so trust
  `vp <command> --help` or the shipped guide over the local top-level
  help. Worth re-checking after a toolchain bump.
- `vp update`, like the pnpm behind it, moves direct dependencies
  within their declared ranges. A transitive the lockfile already pins
  does not move, whatever arguments you pass. To force one transitive
  to re-resolve, delete its entries from `pnpm-lock.yaml` and
  reinstall; pnpm regenerates only those entries.
- `vp outdated` reports direct dependencies only. A transitive advisory
  never appears there; reach those through `vp pm audit --json` or the
  repo's audit gate.
- `vp why` printed nothing in this repo for a dev-only transitive
  package, and plain `pnpm why` was silent in the same checkout, while
  `grep hono pnpm-lock.yaml` found it. Stale node_modules is the
  unconfirmed suspect: every fresh scratch reproduction prints the
  tree, flat or workspace, direct or transitive, pinned pnpm 10 or 12.
  Treat empty why output as untrusted: grep the lockfile, reinstall if
  the tree looks stale (see the install gotcha below).
- `pnpm ignored-builds` has no vp equivalent; the supply-chain gate
  reads it directly (see the install gotcha below).

## Upgrades and setup gotchas

- Installing or upgrading the toolchain train trips the 30-day release-age
  floor (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The fix is dated
  `name@version` pins in `minimumReleaseAgeExclude` in
  `pnpm-workspace.yaml`; docs/SUPPLY_CHAIN.md documents the procedure.
- `vp install` is the primary install command and delegates to the repo's
  pinned pnpm. If node_modules is stale or half-linked, the symptom is
  `Cannot find module 'vite-plus/test'` across the test suite. Recover
  with a plain `pnpm install`: it relinks node_modules and restores
  pnpm's ignored-builds record, which `just check`'s supply-chain stream
  reads through `pnpm ignored-builds`.
- Do not run `vp create` or `vp migrate` with agent setup here: with no
  marker section in AGENTS.md, it appends the generic vite-plus block back.
  This skill is the agent guidance for this repo; re-sync it by hand from
  `node_modules/vite-plus/AGENTS.md` when the packaged template changes.

No global vp installed? Prefix vp commands with `pnpm exec`, which resolves
the project-pinned copy. The justfile calls bare vp and CI installs it
via voidzero-dev/setup-vp, so pnpm exec is the fallback for bare
containers, not the default route.

## Tool versions and troubleshooting

`vp toolchain` shows the active release's version graph; add a tool name to
select a part of it (`vp toolchain vite`), and `--global` ignores the local
package. If install, runtime, or package-manager behavior looks wrong, run
`vp env doctor` and include its output when asking for help. `env` lives in
the global CLI only; the project-local `vp` refuses it with a pointer, so
install a global vp first or paste the refusal.
