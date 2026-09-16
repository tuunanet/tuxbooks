# Task 6 report: #88 fuzzing targets

Branch: security-architecture. Commits: 90f32fd, a4fc45a, 1431845, 6d7d829, da0331b.

## Targets and entry points fuzzed

| Target       | Surface (issue #88 wording)                 | Entry points driven by the harness                                    |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| `epub-parse` | EPUB ZIP/member/path handling               | `epub/parser.rs` `parse_epub_reader` (import parse), `epub/session.rs` `read_member_reader` (E-5 member gate), `epub/session.rs` `build_session_reader` (session build) |
| `opf-xml`    | OPF/XML manifest parsing                    | `epub/metadata.rs` `parse_opf`, `epub/parser.rs` `parse_container_xml` |
| `pdf-parse`  | PDF parsing and metadata extraction         | `pdf/parser.rs` `parse_pdf_bytes`: lopdf load with the stream inflation cap, bounded page-tree walk, metadata string decode |
| `json-rpc`   | JSON-RPC parameter decoding (T-6)           | `rpc.rs` `handle_request_line` (the exact boundary code `handle_line` runs) against a real scratch `AppState` |

The spec lists a fifth area, "range parsing and resource serving". The
controller bound this task to four targets, and the range/resource serving
paths sit behind book-id resolution, so the json-rpc target covers their
parameter decoding (`get_book_bytes`, `get_book_resource` offsets, lengths,
member paths) and the epub-parse target covers member serving on the Rust
side. Nothing else in that area parses attacker bytes without a database
row in front of it.

## Harness mechanism

cargo-fuzz 0.13.2 with libFuzzer, nightly toolchain
(1.100.0-nightly 2026-09-15), address sanitizer, release profile with
debug assertions. Ruling 1 asked whether nightly was installable in this
environment: it was, via `rustup toolchain install nightly --profile
minimal` plus `cargo install cargo-fuzz --locked`. No deviation was
needed; the planned mechanism is what shipped.

Layout: `sidecar/fuzz/` (own crate, own `Cargo.lock`, committed seeds under
`sidecar/fuzz/seeds/`). Runtime corpus (`fuzz/corpus/`), crash artifacts
(`fuzz/artifacts/`), and build output (`fuzz/target/`) are gitignored; the
fuzz crate is not a workspace member, so `just check` never builds it.

Two production seams were needed (no behavior change, existing tests pin
them, 13 rpc tests pass):

- `rpc.rs`: `handle_request_line` plus `RequestLineOutcome`, extracted from
  `handle_line` so the fuzz target drives the real boundary logic instead
  of a mirror that would drift.
- `epub/parser.rs`: `parse_container_xml` is now `pub` and re-exported, so
  the opf-xml target can reach it.

Harness details worth knowing:

- `epub-parse` dispatches on the first input byte: `0x00` +
  NUL-terminated member path + archive bytes drives the member lookup,
  `0x01` + archive bytes drives the reading-session build, anything else
  parses whole. Real EPUB files seed the default mode directly, and the
  grown corpus holds all three modes (144 member-lookup, 331
  session-build, 241+ import-parse entries).
- Fuzz runs use a tightened quota table (`fuzz/fuzz_targets/fuzz_limits.rs`):
  the production `ResourceLimits` with byte caps around 1 MiB, so hostile
  archives trip a quota in microseconds instead of inflating toward the
  512 MiB production ceilings. Quota trips are typed errors, not hangs.
- `json-rpc` builds one process-lifetime state in
  `fuzz/target/json-rpc-scratch/` (wiped at init, gitignored, in-workspace):
  tempdir-free, real SQLite schema, seeded book row, empty library
  directory. Filesystem-path parameters (`scan_library`, `import_paths`,
  `reconnect_book`, `set_book_cover`) are pinned into the scratch directory
  before the request executes, so mutated paths can never leave the
  workspace; `create_collection` names are pinned because that table is the
  one place a fuzz run could grow the database without bound. Non-string
  shapes stay untouched, so -32602 parameter decoding stays reachable.
  Every produced response line is asserted to be valid JSON; a violation
  would surface as a crash.

## Local run evidence

All runs used `just fuzz <target> <seconds>`, which passes
`-max_total_time` (time-box), `-rss_limit_mb=4096`, and `-timeout=25`.
Every run wrote only inside the workspace.

First pass, 30 seconds per target from the seed corpus:

| Target       | Execs in 31s | Outcome |
| ------------ | ------------ | ------- |
| `epub-parse` | 367,864      | clean   |
| `opf-xml`    | 928,294      | clean   |
| `pdf-parse`  | 93,352       | clean   |
| `json-rpc`   | 85,088       | clean   |

`just fuzz-smoke` second pass (warm corpus), 30 seconds per target:
`epub-parse` 261,868; `opf-xml` 688,002; `pdf-parse` 137,815;
`json-rpc` 62,796. All clean.

After moving the json-rpc scratch into the workspace: 47,005 execs in 21s,
clean, scratch contents verified on disk.

## Crashes and hangs

Clean bill on all four targets. Roughly 2.6 million executions across the
runs above produced no crash, no libFuzzer timeout (hang), no OOM, and no
leak reports. `sidecar/fuzz/artifacts/` is empty. Nothing to minimize and
no production fix routed to the controller.

This is consistent with what the corpus tests already pin: the limits
landed in #83 turn the bomb and oversized-input classes into typed errors
before they can become hangs, and the parsers behind these entry points
are panic-free paths over safe Rust plus `quick-xml`, `zip`, and `lopdf`.

## Seed corpus provenance

Committed under `sidecar/fuzz/seeds/<target>/`, all small and benign:

- `epub-parse/`: `minimal.epub` copied from the checked-in fixture
  `tests/fixtures/books/minimal.epub`, plus `member-lookup` (mode byte +
  `chapter1.xhtml` + that fixture) and `session-build` (mode byte +
  fixture).
- `opf-xml/`: `package.opf`, `container.xml`, `entity.opf`, matching the
  valid shapes the parser tests use.
- `pdf-parse/`: `minimal.pdf` copied from the checked-in fixture.
- `json-rpc/`: one request per file (ping, list, search, progress,
  collection, annotation, missing method, unknown method, bad params,
  truncated JSON).

No hostile blob is committed, matching the #87 convention that hostile
material is generated at runtime; hostile shapes are one mutation away
from these seeds.

## CI wiring

`.github/workflows/fuzz.yml`: schedule `20 3 * * *` plus manual
`workflow_dispatch`. One job on ubuntu-24.04 (60-minute cap): checkout,
nightly toolchain, rust-cache over `sidecar` and `sidecar/fuzz`, `cargo
install cargo-fuzz --locked`, `just fuzz-ci` (300 seconds per target,
about 20 minutes of fuzzing plus build), and an artifact upload of
`sidecar/fuzz/artifacts/` on failure for triage. Never per-PR, per the
plan. The workflow passes actionlint (`just lint-workflows`).

## Docs updated

- `docs/TESTING.md`: new "Fuzzing (issue #88)" section with the target
  table, prerequisites, bounded run commands, expected durations, seed and
  harness shape, crash reproduction and minimization commands, the hang
  versus typed-limit distinction, and the out-of-scope note.
- `.gitignore` / `.prettierignore`: fuzz build output, corpus, and
  artifacts ignored; seeds excluded from prettier so they stay
  byte-stable.

## Constraint compliance

- `just check` green after all changes (format, clippy, tests, frontend
  streams, actionlint). The fuzz crate sits outside it.
- Runs time-boxed with `-max_total_time`; all writes stay in the workspace.
- No production code changed to fix a crash (none found); the two seams are
  visibility-only extractions covered by existing tests.
- No `gh` commands were run; closing #88 and ticking the #78 checklist is
  left to the controller.

## Self-review and concerns

- The workflow has not executed on GitHub yet; it is linted but the first
  nightly run will be the real proof of cache behavior and the 60-minute
  cap. If the cold instrumented build crowds the cap, lower the per-target
  time before raising the cap.
- cargo-fuzz is installed unpinned in CI, so a future cargo-fuzz or nightly
  release can break the nightly job independently of this codebase. Pinning
  both is a cheap follow-up if that happens.
- The json-rpc target's path gate is harness logic, not a production
  guarantee; it exists so fuzzing cannot walk the operator's filesystem.
  The un-gated behavior of those methods is covered by the boundary and
  worker tests, not by this target, and the runbook says so.
- libFuzzer's exec/s on `json-rpc` (about 2k/s) is lower than the parsers
  because each exec runs real SQLite work. That is the cost of driving the
  real boundary; fine for a nightly cadence.
- The known residual class is unchanged and documented: content streams
  PDFium decodes at render time are not lopdf-bounded and remain
  containment-only (worker RLIMIT_AS plus deadline). Fuzzing that class
  belongs to PDFium/OSS-Fuzz, not this harness.
