---
name: vite-plus
description: This project's frontend toolchain is vite-plus (the vp CLI).
  Load before running vp commands, editing the toolchain blocks in
  vite.config.ts, or debugging vp install, versions, or the task cache.
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

## Upgrades and setup gotchas

- Installing or upgrading the toolchain train trips the 30-day release-age
  floor (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The fix is dated
  `name@version` pins in `minimumReleaseAgeExclude` in
  `pnpm-workspace.yaml`; docs/SUPPLY_CHAIN.md documents the procedure.
- A fresh clone bootstrapped with `vp install` alone links node_modules
  without pnpm's ignored-builds record, which fails `just check`'s
  supply-chain stream until a plain `pnpm install` relinks.
- Do not run `vp create` or `vp migrate` with agent setup here: with no
  marker section in AGENTS.md, it appends the generic vite-plus block back.
  This skill is the agent guidance for this repo; re-sync it by hand from
  `node_modules/vite-plus/AGENTS.md` when the packaged template changes.

No global vp installed? Prefix vp commands with `pnpm exec`, which resolves
the project-pinned copy (the justfile does this everywhere so CI works
without a global install).

## Tool versions and troubleshooting

`vp toolchain` shows the active release's version graph; add a tool name to
select a part of it (`vp toolchain vite`), and `--global` ignores the local
package. `vp why <package>` walks the dependency graph. If install, runtime,
or package-manager behavior looks wrong, run `vp env doctor` and include its
output when asking for help.
