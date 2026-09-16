# Security corpus (issue #87)

Hostile input for the boundary tests. This directory holds the Rust-side
corpus builders and their layout notes; the TS-side corpus (vector arrays,
hostile EPUB builders, and the per-invariant index) lives in
`frontend/tests/security/corpus/`.

## Layout

- `hostile_epub.rs` / `hostile_pdf.rs` are fixture builders, not fixtures.
  Nothing hostile is committed as a binary. Tests generate each file at
  runtime into a tempdir, so a failing case reproduces byte for byte
  (fixed seeds, no clock).
- `tests/security_corpus.rs` is the corpus index target. Each test names
  the invariant it proves (R-1, R-2/P-1, and the W boundary subset) and
  asserts fail-closed behavior: a typed error or a bounded, inert result,
  never a silent accept and never a panic.
- The fuzzing task (#88) can include the same builders via `#[path]` and
  use them as fuzz seeds, so a minimized crashing input has a home here as
  a builder (not a blob).

## What is covered here vs. elsewhere

Existing tests from the tasks that landed each enforcement are indexed, not
duplicated. The map from invariant ID to vectors and owning tests lives in
`frontend/tests/security/corpus/index.ts` and the corpus section of
`docs/TESTING.md`. This directory carries the shapes that had no fixture:
the compressed-member parse-path case (deferred from issue #83), deep
member paths, truncated and corrupted ZIP central directories, entity
expansion in the OPF, inert malformed fonts and covers, and the hostile
PDF shapes (bad startxref, truncated xref, self-referential page tree,
extreme page geometry). The worker boundary tests drive hostile EPUB and
PDF fixtures through the real `tuxbooks-worker` and pin that a typed error
comes back and the worker keeps serving.

## Adding a fixture

Add a builder function to the matching module, a corpus test that asserts
the fail-closed contract, and a row (or pointer) in the corpus index. If a
shape cannot be produced by a builder, byte-patch a valid one the way
`corrupt_central_directory` does, and keep the patch deterministic.
