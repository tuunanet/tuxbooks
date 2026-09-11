# Coverage badge — adoption plan

Goal: a README coverage badge that is honest (driven by the real gate, not a
hand-edited number) and never stale. Today the repo has a hard coverage gate
that CI never exercises; the badge is the excuse to fix that, not the other
way around.

## Current state (verified 2026-09-11)

- Floors live in `frontend/vite.config.ts` (`coverage.thresholds`, per
  category) and `scripts/coverage-gate.mjs` (Rust, via `just coverage`).
  Vitest already fails any run below a floor — the gate is loud wherever it
  runs.
- CI does not run coverage (`docs/migrations/typescript-7.md` step 8, the
  "PR #12 trap"): the gate is silent in the pipeline, checked only locally.
- `just coverage` produces **no machine-readable artifact** — the recipe
  passes only `--coverage.reporter=text-summary`. The
  `frontend/coverage/coverage-summary.json` path that `docs/coverage.md`
  points at does not exist after a run (verified: `find` returns nothing).
  Anything badge-shaped needs a JSON reporter first.
- The instrument is welded to vitest majors (PRs #12/#21): any vitest bump
  can change attribution and must move with the thresholds/gate in one
  change.

## Decision: self-published endpoint badge (no third-party service)

| Option                                                            | Pros                                                                                                                                  | Cons                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **CI → JSON on a `badges` branch → shields.io endpoint (chosen)** | No external account, no secrets, no SaaS dependency; numbers computed by our own script, so the badge and the gate can never disagree | We build the per-category aggregation ourselves (~50 lines)                                                     |
| Codecov                                                           | Recruiter-recognizable logo, per-file drill-down UI, combines Rust + frontend                                                         | Third-party service + `CODECOV_TOKEN` secret; numbers live outside the repo; another vendor account to maintain |

Start with the self-hosted endpoint. If a drill-down UI is ever wanted
(interviews, debugging), switch to Codecov in phase 4 — the CI job and JSON
from phase 1 survive either choice.

## What the badge shows

The gate's number, not a vanity number: **the worst per-category lines
coverage** (e.g. `coverage: 91% · min cat 88%`), computed from
`coverage-summary.json` grouped by the same globs as
`frontend/vite.config.ts` thresholds. Overall totals go in the JSON for the
tooltip. If any category ever dips below its floor, the CI job fails before
publishing — the badge only ever shows numbers from green runs.

## Changes

1. **`scripts/coverage-badge.mjs`** (new): reads
   `frontend/coverage/coverage-summary.json`, groups by the threshold globs
   (duplicated list is acceptable; add a test-able pure function), emits
   `coverage.json` for shields:

   ```json
   {
     "schemaVersion": 1,
     "label": "coverage",
     "message": "88% (min cat) · 94% overall",
     "color": "brightgreen",
     "maxAge": 86400
   }
   ```

2. **`.github/workflows/ci.yml`**: new `coverage` job (frontend) on `main`
   pushes: `vitest run --coverage --coverage.reporter=json-summary
--coverage.reporter=text-summary` → run the script → push
   `coverage.json` to the `badges` branch (`permissions: contents: write`,
   main-pushes only — no PR thrash). Requires the job initially; make it
   required in branch protection once stable for a week.
3. **`README.md`**: shield endpoint badge —
   `https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/tuunanet/tuxbooks/badges/coverage.json`
4. **`docs/coverage.md`**: "Badge" section — data source, refresh cadence
   (every main push; shields caches per `maxAge`), and the rule that the
   badge shows worst-category, never overall alone.
5. **`justfile`**: extend the `coverage` recipe to also emit the JSON
   reporter locally, so local and CI artifacts are identical.

## Rules this plan inherits

- **The weld rule (PR #12/#21):** a vitest/coverage-provider bump changes
  the instrument, therefore lands in the same change as any needed
  `coverage-badge.mjs`/threshold adjustments and a fresh baseline column in
  `docs/coverage.md`. The badge pipeline must never be the thing that
  quietly keeps working across an instrument change.
- **Floors are the gate:** the badge adds visibility, not a new gate and
  not a floor change. `docs/coverage.md` tables stay authoritative.

## Rust: deliberately out of the v1 badge

`cargo-llvm-cov` pays a full rebuild in its own target dir — too expensive
for every push (the reason `just coverage` is not in `just check`). Options
for later: a weekly scheduled job publishing a second badge, or the Codecov
route where one upload combines both languages. Decide when the frontend
badge has been stable for a few weeks; do not bundle it into phase 1.

## Phases

Status 2026-09-11: phases 1–2 implemented in one branch — `coverage` CI job
(artifact + badges-branch publish on main, non-required check), badge in the
README after the CodeFactor grade, `just coverage` emits the JSON artifact
locally too. Verified locally before wiring: json-summary reporter
materializes `coverage-summary.json`; badge generator outputs
`80% (min cat Hooks) · 94% overall` on the 2026-09-11 tree. Remaining:
phase-3 one-week watch, then flip the job to required in branch protection
(owner settings action), and optionally phase 4 (Rust weekly job or Codecov).

1. **CI runs the gate (half a session).** `coverage` job with JSON +
   text reporters, floors enforced by existing thresholds, artifact
   uploaded. Non-required check at first to observe variance.
2. **Publish + badge (half a session).** `coverage-badge.mjs`, `badges`
   branch push on main, README badge, docs. Make the job required.
3. **Observe (one week).** Confirm the badge tracks main, no
   false-red from timing variance in v8 counts, cache behaves.
4. **Optional: Rust weekly job** (`schedule:` cron) publishing a second
   badge, or the Codecov switch if drill-down is wanted.

## Risks

- **New CI failure surface:** the silent gate becomes loud; a flaky test
  under instrumentation can now block CI. Mitigation: non-required for
  phase 1, required only after a clean week.
- **Instrument drift (PR #12 class):** mitigated by the weld rule above.
- **Badge/cache staleness:** `maxAge` + push-on-main keeps it within a day;
  the alternative (static badge) is forbidden — a hand-edited badge is the
  dishonest-badge failure mode.
- **CI minutes:** frontend coverage measured ~15 s on this machine; Rust
  excluded for cost until the scheduled-job phase.

## Out of scope

Floor changes; covering the "outside the gate" list in `docs/coverage.md`;
any third-party service in phases 1–3; per-category badges in the README
(one number, worst category).
