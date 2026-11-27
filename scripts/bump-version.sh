#!/usr/bin/env bash
# Apply one version to every place a release bump touches (docs/RELEASE.md
# "Cutting a release", step 1): the root package.json (the electron-builder
# source of truth), the frontend package.json, the Rust crate's
# Cargo.toml + Cargo.lock, and — for a stable release — the homepage version
# badge in site/index.html.
#
# Usage: scripts/bump-version.sh X.Y.Z[-pre.N|-rc.N]
#
# Safety rails: refuses a version outside that shape, a bump to the current
# version, and a version whose v* tag already exists (never move or reuse a
# tag). Every file is asserted to carry its expected version first, so a
# drifted file fails loudly instead of silently staying stale. Run from
# anywhere; edits stay uncommitted — review the diff, commit, then tag per
# docs/RELEASE.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 X.Y.Z[-pre.N|-rc.N]" >&2
  exit 1
fi

NEW="$1"
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(pre|rc)\.[0-9]+)?$ ]]; then
  echo "bump-version: '$NEW' is not X.Y.Z, X.Y.Z-pre.N, or X.Y.Z-rc.N" >&2
  exit 1
fi
PRERELEASE=0
case "$NEW" in
*-*) PRERELEASE=1 ;;
esac

CURRENT="$(jq -r .version "$ROOT/package.json")"
if [ "$CURRENT" = "$NEW" ]; then
  echo "bump-version: already at $NEW" >&2
  exit 1
fi

if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$NEW" >/dev/null; then
  echo "bump-version: tag v$NEW already exists — never move or reuse a tag; pick the next version" >&2
  exit 1
fi

# Each file that must carry the crate/package version, as three parallel
# arrays: the file, the pattern pinning its current text, and the version
# token inside that pattern to swap for $NEW. The replacement is the same
# pattern with the token swapped, so lines keep their structure:
#   package.json / frontend/package.json — "version": "X.Y.Z" (first match)
#   sidecar/Cargo.toml — the [package] version (first `version = ` line)
#   site/index.html — the homepage badge's version token (the badge text may
#     wrap across lines, so match only the `vX.Y.Z &middot;` token); a
#     prerelease skips this file.
# sidecar/Cargo.lock is handled separately below (the tuxbooks package's own
# entry is located by its preceding `name = "tuxbooks"` line).
TARGET_FILES=()
TARGET_PATTERNS=()
TARGET_OLDVERS=()
TARGET_FILES+=("package.json")
TARGET_PATTERNS+=("\"version\": \"$CURRENT\"")
TARGET_OLDVERS+=("$CURRENT")
TARGET_FILES+=("frontend/package.json")
TARGET_PATTERNS+=("\"version\": \"$CURRENT\"")
TARGET_OLDVERS+=("$CURRENT")
TARGET_FILES+=("sidecar/Cargo.toml")
TARGET_PATTERNS+=("^version = \"$CURRENT\"")
TARGET_OLDVERS+=("$CURRENT")
if [ "$PRERELEASE" -eq 0 ]; then
  # The badge advertises the stable release the site shows, which after a
  # pre-release run is not CURRENT (X.Y.Z-pre.N): it still carries the last
  # stable tag (docs/RELEASE.md "Pre-releases"). Pin the assertion to the
  # advertised version so the badge moves from that tag to $NEW; a badge
  # without a stable version token is drift and fails loudly.
  BADGE="$(sed -n 's/.*v\([0-9]\+\.[0-9]\+\.[0-9]\+\) &middot;.*/\1/p' "$ROOT/site/index.html" | head -n1)"
  if [ -z "$BADGE" ]; then
    echo "bump-version: site/index.html carries no stable 'vX.Y.Z &middot;' badge — fix the drift first" >&2
    exit 1
  fi
  TARGET_FILES+=("site/index.html")
  TARGET_PATTERNS+=("v$BADGE &middot;")
  TARGET_OLDVERS+=("$BADGE")
fi

# Assert every file first, then edit: a drift anywhere exits before the
# first change, so a failed bump cannot leave a half-applied state behind.
for i in "${!TARGET_FILES[@]}"; do
  if ! grep -q "${TARGET_PATTERNS[$i]}" "$ROOT/${TARGET_FILES[$i]}"; then
    echo "bump-version: ${TARGET_FILES[$i]} does not carry the expected version ('${TARGET_PATTERNS[$i]}') — fix the drift first" >&2
    exit 1
  fi
done
LOCK_VERSION="$(awk '$0 == "name = \"tuxbooks\"" { getline; print $0 }' "$ROOT/sidecar/Cargo.lock")"
if [ "$LOCK_VERSION" != "version = \"$CURRENT\"" ]; then
  echo "bump-version: sidecar/Cargo.lock tuxbooks entry does not carry the current version ($LOCK_VERSION) — fix the drift first" >&2
  exit 1
fi

# Rewrite Cargo.lock into a temp file, then the sed pass below, and only
# then move it into place: the same no-half-applied-state guarantee. The
# EXIT trap drops the temp file if anything between here and the mv fails.
# Only the tuxbooks package's own version entry is touched — the state
# machine pairs each `name = "…"` with the version line that follows it.
trap 'rm -f "$ROOT/sidecar/Cargo.lock.tmp"' EXIT
awk -v current="version = \"$CURRENT\"" -v replacement="version = \"$NEW\"" '
  $0 == "name = \"tuxbooks\"" { in_tuxbooks = 1; print; next }
  in_tuxbooks && $1 == "version" { print replacement; in_tuxbooks = 0; next }
  { print }
' "$ROOT/sidecar/Cargo.lock" > "$ROOT/sidecar/Cargo.lock.tmp"

changed=()
for i in "${!TARGET_FILES[@]}"; do
  file="${TARGET_FILES[$i]}"
  pattern="${TARGET_PATTERNS[$i]}"
  oldver="${TARGET_OLDVERS[$i]}"
  # Replace only the FIRST occurrence; $NEW is validated above and contains
  # no sed metacharacters. The replacement is the pattern with the version
  # swapped: the regex anchor (^) must not appear in the replacement, and
  # `&` there means "the whole match", so it is escaped.
  replacement="${pattern/#^/}"
  replacement="${replacement/$oldver/$NEW}"
  replacement="${replacement//&/\\&}"
  sed -i "0,/$pattern/s//$replacement/" "$ROOT/$file"
  changed+=("$file")
done

mv "$ROOT/sidecar/Cargo.lock.tmp" "$ROOT/sidecar/Cargo.lock"
changed+=("sidecar/Cargo.lock")

# Verify: every touched place now reports the new version.
status=0
version_files=(
  "package.json"
  "frontend/package.json"
  "sidecar/Cargo.toml"
)
if [ "$PRERELEASE" -eq 0 ]; then
  version_files+=("site/index.html")
fi
for version_line in "${version_files[@]}"; do
  if ! grep -q "$NEW" "$ROOT/$version_line"; then
    echo "bump-version: $version_line does not report $NEW after the edit" >&2
    status=1
  fi
done
if [ "$(awk '$0 == "name = \"tuxbooks\"" { getline; print $0 }' "$ROOT/sidecar/Cargo.lock")" != "version = \"$NEW\"" ]; then
  echo "bump-version: sidecar/Cargo.lock tuxbooks entry does not report $NEW after the edit" >&2
  status=1
fi
if [ "$status" -ne 0 ]; then
  exit 1
fi

echo "bump-version: $CURRENT -> $NEW in:"
for file in "${changed[@]}"; do
  echo "  $file"
done
echo "bump-version: review the diff, commit (\"chore: bump version to $NEW\"), let CI go green, then tag v$NEW (docs/RELEASE.md)."
