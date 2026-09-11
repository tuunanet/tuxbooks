# TypeScript 7 upgrade — step-by-step handover

Status as of 2026-09-10: **blocked, by design**. The `typescript >= 7` ignore
in `.github/dependabot.yml` (PR #28) is the parking brake; this document is
the release procedure for taking it off. TS 7 is the typescript-go rewrite —
a different compiler, not a normal major — so this is a staged migration, not
a version bump.

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
   that is the gate, everything else waits.
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

### 2. Bump the two TypeScript manifests

`frontend/package.json` and root `package.json` both pin `typescript` —
they must move together (root `tsc -p electron` and frontend `tsc` must be
the same compiler):

```sh
pnpm --filter frontend add -D typescript@^7.0.2
pnpm add -D typescript@^7.0.2
```

Confirm the tree resolves to a single TS:

```sh
pnpm why typescript   # or: find node_modules/.pnpm -maxdepth 1 -name "typescript@*"
```

### 3. Upgrade typescript-eslint to a TS-7-compatible release

Bump `typescript-eslint` (frontend) to the first version whose peer range
admits `^7`:

```sh
pnpm --filter frontend add -D typescript-eslint@latest
```

If the peer range still excludes 7 → the ecosystem is not ready; abort,
record the blocker on this doc, and reschedule. Do not force with
`--legacy-peer-deps` or a pnpm override: the lint stream is the component
that _hard-exits_ on mismatch.

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
`frontend/vite.config.ts`, docs/pdf.md).

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

Compare per-category numbers against `docs/coverage.md` baselines. If the
floors fail, first establish whether real coverage regressed or the
instrument changed — the vitest-4 saga (PRs #12, #21) is the case study in
not lowering floors because a measurement layer moved.

### 9. Docs and config in the same change

- `.github/dependabot.yml`: remove the `typescript >= 7` ignore entry and
  its comment block (PR #28 note). Update the comment to record the
  migration date.
- `docs/coverage.md`: refresh the frontend baseline column if numbers
  moved (date + one-line reason in the same change, per its rules).

### 10. Review, merge, verify

Run `pnpm lint`/`pnpm typecheck`/`just test` (the `just check` set) before
pushing. Open the PR referencing this document and PR #28 (the blocked
bump) for context. After merge, Dependabot resumes proposing TS updates;
the first one will be `7.0.x → 7.0.y` — mergeable per the normal group
flow.

## Rollback

Single-manifest revert is not possible (two manifests + lockfile). Roll the
branch back (`git revert` the merge or delete it) and re-close whatever
Dependabot PRs the ignore list no longer blocks — the ignore ranges must
never lag the manifests by more than one working session, or the noise
returns.

## Failure archaeology (what previous PRs established)

- #28: typescript-eslint 8.69 + TS 7.0.2 → lint stream exits before
  linting. The gate that fires first.
- #19: vite 8 + vitest 3 → two Vites in the tree, tsc type clash. TS is
  unaffected, but the same one-toolchain-per-tree rule applies: check
  `pnpm why` for duplicates of whatever you just bumped.
- #12/#21: the coverage provider is welded to vitest majors; never let a
  test-runner bump touch coverage independently of the gate.
