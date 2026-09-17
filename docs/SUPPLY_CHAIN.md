# Supply chain

Controls for the dependency set and releases (issue #89, invariants
S-1..S-5 under #78). The mechanisms are deliberately boring: pnpm audit,
cargo-audit, Dependabot, and the existing release pipeline, with gates so
they run on every change and every week instead of once.

## Gates

| Gate               | Where it runs                                      | What it enforces                                                       |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------------------------- |
| npm audit gate     | `just audit`, `.github/workflows/audit.yml`        | No untriaged high/critical npm advisory (`scripts/npm-audit-gate.mjs`) |
| RustSec audit gate | `just audit`, `.github/workflows/audit.yml`        | No untriaged `cargo audit` finding on either lockfile                  |
| Supply-chain gate  | `just check`, `just check-supply-chain`, audit.yml | Offline wiring checks (below)                                          |
| SBOM               | `just sbom`, release workflow                      | CycloneDX inventory published with every release                       |

The offline gate (`scripts/supply-chain-gate.mjs`) asserts what the
networked audits cannot see: the maturity floor stays configured (S-5),
build-script allowlists are unchanged (S-3), the audit workflow exists with
its schedule (S-2), the release workflow builds and uploads the SBOM (S-4),
and the fuzz workflow's nightly toolchain is date-pinned.

Both gate scripts carry offline self-tests (`scripts/npm-audit-gate.mjs
--self-test`, `scripts/supply-chain-gate.mjs --self-test`): the npm gate
exercises the fail-on-vulnerable decision and the audit report shape
guard, the supply-chain gate exercises the workspace parsing, and both
suites also run inside `just check`.

## S-1: high-risk dependencies stay current

Continuously audited means three layers: the weekly Audit workflow sweep
(advisories published against an unchanged tree are caught), Dependabot's
weekly npm and GitHub-Actions update PRs, and `just audit` before releases.

Locked versions of the high-risk set at the time of the last review
(2026-09-16, this task):

| Dependency         | Locked        | Latest stable | Status                                                        |
| ------------------ | ------------- | ------------- | ------------------------------------------------------------- |
| electron           | 44.2.0        | 44.4.1        | Latest major, in-support line; patch delta rides Dependabot   |
| mupdf              | 1.28.1        | 1.28.1        | Current                                                       |
| @readium/navigator | 2.8.2         | 2.10.1        | No advisories; minors tracked via Dependabot                  |
| @readium/shared    | 2.4.0         | 2.5.1         | No advisories; minors tracked via Dependabot                  |
| @readium/css       | 2.0.5         | 2.0.5         | Current                                                       |
| lopdf              | 0.44.0        | 0.45.0        | No advisories; minor delta tracked                            |
| zip                | 2.4.2         | 8.6.0         | No advisories; majors tracked deliberately (see below)        |
| quick-xml          | 0.41.0        | 0.41.0/0.42.0 | Upgraded from 0.37.5 this task (RUSTSEC-2026-0194/0195, high) |
| image              | 0.25.10       | 0.25.10       | Current                                                       |
| pdfium-render      | 0.9.3         | 0.9.4         | No advisories; patch delta tracked                            |
| PDFium binaries    | chromium/7881 | —             | Pinned in `scripts/fetch-pdfium.sh` (`PDFIUM_BUILD`)          |

Upgrade policy: take security fixes as the smallest viable upgrade that
clears the advisory, run the full test suite, and never batch unrelated
bumps into a security change (a wide upgrade is its own release risk).
Functional minors/majors behind the pinned reader packages (Readium,
zip) ride Dependabot PRs and are reviewed when they arrive, not pulled
early — their APIs feed the reader seams in docs/EPUB.md and docs/PDF.md.

## S-2: audit tooling and triage

Both gates block CI; a finding only passes when it carries a triage entry
with a reason and a revisit date.

- npm: add an entry to `TRIAGE` in `scripts/npm-audit-gate.mjs` (matched by
  advisory id or package name, dated). High/critical block; moderate/low
  are printed for the review cadence and do not block.
- Rust: add the RUSTSEC id to `ignore` in `sidecar/.cargo/audit.toml`,
  dated, with the reachability rationale. The gate runs against both the
  sidecar lockfile and the fuzz crate's lockfile.

Current triage:

| Finding                                                                                                                        | Severity | Blocked? | Resolution                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RUSTSEC-2026-0194/0195 (quick-xml quadratic runtime, unbounded namespace allocation — both in the hostile EPUB/XML parse path) | high     | yes      | Fixed by upgrading quick-xml 0.37.5 -> 0.41.0 (2026-09-16, this task)                                                                                                                                                    |
| RUSTSEC-2023-0071 (rsa, Marvin key-recovery side channel)                                                                      | medium   | no       | Ignored in `sidecar/.cargo/audit.toml`: `rsa` enters the lockfile only as an optional dependency of sqlx-mysql, which is never compiled (sqlite-only build), and no fixed release exists. Revisit when the tree changes. |

## S-3: build/install scripts

pnpm 10 refuses dependency lifecycle scripts by default. The reviewed sets
live in `pnpm-workspace.yaml` and are asserted by the offline gate:

- Allowed to run (`onlyBuiltDependencies`): `esbuild` (platform binary),
  `electron` (runtime download). The root `package.json` `postinstall`
  hook is first-party code that re-runs electron's installer.
- Reviewed and ignored: `electron-winstaller` (transitive of
  electron-builder; its script is not needed for the Linux targets).

A new package with an install script shows up in `pnpm ignored-builds`
and fails `just check` until it is reviewed into one of the two lists.

## S-4: SBOM

`just sbom` (`scripts/generate-sbom.mjs`) writes a CycloneDX 1.5 JSON over
the npm tree (`pnpm -r list`, prod + dev: build-time packages are part of
the supply chain) and the sidecar's normal Rust dependency graph. The
release workflow generates it during `publish`, covers it with
`SHA256SUMS.txt`, and uploads it to the GitHub release next to the
installers (docs/RELEASE.md). The fuzz crate is local tooling and is not
inventoried.

## S-5: dependency maturity period

Decision: **adopted** (2026-09-11, recorded in `.github/dependabot.yml`
and `pnpm-workspace.yaml`). No JS dependency — direct or transitive —
younger than 30 days may enter the tree:

- `minimumReleaseAge: 43200` in `pnpm-workspace.yaml` gates `pnpm
install`/`update` (verified: `ERR_PNPM_NO_MATURE_MATCHING_VERSION`).
- Dependabot's `cooldown: default-days: 30` gates update PRs, including
  the GitHub-Actions bumps (moved-tag attacks ride the same floor).

Rationale: a fresh release gets 30 days of community exposure before it
can land here (the Shai-Hulud pattern), while Dependabot security updates
still bypass the cooldown so patched releases are not delayed. The urgent
path is `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`: exact
`name@version` pins, only for patched releases of already-vulnerable
packages, each with a dated comment, removed once the versions age out.
