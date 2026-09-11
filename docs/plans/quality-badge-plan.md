# Code-quality badge plan (CodeFactor)

Companion to `docs/plans/coverage-badge-plan.md`. Answers: which third-party
quality badge for a free OSS project — and how to adopt it without giving a
vendor authority over our own gates.

## Decision (2026-09-11, vendor state verified live)

| Service        | Status verified                                                                                   | Languages                                               | Free OSS                       | Verdict                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CodeFactor** | Alive (© 2026, active analysis feed)                                                              | TS/JS (ESLint, Oxlint) **+ Rust (Clippy)** + 20 more    | Yes, public repos              | **Chosen** — only one that grades the whole repo                                                                                                                        |
| DeepScan       | Alive (© 2026), free for open source (unlimited public projects)                                  | JS/TS only                                              | Yes                            | Runner-up: React/TS specialist, but frontend-only — blind to the Rust sidecar, and its React rules largely duplicate our strict `typescript-eslint` + react-hooks setup |
| Code Climate   | **Gone as such** — `codeclimate.com/quality` now serves **Qlty** (qlty.sh), its successor product | Qlty: 70+ linters incl. clippy/eslint, + coverage cloud | Qlty CLI free; cloud free tier | Not one of the original three anymore; strongest _tool_ of the bunch, but adopting a new platform + CLI for a badge is heavier than CodeFactor's zero-config GitHub App |

Why CodeFactor wins for _this_ repo: one badge covering both halves
(ESLint/Oxlint for `frontend/` + `electron/`, Clippy for `sidecar/`), free
for public repos, GitHub-App onboarding with no CI changes and no secrets,
and the A-grade badge is a recognized recruiter signal. Its grade must
never become a merge gate — `just check` (clippy `-D warnings`, ESLint,
typecheck) stays the only authority; CodeFactor is informational optics on
top of tools we already run strictly.

## Scope

- Analyzed: `frontend/src/**`, `electron/**`, `e2e/**` (our TypeScript).
- Excluded (`.codefactor.yml`): vendored/scaffolding paths that would
  distort a grade meant to reflect _our_ code:

  ```yaml
  exclude_paths:
    - "frontend/src/lib/epub/foliate-js/**" # pinned upstream submodule
    - "frontend/src/components/ui/**" # shadcn/ui vendored primitives
    - "docs/**"
    - "**/dist/**"
  ```

  Same exclusion philosophy as `docs/coverage.md` ("outside the gate").

- Rust: expect Clippy findings in `sidecar/`; our clippy already runs
  `-D warnings`, so the delta should be near zero — verify during
  onboarding and fix forward, never configure around it.

## Phases

1. **Onboard (no badge yet).** Log in via GitHub, enable
   `tuunanet/tuxbooks`, let the first analysis run, add the exclusion file,
   re-analyze. Read every finding that isn't in an excluded path: fix real
   ones forward (repo rules unchanged — no `any` escapes, no suppressions),
   dismiss vendor false-positives on the dashboard with a note.
2. **Gate the badge on an honest grade.** Badge goes live when the grade is
   stable at **A− or better**. If the grade stalls below that, the fix is
   code, not the tool — and if it can't reach A− for structural reasons,
   record why here and skip the badge (a B badge is honest; a suppressed
   grade is not).
3. **Badge.** Add to the README row next to CI/Release/License/Platform
   (PR #35 branch):
   `https://www.codefactor.io/repository/github/tuunanet/tuxbooks/badge`
4. **Observe (two weeks).** Confirm analysis tracks main, no grade churn
   from vendored churn or tool-version drift.

## Risks and exit criteria

- **Vendor risk (why the date above matters):** the 2026 sweep found one of
  the three candidates already replaced (Code Climate → Qlty). Exit
  criterion: if CodeFactor degrades, paywalls OSS, or dies, remove the
  badge — no code, CI, or gate depends on it, by design. Nothing in the
  repo may ever call CodeFactor load-bearing.
- **Grade noise vs. our own gates:** our linters are the authority; a
  CodeFactor/ESLint version skew is a dashboard problem, never a CI
  problem. Status checks from CodeFactor stay non-required.
- **Duplication checker:** biggest false-positive risk on app code; handle
  case by case (extract a helper if it's real, dismiss with a note if it
  isn't). Vendored duplication is already excluded.
- **Privacy:** public repo, read-only analysis — no secrets shared.

## Out of scope

Making any external grade a merge gate; DeepScan as a second badge; Qlty
adoption (revisit only if we want vendor-hosted multi-language coverage —
it would compete with the self-hosted badge in `docs/plans/coverage-badge-plan.md`,
which stays the plan of record for coverage).
