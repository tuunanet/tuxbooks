# TypeScript 7 upgrade — step-by-step handover

Status as of 2026-09-10: **route A (side-by-side) executed and merged as PR
#30**. Root `typescript@^7.0.2` compiles both `tsc` streams; typescript-eslint
stays on 8.x, fed `typescript@6.0.3` by frontend's manifest (see
"Unblocking approaches" and step 3). TS 7 is the typescript-go rewrite —
a different compiler, not a normal major — so the typecheck stream is still a
staged migration, not a version bump. The original blocker record (PR #28 and
the `typescript >= 7` ignore) is kept below for archaeology.

## Investigation log

- **2026-09-10** (branch `chore/typescript-7`): re-verified all preconditions
  against the live tree and the npm registry. Still blocked, now doubly:
  1. TS 7 gate **still closed** — `typescript-eslint` 8.70.0 (latest,
     2026-09-07) peers `typescript >=4.8.4 <6.1.0` and the hard-exit guard
     (`if (versionMajor >= 7)` → throw) is still in HEAD: `packages/eslint-plugin/src/index.ts`,
     `packages/parser/src/index.ts`, `packages/typescript-eslint/src/index.ts`.
     Upstream tracks TS ≥7.1 support in typescript-eslint#10940; the TS 7.0
     announcement itself models typescript-eslint as consuming the TS 6 API
     side-by-side, not TS 7 natively.
  2. Prerequisite train **not landed** — tree has vite 7.3.6 / vitest 3.2.7 /
     plugin-react 5.2.0; registry now has vitest 5.0.0 (peers vite ^6/^7/^8)
     and plugin-react 6.1.1 (peers vite ^8 only), so the train is
     vitest-5/vite-8/plugin-react-6, one migration, per the dependabot ignores.
  3. Passing preconditions: CI green on main, tree clean, zero open
     Dependabot PRs, single `typescript@5.9.3` in the tree (`pnpm why`).
  - **The 6.x rung is ecosystem-ready but ordered behind the train:**
    `typescript@6.0.3` (2026-04-16) is admitted by the 8.70.0 peer range
    (`<6.1.0`) and passes the hard-exit guard (fires at `>= 7` only). When
    the vitest/vite train lands, TS 6.0.x is the next rung by the steps
    below with `6.0.x` substituted and the `typescript >= 7` ignore intact.
- **2026-09-10, later (same branch): route A executed.** The pnpm
  selective-override mechanism was tried first and failed empirically
  (spec rewrite without instance materialization — see step 3); the
  working shape is the manifest flip: root `typescript@^7.0.2` runs both
  `tsc` streams, frontend `typescript@6.0.3` feeds the typescript-eslint
  peer. Lint stream verified passing (no hard-exit). Merged as PR #30.

## Unblocking approaches (evaluated 2026-09-10)

Only `typescript-eslint` hard-blocks TS 7; the vite/vitest train is
sequencing, not a dependency gap (vitest 5.0.0 + vite 8 + plugin-react 6.1.1
already coexist in the registry). The lint stream lints syntax-only
(`tseslint.configs.recommended`, no `parserOptions.project`, zero
`eslint-disable` comments in `frontend/src`) — it never touches the TS
type-checker API. Evaluated options:

- **A. Side-by-side (chosen):** root `typescript@^7.0.2` is the build
  compiler for both `tsc` streams (root `.bin/tsc`, invoked as
  `tsc -p frontend` and `tsc -p electron` — the same-compiler invariant
  holds exactly); frontend pins `typescript@6.0.3` (exact) as a devDep
  solely so `typescript-eslint` resolves a supported TS peer by name. This
  is the arrangement the TS 7.0 announcement and the guard message itself
  sanction ("run typescript-eslint using the TS 6 API"); both streams see a
  _supported_ compiler, so the hard-exit never fires. A pnpm selective
  override (`"typescript-eslint>typescript": "6.0.3"`) was tried first and
  rejected — see step 3. Perf ledger: app bytes unchanged (`tsc --noEmit`
  emits nothing; esbuild transforms TS itself and never invokes the
  `typescript` package), typecheck faster on TS 7, lint neutral. Costs: two
  TS majors in the tree, deliberate and disjoint by consumer — the
  `pnpm why typescript` check in step 2 encodes the expected
  shape. Route A deliberately runs _before_ the vitest-5/vite-8 train: TS
  manifests are disjoint from that train, whose remaining blocker
  (ast-v8-to-istanbul JSX attribution, PR #12) is upstream and TS-unrelated.
- **B. Replace the lint stack:** oxlint or Biome — neither consumes the
  TypeScript compiler, so "compiler bump breaks lint" disappears as a class.
  Our surface is shallow: syntax-only recommended set + react-hooks +
  react-refresh + one custom rule (`TSAnyKeyword` ban → `no-explicit-any`);
  gaps: react-refresh's `vite` rule has no oxlint equivalent, and a
  rule-parity audit is required. Bonus: oxlint's type-aware layer (tsgolint)
  runs on tsgo — i.e., TS 7. Do this later, on its own merits, as its own
  migration with the full `just check` gate.
- **C. Wait:** do nothing; upstream support tracked in
  typescript-eslint#10940.

## Why it is blocked today

- `typescript-eslint` 8.x peers `typescript >=4.8.4 <6.1.0` and
  **hard-exits** on TS 7 ("typescript-eslint does not support TS 7.0") —
  this is what failed CI in PR #28 before the ignore landed. The lint
  stream is the first gate to break.
- TS 7 is a new compiler (Go): different diagnostics, different perf
  profile, its own bug timeline. Everything that consumes the `typescript`
  API surface must be re-validated, not assumed.
- The repo consumes TypeScript in four places, all of which must be proven
  together (one branch, one PR — a half-migrated tree checks nothing):

| Consumer                        | Where                                                                                  | What breaks if TS jumps blindly                |
| ------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Frontend typecheck              | `frontend/package.json` `typecheck`/`build` (`tsc --noEmit`), `frontend/tsconfig.json` | New diagnostics may fail the strict build      |
| Electron main/preload typecheck | root `package.json` `lint`/`typecheck` → `tsc -p electron --noEmit`                    | Same                                           |
| Lint stream                     | `frontend/eslint.config.js` → `typescript-eslint` (`tseslint.config`)                  | Hard exit before linting (the #28 failure)     |
| Vitest transform chain          | `vite`/`vitest` consume esbuild/rolldown, and `tsc --noEmit` gates `build`             | Type-level breakage surfaces as build failures |

TS 6.x is the intermediate rung: the ignore comment says "land 6.x first,
then evaluate 7". The same steps below apply, with 6.x substituted and the
`typescript >= 7` range untouched until 6.x is proven.

## Preconditions (check, do not assume)

1. `typescript-eslint` supports TS 7: peer range includes `^7` and no
   "does not support TS 7" guard remains. Check
   `node -e 'console.log(require("typescript-eslint/package.json").peerDependencies)'`
   after a fresh `pnpm install`. If the answer is "no release yet", stop —
   that is the gate for the native path, everything else waits. Route A
   bypasses this gate deliberately (see Unblocking approaches): under A the
   check is the reverse — confirm the lint stream resolves TS 6.0.3, not 7.
2. `@vitejs/plugin-react` and `vite` landed: they are welded into the same
   migration train (PRs #19/#26). If the vitest-4/vite-8 migration has not
   happened, do this one after it, not instead of it.
3. CI is green on main and the working tree is clean.
4. `gh pr list --author app/dependabot --state open` is empty (or you have
   merged what is there) — lockfile churn mid-migration makes the diff
   unreadable.

## Steps

### 1. Branch

```sh
git checkout -b chore/typescript-7
```

### 2. Split the TypeScript manifests (build compiler vs lint-API peer)

Root owns the build compiler; frontend owns the lint-API peer. Two different
majors, on purpose:

```sh
pnpm add -D typescript@^7.0.2        # root: the only build compiler
pnpm --filter frontend add -D typescript@6.0.3   # exact pin — see step 3
```

- Root `typescript@^7.0.2`: both typecheck streams run this one `tsc`
  binary (`tsc -p frontend --noEmit`, `tsc -p electron --noEmit` from the
  root). Frontend must not invoke its own `tsc` bin (it is TS 6), so
  frontend `typecheck`/`build` route through `pnpm -w run
typecheck:frontend`.
- Frontend `typescript@6.0.3`: exists only so `typescript-eslint` resolves
  a supported peer by name. Exact pin — `^6.0.3` would admit 6.1.0, which
  exits typescript-eslint's peer range (`<6.1.0`).

Confirm the shape:

```sh
pnpm why typescript
readlink -f frontend/node_modules/typescript   # must end typescript@6.0.3
readlink -f node_modules/typescript            # must end typescript@7.0.x
# Expected: root devDep 7.0.x (both tsc streams), frontend devDep 6.0.3
# (typescript-eslint peer set __typescript@6.0.3 in the store).
```

### 3. typescript-eslint stays on 8.x — no override

typescript-eslint stays at 8.x for the duration of route A; its TS peer is
supplied by frontend's manifest (step 2), not by override tricks. When
upstream lands TS 7 support (#10940), return frontend's `typescript` to the
build compiler's major and retire the split.

Failure archaeology: the first implementation tried a pnpm selective
override — `"typescript-eslint>typescript": "6.0.3"` plus per-package
selectors for `@typescript-eslint/{parser,eslint-plugin,type-utils,utils}`.
On pnpm 10.34.5 the override rewrote the peer _specs_ (install reported
"unmet peer typescript@6.0.3: found 7.0.2") but never materialized a
6.0.3 peer set: instances kept resolving to the project's direct devDep and
lint still hard-exited on TS 7. The manifest flip in step 2 is the
mechanism. Do not reach for `--legacy-peer-deps`.

### 4. Typecheck — expect the diff to be the work

```sh
pnpm typecheck
```

TS 7 (go rewrite) reports differently. Fix forward; the repo's rules
(STANDARDS.md) do not change because the compiler did: no `any` escapes,
no global lint suppression. If a new diagnostic is arguably a false
positive, decide case by case — targeted suppression with a reason comment
is the last resort, never the default.

### 5. Lint + tests

```sh
pnpm --filter frontend lint
just test-frontend
```

### 6. Build and packaging gate

```sh
pnpm --filter frontend build
node scripts/build-electron.mjs
```

The renderer bundle must be byte-comparable in structure (entry chunk size
in the same ballpark; MuPDF WASM asset emitted — see the wasmFile plugin in
`frontend/vite.config.ts`, docs/PDF.md).

### 7. E2E

```sh
just test-e2e
```

The seeded phase exercises both reader engines end to end; that is the
real proof the toolchain change did not break the runtime.

### 8. Coverage gate (the PR #12 trap)

CI never runs `--coverage`; the gate is silent in the pipeline and only
fails locally / via `just coverage`. Run it:

```sh
just coverage
```

Compare per-category numbers against `docs/COVERAGE.md` baselines. If the
floors fail, first establish whether real coverage regressed or the
instrument changed — the vitest-4 saga (PRs #12, #21) is the case study in
not lowering floors because a measurement layer moved.

### 9. Docs and config in the same change

- `.github/dependabot.yml`: remove the `typescript >= 7` ignore entry and
  its comment block (PR #28 note). Update the comment to record the
  migration date.
- `docs/COVERAGE.md`: refresh the frontend baseline column if numbers
  moved (date + one-line reason in the same change, per its rules).

### 10. Review, merge, verify

Run `pnpm lint`/`pnpm typecheck`/`just test` (the `just check` set) before
pushing. Open the PR referencing this document and PR #28 (the blocked
bump) for context. After merge, Dependabot resumes proposing TS updates;
the first one will be `7.0.x → 7.0.y` — mergeable per the normal group
flow.

## Rollback

Single-manifest revert is not possible (two manifests + lockfile — the
frontend 6.0.3 pin and the root ^7.0.2 build compiler move as one unit).
Roll the branch back (`git revert` the merge or delete it) and re-close
whatever Dependabot PRs the ignore list no longer blocks — the ignore
ranges must never lag the manifests by more than one working session, or
the noise returns.

## Failure archaeology (what previous PRs established)

- #28: typescript-eslint 8.69 + TS 7.0.2 → lint stream exits before
  linting. The gate that fires first.
- #19: vite 8 + vitest 3 → two Vites in the tree, tsc type clash. TS is
  unaffected, but the same one-toolchain-per-tree rule applies: check
  `pnpm why` for duplicates of whatever you just bumped.
- #12/#21: the coverage provider is welded to vitest majors; never let a
  test-runner bump touch coverage independently of the gate.
