# Release and distribution

TuxBooks ships as native Linux packages built by CI from immutable `v*`
tags. This doc is the operating manual: what the artifacts are, how a
release is cut, and what is deliberately deferred.

**Packaging:** Electron packaging uses `electron-builder`
(`electron-builder.yml`). The artifact set and packaging-gate philosophy
are unchanged from the earlier releases.

## Artifacts

| Artifact                       | Built by               | Purpose                                                            |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `tuxbooks_<version>_amd64.deb` | release workflow (tag) | Primary target: Ubuntu/Debian install via `sudo apt install ./…`   |
| `tuxbooks-<version>.AppImage`  | release workflow (tag) | Portable single-file build for other Linux setups, no installation |
| `SHA256SUMS.txt`               | release workflow (tag) | Checksums for both artifacts                                       |
| deb + rpm + AppImage           | `just package` (local) | Local packaging verification; rpm is not published                 |

Every deb ships the desktop entry (`usr/share/applications/tuxbooks.desktop`),
hicolor icons, the Electron runtime, and the bundled sidecar binary plus
PDFium resource. Releases are marked pre-release until 1.0, and the site
links to the releases list (not `/releases/latest`, which ignores
pre-releases).

### Desktop identity (branding vs technical identifiers)

Human-facing identity is **TuxBooks** everywhere it is displayed: the
electron-builder `productName` (package metadata, desktop-entry `Name`),
the native window title, and the sidebar heading. Technical identifiers
stay the stable `tuxbooks` and must not be renamed casually — they anchor
install paths, persisted data, protocol registration, and upgrade
behavior:

| Identifier                                | Where                               |
| ----------------------------------------- | ----------------------------------- |
| `com.tuxbooks.app`                        | appId, data dir under XDG data home |
| `tuxbooks` (executable, `executableName`) | `/opt/TuxBooks/tuxbooks`, WM class  |
| `tuxbooks.desktop` / `Icon=tuxbooks`      | desktop entry, hicolor icons        |
| `tuxbooks://`                             | resource protocol                   |

The install dir follows `productName` (`/opt/TuxBooks`); the executable
name inside it stays `tuxbooks`. The native window/taskbar icon is decoded
from the canonical `build/icons/` set at runtime (`appIcon()` in
`electron/main/index.ts`; extraResources copies it to `resources/icons`
in packaged builds). Modern Chromium no longer writes the legacy X11
`_NET_WM_ICON` property (verified empty on dev + packaged, with a decoded
image), so launcher/taskbar icon identity flows through the desktop entry
(`Icon=tuxbooks` + `StartupWMClass=tuxbooks`) — which is what the
packaging gate asserts.

## The packaging gate

`scripts/check-deb.sh` is the packaging gate: it verifies the built deb's
control metadata (package name, exact version match, description, and no
webkit dependency), the extracted payload (Electron binary + executable
sidecar + PDFium resource + the runtime window icon), the desktop entry
(structure, `Name=TuxBooks`, `Icon=tuxbooks`, plus `desktop-file-validate`
when installed), and hicolor icons. CI builds the deb target and runs the
gate on every push; the release workflow builds the published deb +
AppImage and runs the same gate before publishing.

## Cutting a release

Per the versioning policy in ROADMAP.md (pre-1.0: patch bumps for early
releases, `0.y.0` for milestone-scale points, `1.0.0` at exit criteria):

1. Bump the version in **one normal commit on main**: root `package.json`
   (the electron-builder source of truth), the Rust crate's
   `Cargo.toml`/`Cargo.lock`, `frontend/package.json`, and the homepage
   version badge in `site/index.html` when the headline version changes.
2. Let CI go green on that commit.
3. Tag it: `git tag -a vX.Y.Z && git push origin vX.Y.Z`. Never move or
   reuse a tag — a bad build is fixed in the next version.
4. The release workflow then runs two jobs:
   - **verify** — Rust + frontend unit/integration tests and the headless
     real-binary E2E suites (`just test`, `just test-e2e`), so a tag never
     publishes what has not been proven;
   - **publish** — refuses to run unless the tag exactly matches the
     version in the packaging manifest, builds deb + AppImage, writes
     `SHA256SUMS.txt`, and publishes a pre-release with install
     instructions.

## AppImage specifics

Electron AppImages bundle the whole runtime (Electron + Chromium + Node).
electron-builder creates them without FUSE; users need FUSE or an
extract-run environment only to _execute_ the AppImage.
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
