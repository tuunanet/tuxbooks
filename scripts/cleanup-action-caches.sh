#!/usr/bin/env bash
# Scheduled hygiene for the GitHub Actions cache store (tuxbooks-68l).
#
# The store sits under a 10 GB quota. At the ceiling GitHub's own LRU
# eviction starts thrashing the hot set mid-build, so this frees quota
# proactively on a weekly schedule. It only ever deletes regenerable
# caches, and default-branch (main) entries accessed within the last
# 3 days are protected from rules 1-3 (the rule 4 quota valve may still
# touch them).
#
# Rules — a cache is deleted if ANY fires:
#   1 dead-PR-ref     refs/pull/N/merge where PR N is merged or closed
#                     (the ref can never run again)
#   2 dead-branch-ref refs/heads/<branch> (not main) whose branch is gone
#   3 stale           not accessed for more than 7 days (mirrors GitHub's
#                     auto-eviction, but frees quota before LRU thrash)
#   4 quota-valve     after rules 1-3, while the remaining total exceeds
#                     8 GB, delete least-recently-accessed entries, except
#                     those accessed within the last 24 hours
#
# DRY_RUN=true (the default when unset) prints decisions and deletes
# nothing; run it locally with DRY_RUN=1 to preview. The workflow sets
# DRY_RUN explicitly: manual dispatches honor its dry_run input, the
# weekly schedule deletes for real.
#
# Needs: gh (authenticated), jq, GNU date, numfmt.

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
DRY_RUN="${DRY_RUN:-true}"
case "$DRY_RUN" in
  true | 1 | yes) DRY_RUN=true ;;
  false | 0 | no) DRY_RUN=false ;;
  *)
    echo "cleanup-action-caches: invalid DRY_RUN='$DRY_RUN' (want true/false)" >&2
    exit 1
    ;;
esac

now=$(date -u +%s)
sec_per_day=$((24 * 60 * 60))
stale_after=$((7 * sec_per_day))         # rule 3 threshold
guardrail=$((3 * sec_per_day))           # rules 1-3 may not touch main < 3 days
hot_window=$((1 * sec_per_day))          # rule 4 exempts entries < 24 hours
valve_bytes=$((8 * 1024 * 1024 * 1024))  # rule 4 ceiling (8 GB)

deleted=0
failed_deletes=0
freed_bytes=0

gb() { LC_ALL=C awk -v b="$1" 'BEGIN { printf "%.2f", b / 1073741824 }'; }
human() { LC_ALL=C numfmt --to=iec --suffix=B "$1"; }

# Report one decision. Counters advance only on an actual (or, in
# dry-run, projected) deletion — a failed gh call is counted separately,
# never as freed quota. In dry-run mode the counters describe what the
# post-run store would look like and the gh call is skipped.
delete_cache() {
  local id="$1" size="$2" rule="$3" ref="$4" key="$5"
  if "$DRY_RUN"; then
    printf 'would delete [%s] %10s  %s  %s\n' "$rule" "$(human "$size")" "$key" "$ref"
    deleted=$((deleted + 1))
    freed_bytes=$((freed_bytes + size))
  elif gh cache delete --repo "$REPO" --id "$id"; then
    printf 'deleted       [%s] %10s  %s  %s\n' "$rule" "$(human "$size")" "$key" "$ref"
    deleted=$((deleted + 1))
    freed_bytes=$((freed_bytes + size))
  else
    # Evicted mid-run by GitHub; the next scheduled pass re-derives
    # reality anyway, so a miss here is not a failure.
    printf 'delete failed  [%s] id=%s (evicted mid-run?)\n' "$rule" "$id" >&2
    failed_deletes=$((failed_deletes + 1))
  fi
}

# True unless the branch is gone. Only HTTP 404 marks a branch dead: any
# other failure (rate limit, 5xx, network) is treated as alive, so a
# transient API error can never turn rule 2 against a live branch's
# caches; one stderr line explains the skip. gh api -i dumps the status
# line on errors, so the verdict reads the actual HTTP code rather than
# gh's error prose. Branch names are URL-encoded so slashed names
# resolve; there is no checkout in the calling workflow, hence no git
# credentials for ls-remote.
branch_exists() {
  local branch="$1" out status
  if out=$(gh api -i "repos/$REPO/branches/$(jq -rn --arg b "$branch" '$b | @uri')" 2>/dev/null); then
    return 0
  fi
  status=$(head -n1 <<<"$out" | awk '{print $2}')
  if [ "$status" = 404 ]; then
    return 1
  fi
  printf 'branch check: %s lookup failed (HTTP %s, not 404); branch treated as alive, rule 2 skipped\n' \
    "$branch" "${status:-unknown}" >&2
  return 0
}

echo "Actions cache cleanup on $REPO (dry_run=$DRY_RUN, $(date -u +%Y-%m-%dT%H:%M:%SZ))"

caches="$(gh cache list --repo "$REPO" --limit 1000 \
  --json id,key,ref,lastAccessedAt,sizeInBytes \
  | jq -r 'sort_by(.lastAccessedAt)[] | [.id, .sizeInBytes, .lastAccessedAt, .ref, .key] | @tsv')"
if [ -z "$caches" ]; then
  echo "cache store is empty; nothing to do"
  exit 0
fi
total_bytes=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' <<<"$caches")
echo "store: $(grep -c '' <<<"$caches") entries, $(gb "$total_bytes") GB ($(human "$total_bytes"))"

# Rule 1 set: PRs whose merge ref can never run again. --state closed
# already includes merged PRs; sort -un dedupes defensively. Beyond 1000
# PRs the tail ages out through rule 3 instead.
dead_prs="$(gh pr list --repo "$REPO" --state closed --limit 1000 \
  --json number --jq '.[].number' | sort -un)"

survivors="$(mktemp)"
kept="$(mktemp)"
trap 'rm -f "$survivors" "$kept"' EXIT

# Rules 1-3.
while IFS=$'\t' read -r id size accessed ref key; do
  [ -n "$id" ] || continue
  age=$((now - $(date -u -d "$accessed" +%s)))
  rule=""
  case "$ref" in
    refs/pull/*/merge)
      pr="${ref#refs/pull/}"
      pr="${pr%/merge}"
      if grep -qx -- "$pr" <<<"$dead_prs"; then
        rule="1 dead-PR-ref"
      fi
      ;;
    refs/heads/*)
      branch="${ref#refs/heads/}"
      if [ "$branch" != main ] && ! branch_exists "$branch"; then
        rule="2 dead-branch-ref"
      fi
      ;;
  esac
  if [ -z "$rule" ] && [ "$age" -gt "$stale_after" ]; then
    rule="3 stale-7d"
  fi
  # Guardrail: rules 1-3 never delete a main entry accessed within the
  # last 3 days. Belt and suspenders — no rule above can reach that state
  # (PR refs are never main, rule 2 skips main, and anything rule 3 can
  # see is older than the guardrail window); only the quota valve below
  # may touch such an entry.
  if [ -n "$rule" ] && [ "$ref" = refs/heads/main ] && [ "$age" -lt "$guardrail" ]; then
    rule=""
  fi
  if [ -n "$rule" ]; then
    delete_cache "$id" "$size" "$rule" "$ref" "$key"
  else
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$size" "$age" "$accessed" "$ref" "$key" >>"$survivors"
  fi
done <<<"$caches"

# Rule 4: quota valve, oldest-accessed first. Stop at the first entry hot
# within 24 hours — everything after it is at least as hot, so today's
# set survives even an anomalous week.
remaining_bytes=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$survivors")
final="$survivors"
if [ "$remaining_bytes" -gt "$valve_bytes" ]; then
  echo "quota valve: remaining $(gb "$remaining_bytes") GB exceeds 8 GB; trimming least-recently-accessed (24h-hot entries exempt)"
  : >"$kept"
  while IFS=$'\t' read -r id size age accessed ref key; do
    [ -n "$id" ] || continue
    if [ "$remaining_bytes" -le "$valve_bytes" ] || [ "$age" -lt "$hot_window" ]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$size" "$age" "$accessed" "$ref" "$key" >>"$kept"
    else
      delete_cache "$id" "$size" "4 quota-valve" "$ref" "$key"
      remaining_bytes=$((remaining_bytes - size))
    fi
  done < <(sort -t$'\t' -k3,3rn "$survivors")
  final="$kept"
fi

remaining_count=$(grep -c '' "$final" || true)
final_bytes=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$final")
if "$DRY_RUN"; then
  echo "summary (dry run): would delete $deleted entries, freeing $(gb "$freed_bytes") GB"
elif [ "$failed_deletes" -eq 0 ]; then
  echo "summary: deleted $deleted entries, freeing $(gb "$freed_bytes") GB"
else
  echo "summary: deleted $deleted entries, freeing $(gb "$freed_bytes") GB; $failed_deletes delete(s) failed (not freed; re-derives next pass)"
fi
echo "remaining: $remaining_count entries, $(gb "$final_bytes") GB (computed from the list API; the cache/usage endpoint lags several minutes behind deletions)"
