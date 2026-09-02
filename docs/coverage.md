# Coverage gate

Every category in the table below must stay at or above its required line
coverage. When a category falls below its floor, the fix is more tests, not
a lower floor — thresholds are changed only case by case, with the reason
recorded in the same change as the table row.

Frontend floors are enforced by **every vitest run** (`coverage.thresholds`
in `frontend/vite.config.ts` — the run fails when any category drops below
its floor). Rust floors are enforced by `just coverage`
(`scripts/coverage-gate.mjs`); it is not part of `just check` because the
instrumented build pays a full rebuild in its own target dir — run it when
touching a Rust module's behavior or tests.

## Required coverage by category

| Category            | Scope                                         | Required | Baseline (2026-09-02) |
| ------------------- | --------------------------------------------- | -------- | --------------------- |
| EPUB parser         | `src-tauri/src/epub/`                         | 80%      | 94.2%                 |
| PDF parser          | `src-tauri/src/pdf/`                          | 80%      | 99.4%                 |
| Services            | `src-tauri/src/services/`                     | 80%      | 98.5%                 |
| Repository          | `src-tauri/src/repository/`                   | 80%      | 96.5%                 |
| Database            | `src-tauri/src/db/`                           | 80%      | 97.0%                 |
| Domain models       | `src-tauri/src/domain/`                       | 80%      | 100.0%                |
| Library view        | `frontend/src/components/library/`            | 80%      | 98.6%                 |
| Book cards/detail   | `frontend/src/components/books/`              | 80%      | 96.9%                 |
| Reader (EPUB + PDF) | `frontend/src/components/reader/`             | 80%      | 95.0%                 |
| Search              | `frontend/src/components/search/`             | 80%      | 98.3%                 |
| Collections         | `frontend/src/components/collections/`        | 80%      | 100.0%                |
| Settings            | `frontend/src/components/settings/`           | 80%      | 100.0%                |
| App shell           | `frontend/src/components/layout/` + `App.tsx` | 80%      | 94.4%                 |
| State providers     | `frontend/src/state/`                         | 80%      | 95.5%                 |
| Hooks               | `frontend/src/hooks/`                         | 80%      | 94.8%                 |
| Frontend lib        | `frontend/src/lib/`                           | 80%      | 91.3%                 |

Baselines are a snapshot, not a promise: the gate is the Required column.
Numbers drift as code changes; rerun `just coverage` for current values
(frontend per-category percentages: `coverage/coverage-summary.json` under
`frontend/`; Rust: `target/llvm-cov/coverage.json`).

## Outside the gate (and why)

| What                                                     | Why it is excluded                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/commands/`                                | IPC boundary — no business logic by contract (docs/architecture.md); every path is driven through the real app by the E2E suite. |
| `src-tauri/src/lib.rs`                                   | Wiring (pool init, state, command registration) — boots in every E2E run.                                                        |
| `src-tauri/src/error.rs`                                 | thiserror-derived Display/From code.                                                                                             |
| `src-tauri/src/main.rs`, `frontend/src/main.tsx`         | Entry points.                                                                                                                    |
| `src/lib/epub/epubEngine.ts`, `src/lib/pdf/pdfEngine.ts` | Engine seams — thin wrappers around vendored engines; real behavior covered by the E2E reader suites, unit tests mock the seam.  |
| `src/lib/epub/foliate-js/`                               | Vendored upstream submodule.                                                                                                     |
| `frontend/src/components/ui/`                            | shadcn/ui primitives — vendored scaffolding, not app logic.                                                                      |
| `frontend/src/lib/fixtures.ts`                           | Sample data for tests/previews.                                                                                                  |
| `frontend/src/types/`                                    | Pure type declarations, no runtime code.                                                                                         |

Adding a new feature area: add its glob/module to the gate tables
(`frontend/vite.config.ts` and `scripts/coverage-gate.mjs`) and a row here
in the same change, at the 80% default. When a category needs a different
floor (e.g. parser edge-case branches are expensive to hit), change it in
the config and update the row with a one-line reason.
