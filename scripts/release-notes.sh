#!/usr/bin/env bash
# Draft the GitHub release notes for the next version into
# docs/release-notes/vX.Y.Z.md (docs/RELEASE.md "Cutting a release").
#
# The draft groups the user-facing commits since the last tag into the
# three sections every release note carries — New (feat), Changed
# (refactor, perf), Fixed (fix) — as prose-ready bullets: the type and
# scope prefix and the trailing PR reference are dropped, the first
# letter is capitalized. Everything else (docs, chores, CI, tests,
# dependency bumps) stays out; add anything worth a user's attention by
# hand. Then write the summary line, polish the wording, and commit the
# file with the version bump: the release workflow publishes exactly
# this file and fails the release when it is missing, so the section
# shape cannot be forgotten (see .github/workflows/release.yml).
#
# Usage: scripts/release-notes.sh X.Y.Z [--force]
#
# Safety rails: refuses a non X.Y.Z version, a version whose v* tag
# already exists (never move or reuse a tag), and a draft that already
# exists unless --force is passed — a polished file must not be
# clobbered by a re-run. Run from anywhere; the draft stays uncommitted.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "usage: $0 X.Y.Z [--force]" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi
NEW="$1"
FORCE="${2:-}"
if [ -n "$FORCE" ] && [ "$FORCE" != "--force" ]; then
  usage
fi
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "release-notes: '$NEW' is not an X.Y.Z version" >&2
  exit 1
fi
if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$NEW" >/dev/null; then
  echo "release-notes: tag v$NEW already exists — its notes are final; pick the next version" >&2
  exit 1
fi

# Range: the newest release tag reachable from HEAD (the previous
# release) up to the commits being released. --match keeps unrelated
# tags out of the range; the untagged bump commit sits inside it, but its
# chore(release) subject maps to no section.
LAST_TAG="$(git -C "$ROOT" describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)"
if [ -z "$LAST_TAG" ]; then
  echo "release-notes: no tag reachable from HEAD — nothing to compare against" >&2
  exit 1
fi

OUT="$ROOT/docs/release-notes/v$NEW.md"
if [ -e "$OUT" ] && [ "$FORCE" != "--force" ]; then
  echo "release-notes: docs/release-notes/v$NEW.md already exists — pass --force only to discard the polished draft" >&2
  exit 1
fi

new=()
changed=()
fixed=()
declare -A seen=()

# Conventional commit subject: "type(scope)!: message". Held in a
# variable because bash misparses unquoted parentheses on the right side
# of =~.
SUBJECT_RE='^(feat|fix|refactor|perf)(\([^)]*\))?!?:[[:space:]]+(.+)$'

while IFS= read -r subject; do
  if [[ "$subject" =~ $SUBJECT_RE ]]; then
    type="${BASH_REMATCH[1]}"
    message="${BASH_REMATCH[3]}"
  else
    continue
  fi
  # Drop the trailing PR reference ("… (#246)"); the maintainer adds
  # links back only where they help a reader.
  message="${message% \(#[0-9]*\)}"
  # Trim and capitalize: commit subjects read "add a …", notes read
  # "Add a …".
  message="${message#"${message%%[![:space:]]*}"}"
  message="$(tr '[:lower:]' '[:upper:]' <<< "${message:0:1}")${message:1}"
  if [ -n "${seen[$message]:-}" ]; then
    continue
  fi
  seen[$message]=1
  case "$type" in
    feat) new+=("$message") ;;
    fix) fixed+=("$message") ;;
    *) changed+=("$message") ;;
  esac
done < <(git -C "$ROOT" log --no-merges --pretty=%s "$LAST_TAG..HEAD")

# Sections with entries are written out; an empty one leaves a comment
# instead, so the draft still names the section a release cycle may have
# skipped. The published notes drop empties (the released shape follows
# huggingface/tau), and the maintainer deletes the comment or fills it.
emit_section() {
  local title="$1"
  shift
  local items=("$@")
  if [ "${#items[@]}" -eq 0 ]; then
    printf '<!-- %s: empty since the last tag — add entries, or delete this comment. -->\n\n' "$title"
    return 0
  fi
  printf '## %s\n\n' "$title"
  local item
  for item in "${items[@]}"; do
    printf -- '- %s\n' "$item"
  done
  printf '\n'
}

mkdir -p "$(dirname "$OUT")"
{
  cat <<EOF
<!-- Write one sentence summarizing the release right below this comment,
     then delete the comment. Drafted from the commits since ${LAST_TAG}
     by scripts/release-notes.sh: edit the bullets freely, add what is
     missing, but keep the New / Changed / Fixed shape. -->

EOF
  emit_section "New" ${new[@]+"${new[@]}"}
  emit_section "Changed" ${changed[@]+"${changed[@]}"}
  emit_section "Fixed" ${fixed[@]+"${fixed[@]}"}
  cat <<EOF
## Install on Ubuntu/Debian

\`\`\`sh
sudo apt install ./tuxbooks_${NEW}_amd64.deb
\`\`\`

Or run the portable AppImage:

\`\`\`sh
chmod +x tuxbooks-${NEW}.AppImage
./tuxbooks-${NEW}.AppImage
\`\`\`

\`SHA256SUMS.txt\` verifies the downloads. The SBOM is published next to
the installers.

**Full changelog:** https://github.com/tuunanet/tuxbooks/compare/${LAST_TAG}...v${NEW}
EOF
} > "$OUT"

if [ "${#new[@]}" -eq 0 ] && [ "${#changed[@]}" -eq 0 ] && [ "${#fixed[@]}" -eq 0 ]; then
  echo "release-notes: warning — no feat/fix/refactor/perf commits since $LAST_TAG; write the release note from scratch" >&2
fi
echo "release-notes: $LAST_TAG..HEAD drafted into docs/release-notes/v$NEW.md (New: ${#new[@]}, Changed: ${#changed[@]}, Fixed: ${#fixed[@]})"
echo "release-notes: review and polish the draft, commit it with the version bump, then tag (docs/RELEASE.md)."
