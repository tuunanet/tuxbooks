# Release and distribution

TuxBooks ships as native Linux packages built by CI from immutable `v*`
tags. This doc is the operating manual: what the artifacts are, how a
release is cut, and what is deliberately deferred.

**Migration state:** branch `web-reader-prototype-1` replaces the Tauri
bundler with an Electron packaging path (electron-builder or equivalent —
decide at migration phase 1 and record it here). The artifact set and the
packaging-gate philosophy are unchanged; the build internals below update
as phases land.

## Artifacts

| Artifact                            | Built by               | Purpose                                                            |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `tuxbooks_<version>_amd64.deb`      | release workflow (tag) | Primary target: Ubuntu/Debian install via `sudo apt install ./…`   |
| `tuxbooks_<version>_amd64.AppImage` | release workflow (tag) | Portable single-file build for other Linux setups, no installation |
| `SHA256SUMS.txt`                    | release workflow (tag) | Checksums for both artifacts                                       |
| deb + rpm                           | `just build` (local)   | Local packaging verification; rpm is not published                 |

Every deb ships the desktop entry (`usr/share/applications/tuxbooks.desktop`),
hicolor icons, the Electron runtime, and the bundled sidecar binary plus
PDFium resource. Releases are marked pre-release until 1.0, and the site
links to the releases list (not `/releases/latest`, which ignores
pre-releases).

## The packaging gate

`just package-check` builds the deb and runs `scripts/check-deb.sh`, which
verifies control metadata (package name, exact version match, description),
extracts the payload and checks the Electron binary + sidecar + PDFium
resource, desktop entry (structure plus `desktop-file-validate` when
installed), and hicolor icons. CI's build job runs the same script after
bundling; `just ci` includes it. A packaging regression fails the build
like any other test. The Electron path must not reintroduce a webkit2gtk
runtime dependency.

## Cutting a release

Per the versioning policy in ROADMAP.md (pre-1.0: patch bumps for early
releases, `0.y.0` for milestone-scale points, `1.0.0` at exit criteria):

1. Bump the version in **one normal commit on main**: the packaging
   manifest(s) (electron-builder config replacing `tauri.conf.json` as the
   source of truth), the Rust crate's `Cargo.toml`/`Cargo.lock`,
   `package.json`, `frontend/package.json`, and the homepage version badge
   in `site/index.html` when the headline version changes.
2. Let CI go green on that commit.
3. Tag it: `git tag -a vX.Y.Z && git push origin vX.Y.Z`. Never move or
   reuse a tag — a bad build is fixed in the next version.
4. The release workflow then runs two jobs:
   - **verify** — Rust + frontend unit/integration tests and the headless
     real-binary E2E suites (same gates as `just ci`), so a tag never
     publishes what has not been proven;
   - **publish** — refuses to run unless the tag exactly matches the
     version in the packaging manifest, builds deb + AppImage, writes
     `SHA256SUMS.txt`, and publishes a pre-release with install
     instructions.

## AppImage specifics

Electron AppImages bundle the whole runtime (Electron + Chromium + Node);
the linuxdeploy GTK plugin of the Tauri era is not needed. Build with the
standard electron-builder AppImage target with `APPIMAGE_EXTRACT_AND_RUN=1`
so no FUSE is required at build time (users need FUSE or an extract-run
environment only to _execute_ the AppImage).

## Deliberate deferrals

- **Signed artifacts:** `SHA256SUMS.txt` only. GPG/(sigstore) signing waits
  until there is key infrastructure and a distribution channel that
  consumes it; checksums over HTTPS from the GitHub release are the
  pre-1.0 baseline.
- **Update strategy:** none built. deb installs upgrade in place via `apt`
  (same package name and identifier), AppImage is replaced by downloading
  the newer file. If auto-update is ever required, that is
  `electron-updater` with signed manifests — a later decision (ROADMAP:
  "update strategy if later required").
- **Flatpak/Snap:** not planned; Ubuntu audience is served by deb +
  AppImage.
