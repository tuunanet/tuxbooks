#!/usr/bin/env bash
# Apply one version to every place a release bump touches (docs/RELEASE.md
# "Cutting a release", step 1): the root package.json (the electron-builder
# source of truth), the frontend package.json, the Rust crate's
# Cargo.toml + Cargo.lock, and the homepage version badge in site/index.html.
#
# Usage: scripts/bump-version.sh X.Y.Z
#
# Safety rails: refuses a non X.Y.Z version, a bump to the current version,
# and a version whose v* tag already exists (never move or reuse a tag).
# Every file is asserted to carry the current version first, so a drifted
# file fails loudly instead of silently staying stale. Run from anywhere;
# edits stay uncommitted — review the diff, commit, then tag per
# docs/RELEASE.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 X.Y.Z" >&2
  exit 1
fi

NEW="$1"
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "bump-version: '$NEW' is not an X.Y.Z version" >&2
  exit 1
fi

CURRENT="$(jq -r .version "$ROOT/package.json")"
if [ "$CURRENT" = "$NEW" ]; then
  echo "bump-version: already at $NEW" >&2
  exit 1
fi

if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$NEW" >/dev/null; then
  echo "bump-version: tag v$NEW already exists — never move or reuse a tag; pick the next version" >&2
  exit 1
fi

# Each file that must carry the crate/package version, with the pattern that
# pins its current value. The replacement is the same pattern with the
# version swapped, so lines keep their structure:
#   package.json / frontend/package.json — "version": "X.Y.Z" (first match)
#   sidecar/Cargo.toml — the [package] version (first `version = ` line)
#   site/index.html — the homepage badge's headline version
# sidecar/Cargo.lock is handled separately below (the tuxbooks package's own
# entry is located by its preceding `name = "tuxbooks"` line).
OLD_LINE=(
  "package.json|\"version\": \"$CURRENT\""
  "frontend/package.json|\"version\": \"$CURRENT\""
  "sidecar/Cargo.toml|^version = \"$CURRENT\""
  "site/index.html|v$CURRENT &middot; in active development"
)

# Rewrite Cargo.lock first into a temp file: the script must not leave a
# half-applied state if this step fails. Only the tuxbooks package's own
# version entry is touched — the state machine pairs each `name = "…"` with
# the version line that follows it.
awk -v current="version = \"$CURRENT\"" -v replacement="version = \"$NEW\"" '
  $0 == "name = \"tuxbooks\"" { in_tuxbooks = 1; print; next }
  in_tuxbooks && $1 == "version" { print replacement; in_tuxbooks = 0; next }
  { print }
' "$ROOT/sidecar/Cargo.lock" > "$ROOT/sidecar/Cargo.lock.tmp"

changed=()
for entry in "${OLD_LINE[@]}"; do
  file="${entry%%|*}"
  pattern="${entry#*|}"
  path="$ROOT/$file"
  if ! grep -q "$pattern" "$path"; then
    rm -f "$ROOT/sidecar/Cargo.lock.tmp"
    echo "bump-version: $file does not carry the current version $CURRENT ('$pattern') — fix the drift first" >&2
    exit 1
  fi
  # Replace only the FIRST occurrence; $NEW is validated above and contains
  # no sed metacharacters. The replacement is the pattern with the version
  # swapped: the regex anchor (^) must not appear in the replacement, and
  # `&` there means "the whole match", so it is escaped.
  replacement="${pattern/#^/}"
  replacement="${replacement/$CURRENT/$NEW}"
  replacement="${replacement//&/\\&}"
  sed -i "0,/$pattern/s//$replacement/" "$path"
  changed+=("$file")
done

mv "$ROOT/sidecar/Cargo.lock.tmp" "$ROOT/sidecar/Cargo.lock"
changed+=("sidecar/Cargo.lock")

# Verify: every touched place now reports the new version.
status=0
for version_line in \
  "package.json" \
  "frontend/package.json" \
  "sidecar/Cargo.toml" \
  "site/index.html"; do
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
