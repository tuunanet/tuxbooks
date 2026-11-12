# Release and distribution

TuxBooks ships as native Linux packages built by CI from immutable `v*`
tags. This doc is the operating manual: what the artifacts are, how a
release is cut, and what is deliberately deferred.

**Packaging:** Electron packaging uses `electron-builder`
(`electron-builder.yml`). The deb/rpm/pacman/AppImage artifact set and the
packaging-gate philosophy carry over from the earlier releases.

## Artifacts

| Artifact                                  | Built by               | Purpose                                                                              |
| ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `tuxbooks_<version>_amd64.deb`            | release workflow (tag) | Primary target: Ubuntu/Debian install via `sudo apt install ./…`                     |
| `tuxbooks-<version>-1-x86_64.pkg.tar.zst` | release workflow (tag) | Arch/Manjaro install via `sudo pacman -U ./…`                                        |
| `tuxbooks-<version>.AppImage`             | release workflow (tag) | Portable single-file build for other Linux setups, no installation, no host libfuse2 |
| `SBOM-tuxbooks-<version>.cdx.json`        | release workflow (tag) | CycloneDX dependency inventory (issue #89, S-4), docs/SUPPLY_CHAIN.md                |
| `SHA256SUMS.txt`                          | release workflow (tag) | Checksums for the installers and the SBOM                                            |
| deb + rpm + pacman + AppImage             | `just package` (local) | Local packaging verification; rpm is not published                                   |

Every package ships the desktop entry
(`usr/share/applications/tuxbooks.desktop`), hicolor icons, the Electron
runtime, and the bundled sidecar binary plus
document worker (`resources/sidecar/tuxbooks-worker`) plus PDFium resource.
`scripts/check-deb.sh` and `scripts/check-pacman.sh` gate the worker's
presence. Releases are published as
normal releases, not pre-release, and the site links to the latest release at
`/releases/latest`. The version stays below 1.0 while the app is in active
development; that is a version number, not a release flag.

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

## Packaging and the hardening checks

The packaged app is covered by two checks beyond the packaging gates
(issue #85, X-1..X-5):

- The boot probe doubles as the packaged hardening smoke: run the
  `dist-packages/linux-unpacked/tuxbooks` binary (or the installed deb)
  with `TUXBOOKS_BOOT_PROBE=1` and scratch `TEST_DATABASE_PATH` /
  `TEST_LIBRARY_PATH` overrides. A healthy run prints
  `[boot] renderer mounted` and the `tuxbooks://` probe results.
- The renderer-isolation flags, the app UI CSP, the deny-by-default
  permission handlers, the navigation allowlist, and the external-link
  seam all ship in `app.asar`; the security E2E phase proves them live on
  the same `app://bundle` load path the packaged app uses.

## The packaging gate

`scripts/check-deb.sh` verifies the built deb's control metadata (package
name, exact version match, description, and no webkit dependency), the
extracted payload (Electron binary + executable sidecar + PDFium resource +
the runtime window icon), the glibc ABI floor for the sidecar and worker
(<= 2.35; docs/BUILD.md "Release sidecar ABI floor"), the desktop entry
(structure, `Name=TuxBooks`, `Icon=tuxbooks`, plus `desktop-file-validate`
when installed), and hicolor icons.

`scripts/check-pacman.sh` verifies the Arch package's `.PKGINFO` (name,
version, `x86_64`, license, and non-empty description and packager), the
required dependency entries (and that the stale
`http-parser`/`libappindicator-gtk3` defaults are gone), the extracted
payload (Electron binary + executable sidecar and worker + PDFium + window
icon), the same glibc 2.35 floor, and the desktop entry and hicolor icons.
It reads the `.pkg.tar.zst` with `bsdtar`; install `libarchive-tools` on
Debian/Ubuntu.

`scripts/check-pacman-arch.sh` resolves the package's dependency transaction
inside a current `archlinux` container (`pacman -Sy`, then `pacman -U
--print`). The host-side gate checks what the metadata says; this one checks
that Arch can still satisfy it, so a dependency Arch has dropped fails the
build instead of a user's install. It needs docker or podman.

`scripts/check-appimage.sh` verifies the AppImage's embedded runtime and
payload (see "AppImage specifics" below).

CI builds the deb, pacman and AppImage targets and runs the packaging gates
on every packaging-relevant push; the release workflow builds the published
artifacts and runs the same gates before publishing.

## Cutting a release

Per the versioning policy in ROADMAP.md (pre-1.0: patch bumps for early
releases, `0.y.0` for milestone-scale points, `1.0.0` at exit criteria):

1. Bump the version in **one normal commit on main**: root `package.json`
   (the electron-builder source of truth), the Rust crate's
   `Cargo.toml`/`Cargo.lock`, `frontend/package.json`, and the homepage
   version badge in `site/index.html` when the headline version changes.
2. Draft the release notes with `just release-notes X.Y.Z`: the script
   writes `docs/release-notes/vX.Y.Z.md`, grouping the user-facing
   commits since the previous tag into **New** (`feat`), **Changed**
   (`refactor`, `perf`), and **Fixed** (`fix`) sections, plus the install
   instructions and the full-changelog link. Write the one-sentence
   summary, polish the bullets, add anything the draft missed (a security
   dependency bump, docs worth pointing at), and commit the file with the
   version bump. The release workflow publishes exactly this file and
   fails the release when it is missing, so the section shape never
   depends on memory.
3. Let CI go green on that commit.
4. Tag it: `git tag -a vX.Y.Z && git push origin vX.Y.Z`. The tag must
   point at a commit on main. Never move or reuse a tag; a bad build is
   fixed in the next version.
5. The release workflow then runs two jobs:
   - **verify** refuses a tag whose commit is not an ancestor of main, then
     runs the headless real-binary E2E suites (`just test-e2e`). That is the
     part a commit's CI run does not cover; its unit and integration suites
     were already green there, so a tag never publishes what has not been
     proven.
   - **publish** waits for approval of the `release` environment, which only
     accepts `v*` tags, then refuses to run unless the tag exactly matches
     the version in the packaging manifest and the committed notes file
     exists. It builds deb + pacman + AppImage, generates the SBOM
     (`just sbom`), writes `SHA256SUMS.txt` over the installers and the SBOM,
     and publishes the release with those notes and install instructions.
     Approve the deployment from the Actions run page when it reaches the
     environment gate. Self-approval is enabled because the repository has
     one maintainer; the gate makes publishing an explicit step.

Before tagging, run `just audit`: release builds must be free of
untriaged npm and RustSec advisories (docs/SUPPLY_CHAIN.md).

## AppImage specifics

Electron AppImages bundle the whole runtime (Electron + Chromium + Node).
The file also starts with the AppImage runtime, the binary that mounts the
image before our code runs. `electron-builder.yml` selects AppImage's
**static type2-runtime** (`toolsets.appimage: "1.0.3"`), which links FUSE
into the runtime itself, so users do **not** need `libfuse2`/`libfuse2t64`:
the legacy default `dlopen()`s `libfuse.so.2`, which Ubuntu 22.04+ no
longer installs by default.

Mounting still uses the `fusermount3` helper from the `fuse3` package, which
stock Ubuntu, Fedora and Debian desktops ship. On a minimal system or in a
container without it, run the image with `APPIMAGE_EXTRACT_AND_RUN=1` (or
`--appimage-extract-and-run`) to extract and start it without mounting.

Supported platforms: Ubuntu 22.04 and Debian 12 or newer. The static runtime
is not the limit on older releases, but the bundled sidecar and document
worker are built against the glibc 2.35 floor (docs/BUILD.md "Release sidecar
ABI floor"), so on Ubuntu 20.04 or Debian 11 they fail at start with
`GLIBC_2.35 not found`. The deb carries the same floor.

`scripts/check-appimage.sh` (`just check-appimage`) guards this: it asserts
the embedded runtime reports the type2-runtime, contains no `libfuse.so.2`
reference, and is statically linked, then checks the payload and self-mounts
the image when the host has a mount helper. CI and the release workflow run
it after `just package`.

## Pacman specifics

`electron-builder.yml` selects the `pacman` target, which electron-builder
labels beta upstream. fpm assembles the `.pkg.tar.zst`, so the build host
needs `bsdtar` for `.MTREE` and `zstd` for the tarball (Debian/Ubuntu:
`libarchive-tools` and `zstd`); `pacman` and `makepkg` are not required. The
artifact is `tuxbooks-<version>-1-x86_64.pkg.tar.zst`, zstd-compressed, with
`pkgver = <version>-1` in `.PKGINFO`.

The depends list is explicit and follows the packaged binary's direct ELF
requirements. It is not electron-builder's default, which mirrors Arch's
system-linked `electron` package (`c-ares`, `ffmpeg`, `libevent`, ...): the
electron-builder runtime bundles its own ffmpeg/event/codec libraries and
links only the X/GTK stack. That default also still names `http-parser` and
`libappindicator-gtk3`, which Arch removed, and the `"default"` merge
keyword only exists from electron-builder 27. The list here adds
`hicolor-icon-theme` for the icon hierarchy and `xdg-utils` for
`shell.openExternal`. `scripts/check-pacman.sh` (`just check-pacman`) fails
the package if any required entry is missing or either stale package
returns, and `namcap` on the built package is clean.

Arch is rolling, so it always meets the sidecar's glibc 2.35 floor. The deb
and pacman packages carry the same sidecar and worker. CI also resolves the
package transaction in a current `archlinux` container, so a dependency Arch
drops from its repositories fails there instead of at install time.

## Deliberate deferrals

- **Signed artifacts:** `SHA256SUMS.txt` only. GPG/(sigstore) signing waits
  until there is key infrastructure and a distribution channel that
  consumes it; checksums over HTTPS from the GitHub release are the
  pre-1.0 baseline. Provenance today: every release artifact is built by
  the release workflow from an immutable `v*` tag of this repository, with
  the SBOM (S-4) publishing the exact dependency set the build resolved.
- **Update strategy:** none built. deb installs upgrade in place via `apt`
  and pacman via `pacman -U` (same package name and identifier), AppImage is
  replaced by downloading the newer file. If auto-update is ever required,
  that is `electron-updater` with signed manifests — a later decision
  (ROADMAP: "update strategy if later required").
- **Flatpak/Snap:** not planned; Ubuntu/Debian and Arch are served by the
  native packages, the other Linux setups by the AppImage.
