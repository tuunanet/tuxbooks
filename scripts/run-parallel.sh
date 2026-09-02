#!/usr/bin/env bash
# Run independent commands concurrently and fail if any of them fails.
#
# Usage: run-parallel.sh 'name: command' ['name: command' ...]
#
# Output is interleaved live, each line prefixed with the stream name.
# The exit code is non-zero if any stream fails; failed streams are listed
# at the end. Ctrl-C reaches every stream (same process group) and this
# script cleans up after itself.
#
# Keep cargo-dependent commands in ONE stream: concurrent cargo invocations
# block each other on the target-dir file lock and gain nothing.
set -u

if [ "$#" -eq 0 ]; then
  echo "usage: $0 'name: command' ['name: command' ...]" >&2
  exit 2
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"; pkill -P $$ 2>/dev/null' EXIT INT TERM

names=()
pids=()
for spec in "$@"; do
  name=${spec%%:*}
  command=${spec#*:}
  if [ "$name" = "$spec" ] || [ -z "$command" ]; then
    echo "invalid stream spec (want 'name: command'): $spec" >&2
    exit 2
  fi
  names+=("$name")
  {
    # Inner subshell so a stream command calling `exit` still reports its
    # code here instead of skipping the capture below.
    ( eval "$command" )
    printf '%s\n' "$?" > "$tmpdir/$name.rc"
  } 2>&1 | while IFS= read -r line; do
    printf '%-14s| %s\n' "$name" "$line"
  done &
  pids+=($!)
done

failed=()
for i in "${!names[@]}"; do
  name=${names[$i]}
  wait "${pids[$i]}"
  rc=$(cat "$tmpdir/$name.rc" 2>/dev/null || echo 1)
  if [ "$rc" -ne 0 ]; then
    failed+=("$name (exit $rc)")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'parallel run FAILED: %s\n' "${failed[*]}" >&2
  exit 1
fi
