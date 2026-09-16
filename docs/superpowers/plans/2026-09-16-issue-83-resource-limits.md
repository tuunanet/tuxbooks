# Issue #83 Resource Limits (R-1..R-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every EPUB/PDF parse path in the Rust sidecar enforces an explicit, documented quota table and fails hostile documents fast with a typed bounded-resource error instead of hanging, allocating indefinitely, or crashing.

**Architecture:** One new shared module `sidecar/src/limits.rs` owns the quota table (`ResourceLimits` + `DEFAULTS`), the typed error (`LimitExceeded`), the wall-clock budget (`Deadline`), and the capped-read guard (`read_bounded`). The existing parse entry points (`epub::parser`, `epub::session`, `epub::metadata`, `pdf::parser`, `pdf::render`) take a `&ResourceLimits` parameter and call the helpers; callers outside parsing pass `DEFAULTS`. The future sandboxed worker (#81) and fuzzing (#88) reuse the same module and can override every field.

**Tech Stack:** Rust (std, thiserror; zip 2.4, quick-xml 0.37, lopdf 0.44, pdfium-render 0.9 already in the tree). No new dependencies.

**Spec:** `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-83-spec.md` (invariants R-1..R-4) under the umbrella `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-78-umbrella.md`.

## Global Constraints

- TDD: the failing test for each enforcement point exists before its implementation; RED observed before GREEN.
- Errors via `thiserror` enums; a tripped limit returns `LimitExceeded` (as `EpubError::Limit` / `PdfError::Limit`), never panics, never `unwrap`s attacker input.
- Required interface names, verbatim: `ResourceLimits` with fields including `max_decompressed_bytes`, `max_entries`, `max_xml_depth`, `max_parse_seconds`; a `DEFAULTS` const; helpers return typed errors.
- No new crate dependencies. `epub/`/`pdf/` may depend only on std, zip/quick-xml/lopdf/pdfium-render per `docs/ARCHITECTURE.md`; `limits` depends on std + thiserror only.
- Limit values are provisional and documented as such (R-4 says the numbers are follow-up work; this issue tracks existence, enforcement, documentation, tests).
- Malicious test inputs are generated at runtime with the existing `write_zip` / `build_pdf` test helpers (repo convention), not committed binaries; the committed EPUB corpus and its size budget stay untouched.
- `just test-rust` green, then `just check` green, before finishing; `just format` after Rust edits.
- Commit messages: Conventional Commits, imperative, no em dashes.

## Invariant-to-enforcement map

| Quota (spec wording) | Field | Enforced at |
| --- | --- | --- |
| EPUB source file size | `max_source_file_bytes` | `parse_epub`, `build_session`, `read_member` |
| ZIP entry count | `max_entries` | `parse_epub`, `build_session`, `read_member` |
| Compressed member size | `max_compressed_member_bytes` | every ZIP read via `read_entry`/`read_mimetype` |
| Uncompressed member size | `max_decompressed_bytes` | declared size checked before read + `read_bounded` cap during read |
| Total uncompressed archive size | `max_total_uncompressed_bytes` | `parse_epub`, `build_session` (declared-size pre-scan) |
| XML/OPF/document size | `max_xml_bytes` | `parse_container_xml`, `parse_opf`, nav + NCX parsers |
| Metadata string length | `max_metadata_string_bytes` | `parse_opf` values; PDF info-dict strings |
| Image/font size incl. decoded | member caps on every read | Rust never decodes images/fonts (cover bytes cached verbatim); documented in `docs/RESOURCE_LIMITS.md` |
| XML depth | `max_xml_depth` | `parse_container_xml`, `parse_opf`, nav + NCX stacks |
| PDF source file size | `max_source_file_bytes` | `parse_pdf`, `read_file_properties`, `render_first_page_cover` |
| PDF page count | `max_pages` | budgeted page-tree walk in `pdf::parser` |
| Structural/object traversal work | `max_page_tree_nodes` | page-tree walk stops at the node budget |
| Recursion depth | `max_page_tree_depth` | page-tree walk is iterative with a depth cap |
| Decoded image dimensions/bytes | `max_cover_png_bytes` | render output capped; dimensions fixed by `COVER_WIDTH_PX` render config |
| Cover-render work | deadline + source cap + fixed 600px target + PNG cap | `render_first_page_cover` |
| Wall clock (both formats, R-3) | `max_parse_seconds` | `Deadline` checked between stages |
| CPU (R-3) | same deadline | parses are synchronous and single-threaded, so the wall-clock deadline is the CPU bound; true per-parse CPU accounting moves into the killable worker (#81). Documented. |
| Memory (R-3) | size quotas + `read_bounded` | no unbounded allocation remains on any parse path |

---

### Task 1: `limits` module core

**Files:**
- Create: `sidecar/src/limits.rs`
- Modify: `sidecar/src/lib.rs` (add `pub mod limits;`)

**Interfaces produced (consumed by tasks 2-4, then #81/#88):**

```rust
pub struct ResourceLimits { /* all u64/usize fields below */ }
pub const DEFAULTS: ResourceLimits;
pub struct LimitExceeded { pub limit: &'static str, pub detail: String }  // thiserror::Error
pub struct Deadline { /* Instant + Duration */ }  // Deadline::start(&limits), .check()
pub enum ReadBoundedError { Limit(LimitExceeded), Io(std::io::Error) }
pub fn read_bounded<R: Read>(reader: R, max_bytes: u64) -> Result<Vec<u8>, ReadBoundedError>;
impl ResourceLimits {
    pub fn check_source_file(&self, bytes: u64) -> Result<(), LimitExceeded>;
    pub fn check_entries(&self, count: usize) -> Result<(), LimitExceeded>;
    pub fn check_member(&self, compressed: u64, declared_uncompressed: u64) -> Result<(), LimitExceeded>;
    pub fn check_total_uncompressed(&self, total: u64) -> Result<(), LimitExceeded>;
    pub fn check_xml_bytes(&self, len: usize) -> Result<(), LimitExceeded>;
    pub fn check_xml_depth(&self, depth: usize) -> Result<(), LimitExceeded>;
    pub fn check_metadata_string(&self, value: &str) -> Result<(), LimitExceeded>;
    pub fn check_pages(&self, count: usize) -> Result<(), LimitExceeded>;
    pub fn check_page_tree_node(&self, visited: usize) -> Result<(), LimitExceeded>;
    pub fn check_page_tree_depth(&self, depth: usize) -> Result<(), LimitExceeded>;
    pub fn check_cover_png(&self, len: usize) -> Result<(), LimitExceeded>;
}
```

- [ ] **Step 1: Write the failing tests** in `sidecar/src/limits.rs` (`pub mod limits;` already added to `lib.rs` so the module resolves; the items under test do not exist yet)

```rust
//! Shared resource limits for hostile-document parsing (issue #83, R-1..R-4).

#[cfg(test)]
mod tests {
    use super::*;

    fn tight() -> ResourceLimits {
        ResourceLimits {
            max_source_file_bytes: 1_000,
            max_entries: 3,
            max_compressed_member_bytes: 1_000,
            max_decompressed_bytes: 1_000,
            max_total_uncompressed_bytes: 2_000,
            max_xml_bytes: 100,
            max_xml_depth: 4,
            max_metadata_string_bytes: 50,
            max_pages: 2,
            max_page_tree_nodes: 4,
            max_page_tree_depth: 3,
            max_cover_png_bytes: 100,
            max_parse_seconds: 0,
        }
    }

    #[test]
    fn source_file_over_limit_is_rejected() {
        assert_eq!(tight().check_source_file(1_001).unwrap_err().limit, "max_source_file_bytes");
    }

    #[test]
    fn entry_count_over_limit_is_rejected() {
        assert_eq!(tight().check_entries(4).unwrap_err().limit, "max_entries");
    }

    #[test]
    fn oversized_member_is_rejected() {
        assert_eq!(tight().check_member(1_001, 10).unwrap_err().limit, "max_compressed_member_bytes");
        assert_eq!(tight().check_member(10, 1_001).unwrap_err().limit, "max_decompressed_bytes");
    }

    #[test]
    fn total_uncompressed_over_limit_is_rejected() {
        assert_eq!(tight().check_total_uncompressed(2_001).unwrap_err().limit, "max_total_uncompressed_bytes");
    }

    #[test]
    fn oversized_xml_is_rejected() {
        assert_eq!(tight().check_xml_bytes(101).unwrap_err().limit, "max_xml_bytes");
    }

    #[test]
    fn deep_xml_is_rejected() {
        assert_eq!(tight().check_xml_depth(5).unwrap_err().limit, "max_xml_depth");
    }

    #[test]
    fn oversized_metadata_string_is_rejected() {
        assert_eq!(tight().check_metadata_string(&"x".repeat(51)).unwrap_err().limit, "max_metadata_string_bytes");
    }

    #[test]
    fn page_and_tree_budgets_are_rejected() {
        assert_eq!(tight().check_pages(3).unwrap_err().limit, "max_pages");
        assert_eq!(tight().check_page_tree_node(5).unwrap_err().limit, "max_page_tree_nodes");
        assert_eq!(tight().check_page_tree_depth(4).unwrap_err().limit, "max_page_tree_depth");
    }

    #[test]
    fn cover_png_over_limit_is_rejected() {
        assert_eq!(tight().check_cover_png(101).unwrap_err().limit, "max_cover_png_bytes");
    }

    #[test]
    fn read_bounded_rejects_a_stream_larger_than_the_cap() {
        let data = vec![0u8; 1_001];
        assert_eq!(read_bounded(&data[..], 1_000).unwrap_err().limit_ref(), "max_decompressed_bytes");
    }

    #[test]
    fn read_bounded_reads_a_stream_at_the_cap() {
        let data = vec![7u8; 1_000];
        assert_eq!(read_bounded(&data[..], 1_000).unwrap(), data);
    }

    #[test]
    fn expired_deadline_is_rejected() {
        let err = Deadline::start(&tight()).check().unwrap_err();
        assert_eq!(err.limit, "max_parse_seconds");
    }

    #[test]
    fn unexpired_deadline_passes() {
        let limits = ResourceLimits { max_parse_seconds: 60, ..tight() };
        Deadline::start(&limits).check().unwrap();
    }

    #[test]
    fn defaults_leave_room_for_real_books() {
        // A real book's realistic profile passes every DEFAULTS check.
        let d = DEFAULTS;
        d.check_source_file(50 << 20).unwrap();
        d.check_entries(5_000).unwrap();
        d.check_member(64 << 20, 128 << 20).unwrap();
        d.check_total_uncompressed(1_500 << 20).unwrap();
        d.check_xml_bytes(4 << 20).unwrap();
        d.check_xml_depth(64).unwrap();
        d.check_metadata_string(&"x".repeat(100_000)).unwrap();
        d.check_pages(50_000).unwrap();
        d.check_page_tree_node(500_000).unwrap();
        d.check_page_tree_depth(64).unwrap();
        d.check_cover_png(8 << 20).unwrap();
        assert_eq!(d.max_parse_seconds, 30);
    }
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml limits::`
Expected: compile failure naming missing `ResourceLimits` / `read_bounded` / `Deadline` — the tests fail because the feature is missing, not because of typos.

- [ ] **Step 3: Minimal implementation** (same file, above the test module; add `pub mod limits;` to `sidecar/src/lib.rs` after `pub mod error;`)

```rust
use std::io::Read;
use std::time::{Duration, Instant};

/// Quota table enforced by every parser entry point. `DEFAULTS` is the
/// documented baseline (docs/RESOURCE_LIMITS.md); the sandboxed document
/// worker (#81) and fuzzing (#88) reuse this module and override fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimits {
    /// Source file size on disk (EPUB or PDF).
    pub max_source_file_bytes: u64,
    /// ZIP entries per EPUB archive (R-1).
    pub max_entries: usize,
    /// Compressed size of a single ZIP member (R-1).
    pub max_compressed_member_bytes: u64,
    /// Uncompressed size of a single ZIP member (R-1): the declared size is
    /// checked before reading and the read itself is capped (`read_bounded`)
    /// so a lying header cannot bypass it.
    pub max_decompressed_bytes: u64,
    /// Sum of declared uncompressed sizes across one archive (R-1).
    pub max_total_uncompressed_bytes: u64,
    /// Size of one XML document (container.xml, OPF, nav, NCX) (R-1).
    pub max_xml_bytes: usize,
    /// XML nesting depth in OPF/container/nav/NCX documents (R-1).
    pub max_xml_depth: usize,
    /// One decoded metadata string (R-1/R-2).
    pub max_metadata_string_bytes: usize,
    /// PDF page count accepted during import/metadata extraction (R-2).
    pub max_pages: usize,
    /// Page-tree nodes visited during structural traversal (R-2).
    pub max_page_tree_nodes: usize,
    /// Page-tree depth (R-2 recursion bound).
    pub max_page_tree_depth: usize,
    /// Rasterized cover PNG size (R-2); output dimensions are fixed by the
    /// render config.
    pub max_cover_png_bytes: usize,
    /// Wall-clock parse budget (R-3). Parses are synchronous and
    /// single-threaded, so the deadline is also the CPU bound; memory is
    /// bounded by the size quotas.
    pub max_parse_seconds: u64,
}

/// Documented baseline (docs/RESOURCE_LIMITS.md). Generous against real
/// books, provisional until benchmarked (R-4 follow-up).
pub const DEFAULTS: ResourceLimits = ResourceLimits {
    max_source_file_bytes: 1 << 30,
    max_entries: 100_000,
    max_compressed_member_bytes: 256 << 20,
    max_decompressed_bytes: 512 << 20,
    max_total_uncompressed_bytes: 2 << 30,
    max_xml_bytes: 32 << 20,
    max_xml_depth: 512,
    max_metadata_string_bytes: 1 << 20,
    max_pages: 100_000,
    max_page_tree_nodes: 1_000_000,
    max_page_tree_depth: 128,
    max_cover_png_bytes: 16 << 20,
    max_parse_seconds: 30,
};

/// A tripped quota. Typed so callers can react to bounded-resource failure
/// without parsing error strings.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("resource limit exceeded: {limit} ({detail})")]
pub struct LimitExceeded {
    pub limit: &'static str,
    pub detail: String,
}

impl LimitExceeded {
    fn new(limit: &'static str, detail: impl std::fmt::Display) -> Self {
        Self { limit, detail: detail.to_string() }
    }

    #[cfg(test)]
    fn limit_ref(&self) -> &str {
        self.limit
    }
}

/// Wall-clock budget for one parse (R-3), checked between stages.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    started: Instant,
    budget: Duration,
}

impl Deadline {
    pub fn start(limits: &ResourceLimits) -> Self {
        Self { started: Instant::now(), budget: Duration::from_secs(limits.max_parse_seconds) }
    }

    pub fn check(&self) -> Result<(), LimitExceeded> {
        if self.started.elapsed() > self.budget {
            return Err(LimitExceeded::new(
                "max_parse_seconds",
                format!("{}s budget expired", self.budget.as_secs()),
            ));
        }
        Ok(())
    }
}

impl ResourceLimits {
    pub fn check_source_file(&self, bytes: u64) -> Result<(), LimitExceeded> {
        (bytes <= self.max_source_file_bytes).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_source_file_bytes", format!("{bytes} bytes"))
        })
    }

    pub fn check_entries(&self, count: usize) -> Result<(), LimitExceeded> {
        (count <= self.max_entries).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_entries", format!("{count} entries"))
        })
    }

    pub fn check_member(
        &self,
        compressed: u64,
        declared_uncompressed: u64,
    ) -> Result<(), LimitExceeded> {
        if compressed > self.max_compressed_member_bytes {
            return Err(LimitExceeded::new(
                "max_compressed_member_bytes",
                format!("{compressed} bytes"),
            ));
        }
        if declared_uncompressed > self.max_decompressed_bytes {
            return Err(LimitExceeded::new(
                "max_decompressed_bytes",
                format!("{declared_uncompressed} bytes declared"),
            ));
        }
        Ok(())
    }

    pub fn check_total_uncompressed(&self, total: u64) -> Result<(), LimitExceeded> {
        (total <= self.max_total_uncompressed_bytes).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_total_uncompressed_bytes", format!("{total} bytes"))
        })
    }

    pub fn check_xml_bytes(&self, len: usize) -> Result<(), LimitExceeded> {
        (len <= self.max_xml_bytes).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_xml_bytes", format!("{len} bytes"))
        })
    }

    pub fn check_xml_depth(&self, depth: usize) -> Result<(), LimitExceeded> {
        (depth <= self.max_xml_depth).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_xml_depth", format!("depth {depth}"))
        })
    }

    pub fn check_metadata_string(&self, value: &str) -> Result<(), LimitExceeded> {
        (value.len() <= self.max_metadata_string_bytes).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_metadata_string_bytes", format!("{} bytes", value.len()))
        })
    }

    pub fn check_pages(&self, count: usize) -> Result<(), LimitExceeded> {
        (count <= self.max_pages).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_pages", format!("{count} pages"))
        })
    }

    pub fn check_page_tree_node(&self, visited: usize) -> Result<(), LimitExceeded> {
        (visited <= self.max_page_tree_nodes).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_page_tree_nodes", format!("{visited} nodes"))
        })
    }

    pub fn check_page_tree_depth(&self, depth: usize) -> Result<(), LimitExceeded> {
        (depth <= self.max_page_tree_depth).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_page_tree_depth", format!("depth {depth}"))
        })
    }

    pub fn check_cover_png(&self, len: usize) -> Result<(), LimitExceeded> {
        (len <= self.max_cover_png_bytes).then_some(()).ok_or_else(|| {
            LimitExceeded::new("max_cover_png_bytes", format!("{len} bytes"))
        })
    }
}

/// Error of a capped read: a tripped cap is a limit error; the read itself
/// can still fail with plain IO.
#[derive(Debug, thiserror::Error)]
pub enum ReadBoundedError {
    #[error("{0}")]
    Limit(#[from] LimitExceeded),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Read `reader` to end with a hard cap on delivered bytes (R-3): a stream
/// that yields more than `max_bytes` — e.g. a ZIP header lying about its
/// uncompressed size — is a limit error, never an unbounded allocation.
pub fn read_bounded<R: Read>(reader: R, max_bytes: u64) -> Result<Vec<u8>, ReadBoundedError> {
    let mut buf = Vec::new();
    reader
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut buf)?;
    if buf.len() as u64 > max_bytes {
        return Err(LimitExceeded::new(
            "max_decompressed_bytes",
            format!("stream exceeded {max_bytes} bytes"),
        )
        .into());
    }
    Ok(buf)
}
```

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml limits::`
Expected: all `limits::` tests pass, pristine output.

- [ ] **Step 5: Commit** — `feat(rust): add resource limit table and enforcement helpers`

### Task 2: EPUB parse-path enforcement (source size, entries, totals, members, deadline)

**Files:**
- Modify: `sidecar/src/epub/mod.rs` (add `EpubError::Limit` + `From<ReadBoundedError>`), `sidecar/src/epub/parser.rs` (entry-point limits), `sidecar/src/epub/session.rs` (entry-point limits), `sidecar/src/epub/writer.rs` (pass `DEFAULTS`), `sidecar/src/services/reader.rs` and `sidecar/src/services/library_scanner.rs` (pass `DEFAULTS`), `sidecar/tests/epub_corpus.rs`, `sidecar/tests/extended_epub.rs` (pass `DEFAULTS`)
- Test: `sidecar/src/epub/parser.rs` `mod tests`

**Interfaces changed:**

```rust
pub fn parse_epub(path: &Path, limits: &ResourceLimits) -> Result<EpubBook, EpubError>;
pub fn read_file_properties(path: &Path, limits: &ResourceLimits) -> Result<Vec<(String, String)>, EpubError>;
pub fn build_session(path: &Path, limits: &ResourceLimits) -> Result<EpubReadingSession, EpubError>;
pub fn read_member(path: &Path, member: &str, limits: &ResourceLimits) -> Result<Option<Vec<u8>>, EpubError>;
// read_entry/read_mimetype gain a limits parameter (pub(crate)/private)
// parse_epub stays the only signature seen outside the crate; every external
// caller passes &ResourceLimits::DEFAULTS.
```

- [ ] **Step 1: Write the failing tests** in `parser.rs` `mod tests` (uses existing `write_zip` helper and the `OPF`/container constants already there)

```rust
    fn limits(max_source_file_bytes: u64) -> ResourceLimits {
        ResourceLimits { max_source_file_bytes, ..ResourceLimits::DEFAULTS }
    }

    #[test]
    fn parse_epub_rejects_oversized_source_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("huge.epub");
        std::fs::write(&path, vec![0u8; 200]).unwrap();
        let err = parse_epub(&path, &limits(100)).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_too_many_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("many.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", OPF.as_bytes()),
                ("filler.bin", &[0u8; 8]),
            ],
        );
        let tight = ResourceLimits { max_entries: 3, ..ResourceLimits::DEFAULTS };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_decompression_bomb_cover() {
        // 4 MiB of zeros deflate to a few KiB: a real high-ratio member. The
        // declared size trips the per-member cap before any decompression.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bomb.epub");
        let cover_opf = OPF.replace(
            r#"href="c1.xhtml""#,
            r#"href="cover.png" media-type="image/png" properties="cover-image""#,
        );
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", cover_opf.as_bytes()),
                ("cover.png", &vec![0u8; 4 << 20]),
            ],
        );
        let tight = ResourceLimits { max_decompressed_bytes: 1_024, ..ResourceLimits::DEFAULTS };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_oversized_total_uncompressed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("total.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", OPF.as_bytes()),
                ("filler.bin", &vec![0u8; 3 << 10]),
            ],
        );
        let tight = ResourceLimits { max_total_uncompressed_bytes: 2_000, ..ResourceLimits::DEFAULTS };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_expired_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("slow.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", OPF.as_bytes()),
            ],
        );
        let tight = ResourceLimits { max_parse_seconds: 0, ..ResourceLimits::DEFAULTS };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_accepts_fixture_under_default_limits() {
        parse_epub(&fixture_epub(), &ResourceLimits::DEFAULTS).unwrap();
    }

    #[test]
    fn read_member_rejects_oversized_member() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("member.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("big.bin", &vec![0u8; 4 << 10]),
            ],
        );
        let tight = ResourceLimits { max_decompressed_bytes: 1_024, ..ResourceLimits::DEFAULTS };
        let err = read_member(&path, "big.bin", &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }
```

(Imports: `use crate::limits::{LimitExceeded, ResourceLimits};` in the test module.)

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml epub::parser`
Expected: compile failure — `parse_epub` takes 1 argument, limits tests reference the new signatures.

- [ ] **Step 3: Implement** in `parser.rs` (and the shared plumbing):

`epub/mod.rs`: add the error variants and conversion:

```rust
    #[error("{0}")]
    Limit(#[from] crate::limits::LimitExceeded),
```

plus

```rust
impl From<crate::limits::ReadBoundedError> for EpubError {
    fn from(err: crate::limits::ReadBoundedError) -> Self {
        match err {
            crate::limits::ReadBoundedError::Limit(limit) => EpubError::Limit(limit),
            crate::limits::ReadBoundedError::Io(io) => EpubError::Io(io),
        }
    }
}
```

`parser.rs`:

```rust
use crate::limits::{read_bounded, Deadline, ResourceLimits};

fn source_len(path: &Path) -> Result<u64, EpubError> {
    Ok(std::fs::metadata(path)?.len())
}

/// Cheap central-directory pre-scan (R-1): entry count and the sum of
/// declared uncompressed sizes, before any member is decompressed.
fn check_archive_totals<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    limits: &ResourceLimits,
) -> Result<(), EpubError> {
    limits.check_entries(zip.len())?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        total += entry.size();
    }
    limits.check_total_uncompressed(total)?;
    Ok(())
}

pub fn parse_epub(path: &Path, limits: &ResourceLimits) -> Result<EpubBook, EpubError> {
    limits.check_source_file(source_len(path)?)?;
    let deadline = Deadline::start(limits);
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(BufReader::new(file))?;
    check_archive_totals(&mut zip, limits)?;
    deadline.check()?;

    read_mimetype(&mut zip, limits)?;
    deadline.check()?;

    let container = read_entry(&mut zip, "META-INF/container.xml", limits)?
        .ok_or(EpubError::MissingContainer)?;
    let opf_path = parse_container_xml(&container)?;
    deadline.check()?;

    let opf_bytes =
        read_entry(&mut zip, &opf_path, limits)?.ok_or_else(|| EpubError::MissingOpf(opf_path.clone()))?;
    let opf_xml = String::from_utf8(opf_bytes).map_err(|e| EpubError::OpfXml(e.to_string()))?;
    let package = parse_opf(&opf_xml)?;
    deadline.check()?;

    let spine = resolve_spine(&package)?;
    let cover = extract_cover(&package, &opf_path, &mut zip, limits)?;
    deadline.check()?;

    Ok(EpubBook { metadata: package.metadata, spine, cover })
}
```

`read_file_properties` delegates: `let metadata = parse_epub(path, limits)?.metadata;` (signature gains `limits`).

`read_mimetype` (both `parser.rs` and `session.rs` copies) gains `limits` and bounds the value read:

```rust
fn read_mimetype<R: Read + Seek>(zip: &mut ZipArchive<R>, limits: &ResourceLimits) -> Result<(), EpubError> {
    if zip.is_empty() {
        return Err(EpubError::MissingMimetype);
    }
    let mut first = zip.by_index(0)?;
    if first.name() != "mimetype" {
        return Err(EpubError::MissingMimetype);
    }
    limits.check_member(first.compressed_size(), first.size())?;
    let mut value = String::new();
    first
        .take(limits.max_decompressed_bytes.saturating_add(1))
        .read_to_string(&mut value)?;
    if value.len() as u64 > limits.max_decompressed_bytes {
        return Err(EpubError::Limit(
            crate::limits::LimitExceeded {
                limit: "max_decompressed_bytes",
                detail: "mimetype member over cap".to_string(),
            }
            .into(),
        ));
    }
    if value != "application/epub+zip" {
        return Err(EpubError::InvalidMimetype);
    }
    Ok(())
}
```

`read_entry` gains `limits` and routes the actual read through the cap:

```rust
pub(crate) fn read_entry<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    limits: &ResourceLimits,
) -> Result<Option<Vec<u8>>, EpubError> {
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        if file.is_dir() {
            continue;
        }
        if file.name() == name {
            limits.check_member(file.compressed_size(), file.size())?;
            let data = read_bounded(file.by_ref(), limits.max_decompressed_bytes)?;
            return Ok(Some(data));
        }
    }
    Ok(None)
}
```

`extract_cover` gains `limits` and forwards to `read_entry`.

`session.rs`: `build_session(path, limits)` mirrors `parse_epub` (source size, deadline, `check_archive_totals`, member-capped reads via the updated `read_entry`, `read_mimetype(&mut zip, limits)`); `read_member(path, member, limits)` checks source size then calls `read_entry(zip, &member, limits)`; the private session callers (`parse_toc`, `build_positions_json`) thread `limits` through. Session tests in `session.rs` update mechanically to pass `&ResourceLimits::DEFAULTS` (import `crate::limits::ResourceLimits`).

Mechanical call-site updates (pass `&ResourceLimits::DEFAULTS`, import `tuxbooks_lib::limits::ResourceLimits` / `crate::limits::ResourceLimits` where needed):
- `epub/writer.rs:33-36` — `read_entry(&mut archive, ..., &DEFAULTS)` (two calls), `parse_container_xml` unchanged in this task
- `services/reader.rs:29,42` — `build_session(path, &DEFAULTS)`, `read_member(path, resource, &DEFAULTS)`
- `services/library_scanner.rs:62` — `parse_epub(path, &DEFAULTS)`
- `epub/mod.rs` tests, `epub/parser.rs` existing tests, `epub/session.rs` tests, `epub/writer.rs:322,385` tests — pass `&ResourceLimits::DEFAULTS`
- `tests/epub_corpus.rs:62,89`, `tests/extended_epub.rs:69` — `parse_epub(&path, &ResourceLimits::DEFAULTS)`

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml`
Expected: full suite passes; the new tests pass; pristine output.

- [ ] **Step 5: Commit** — `feat(rust): enforce resource limits on EPUB parse paths`

### Task 3: EPUB XML bounds (size, depth, metadata strings)

**Files:**
- Modify: `sidecar/src/epub/metadata.rs` (`parse_opf`), `sidecar/src/epub/parser.rs` (`parse_container_xml`), `sidecar/src/epub/session.rs` (`parse_nav_document`, `parse_ncx_document`), `sidecar/src/epub/writer.rs` (`parse_container_xml` caller)
- Test: `sidecar/src/epub/parser.rs` + `sidecar/src/epub/metadata.rs` test modules

**Interfaces changed:**

```rust
pub fn parse_opf(xml: &str, limits: &ResourceLimits) -> Result<OpfPackage, EpubError>;
pub(crate) fn parse_container_xml(bytes: &[u8], limits: &ResourceLimits) -> Result<String, EpubError>;
// parse_nav_document / parse_ncx_document gain limits (private)
```

- [ ] **Step 1: Write the failing tests**

In `metadata.rs` tests:

```rust
    #[test]
    fn parse_opf_rejects_deeply_nested_xml() {
        let nest_open: String = "<d>".repeat(600);
        let nest_close: String = "</d>".repeat(600);
        let opf = format!(
            r#"<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{nest_open}<dc:title>Deep</dc:title>{nest_close}</metadata></package>"#
        );
        let err = parse_opf(&opf, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_opf_rejects_oversized_metadata_string() {
        let title = "x".repeat(2 << 20);
        let opf = format!(
            r#"<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{title}</dc:title></metadata></package>"#
        );
        let err = parse_opf(&opf, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }
```

In `parser.rs` tests:

```rust
    #[test]
    fn parse_epub_rejects_oversized_opf() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bigopf.epub");
        let mut opf = OPF.to_string();
        opf.push_str(&format!("<!-- {} -->", "x".repeat(4 << 10)));
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", opf.as_bytes()),
            ],
        );
        let tight = ResourceLimits { max_xml_bytes: 100, ..ResourceLimits::DEFAULTS };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml epub`
Expected: compile failure — `parse_opf` takes 1 argument.

- [ ] **Step 3: Implement**

`metadata.rs` `parse_opf(xml, limits)`: at entry `limits.check_xml_bytes(xml.len())?;`. Track `let mut depth = 0usize;` — on every `Ok(Event::Start(..))`: `depth += 1; limits.check_xml_depth(depth)?;` (increment before the section match), on every `Ok(Event::End(..))`: `depth = depth.saturating_sub(1);`. In the `End` branch where a non-empty `value` is about to be stored (before the `match target`): `limits.check_metadata_string(&value)?;`.

`parser.rs` `parse_container_xml(bytes, limits)`: `limits.check_xml_bytes(bytes.len())?;` at entry; depth counter same pattern around the loop.

`session.rs` `parse_nav_document(xml, limits)` / `parse_ncx_document(xml, limits)`: `limits.check_xml_bytes(xml.len())?;` at entry; before each `stack.push(..)` (nav) / `open_points.push(..)` (ncx): `limits.check_xml_depth(stack.len() + 1)?;` / `limits.check_xml_depth(open_points.len() + 1)?;`. `parse_toc` threads `limits` in.

`writer.rs` and `parser.rs`/`session.rs` callers of `parse_container_xml`/`parse_opf` pass their `limits` through (writer: `&ResourceLimits::DEFAULTS`). Existing `metadata.rs` tests pass `&ResourceLimits::DEFAULTS`.

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml`
Expected: full suite passes, pristine output.

- [ ] **Step 5: Commit** — `feat(rust): bound EPUB XML documents and metadata strings`

### Task 4: PDF limits (source size, page tree, strings, deadline, cover render)

**Files:**
- Modify: `sidecar/src/pdf/mod.rs` (add `PdfError::Limit`), `sidecar/src/pdf/parser.rs`, `sidecar/src/pdf/render.rs`, `sidecar/src/services/library_scanner.rs`, `sidecar/src/services/book_importer.rs`, `sidecar/src/services/metadata.rs`, `sidecar/src/pdf/writer.rs` tests
- Test: `sidecar/src/pdf/parser.rs` + `sidecar/src/pdf/render.rs` test modules

**Interfaces changed:**

```rust
pub fn parse_pdf(path: &Path, limits: &ResourceLimits) -> Result<PdfBook, PdfError>;
pub fn read_file_properties(path: &Path, limits: &ResourceLimits) -> Result<Vec<(String, String)>, PdfError>;
pub fn render_first_page_cover(path: &Path, library_dirs: &[PathBuf], limits: &ResourceLimits) -> Result<Option<Vec<u8>>, PdfError>;
```

- [ ] **Step 1: Write the failing tests** in `pdf/parser.rs` tests (plus a `tests_support::assemble_pdf(objects) -> Vec<u8>` extraction from `build_pdf` so page-tree fixtures can be built; `build_pdf` becomes a thin wrapper)

```rust
    /// A structurally valid PDF whose page tree holds `count` leaf pages
    /// under one root (flat Kids array).
    fn build_pdf_with_pages(count: usize) -> Vec<u8> {
        let kids: Vec<String> = (3..(count as u32) + 3).map(|id| format!("{id} 0 R")).collect();
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!("<< /Type /Pages /Kids [{}] /Count {count} >>", kids.join(" ")),
        ];
        for _ in 0..count {
            objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string());
        }
        tests_support::assemble_pdf(objects)
    }

    /// A structurally valid PDF whose page tree is a chain `depth` levels
    /// deep ending in one page leaf.
    fn build_pdf_with_deep_tree(depth: usize) -> Vec<u8> {
        // 1 = catalog, 2 = root pages node, 3.. = chained nodes, last kid = page leaf
        let mut objects = vec!["<< /Type /Catalog /Pages 2 0 R >>".to_string()];
        for node in 2..(depth as u32) + 2 {
            let next = if node == (depth as u32) + 1 { (depth as u32) + 3 } else { node + 1 };
            objects.push(format!("<< /Type /Pages /Kids [{next} 0 R] >>"));
        }
        objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string());
        tests_support::assemble_pdf(objects)
    }
```

Tests:

```rust
    #[test]
    fn parse_pdf_rejects_oversized_source_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("huge.pdf");
        std::fs::write(&path, vec![0u8; 200]).unwrap();
        let tight = ResourceLimits { max_source_file_bytes: 100, ..ResourceLimits::DEFAULTS };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_too_many_pages() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("many.pdf");
        std::fs::write(&path, build_pdf_with_pages(3)).unwrap();
        let tight = ResourceLimits { max_pages: 2, ..ResourceLimits::DEFAULTS };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_page_tree_over_node_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nodes.pdf");
        std::fs::write(&path, build_pdf_with_deep_tree(8)).unwrap();
        let tight = ResourceLimits { max_page_tree_nodes: 3, ..ResourceLimits::DEFAULTS };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_deep_page_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("deep.pdf");
        std::fs::write(&path, build_pdf_with_deep_tree(8)).unwrap();
        let tight = ResourceLimits { max_page_tree_depth: 3, ..ResourceLimits::DEFAULTS };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_oversized_metadata_string() {
        let tmp = tempfile::tempdir().unwrap();
        let title: String = "t".repeat(4 << 10);
        let path = tmp.path().join("longtitle.pdf");
        std::fs::write(&path, tests_support::build_pdf(&[("Title", &title)])).unwrap();
        let tight = ResourceLimits { max_metadata_string_bytes: 100, ..ResourceLimits::DEFAULTS };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_expired_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fixture.pdf");
        std::fs::write(&path, tests_support::build_pdf(&[("Title", "x")])).unwrap();
        let tight = ResourceLimits { max_parse_seconds: 0, ..ResourceLimits::DEFAULTS };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_accepts_fixture_under_default_limits() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/books/minimal.pdf");
        parse_pdf(&fixture, &ResourceLimits::DEFAULTS).unwrap();
    }
```

In `render.rs` tests (both PDFium-gated like the existing ones):

```rust
    #[test]
    fn render_rejects_expired_deadline() {
        if !pdfium_is_available() { eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)"); return; }
        let tight = ResourceLimits { max_parse_seconds: 0, ..ResourceLimits::DEFAULTS };
        let err = render_first_page_cover(&fixture("minimal.pdf"), &library_dirs(), &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn render_rejects_oversized_cover_png() {
        if !pdfium_is_available() { eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)"); return; }
        let tight = ResourceLimits { max_cover_png_bytes: 1, ..ResourceLimits::DEFAULTS };
        let err = render_first_page_cover(&fixture("minimal.pdf"), &library_dirs(), &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml pdf`
Expected: compile failure — `parse_pdf` takes 1 argument.

- [ ] **Step 3: Implement**

`pdf/mod.rs`:

```rust
    #[error("{0}")]
    Limit(#[from] crate::limits::LimitExceeded),
```

`pdf/parser.rs`:

```rust
use crate::limits::{Deadline, ResourceLimits};

pub fn parse_pdf(path: &Path, limits: &ResourceLimits) -> Result<PdfBook, PdfError> {
    limits.check_source_file(std::fs::metadata(path)?.len())?;
    let deadline = Deadline::start(limits);
    deadline.check()?;
    let doc = Document::load(path).map_err(|err| PdfError::Parse(err.to_string()))?;
    deadline.check()?;
    count_pages_bounded(&doc, limits)?;
    deadline.check()?;

    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|obj| resolve(&doc, obj))
        .and_then(|obj| obj.as_dict().ok().cloned());

    let read = |key: &[u8]| -> Result<Option<String>, PdfError> {
        let value = info
            .as_ref()
            .and_then(|dict| dict.get(key).ok())
            .and_then(|obj| resolve(&doc, obj))
            .and_then(|obj| obj.as_str().ok())
            .map(decode_pdf_string)
            .filter(|value| !value.is_empty());
        match value {
            Some(value) => {
                limits.check_metadata_string(&value)?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    };

    Ok(PdfBook {
        metadata: PdfMetadata {
            title: read(b"Title")?.unwrap_or_else(|| fallback_title(path)),
            author: read(b"Author")?,
            description: read(b"Subject")?,
        },
    })
}
```

`read_file_properties` mirrors this (source size, deadline before/after load + walk, `read(...)?` per key, plus the date fields unchanged).

```rust
/// Walk the page tree with explicit budgets (R-2): node visits and depth are
/// capped, the leaf count must fit `max_pages`, and the walk stops early once
/// the page budget is exceeded. The walk is iterative, so no PDF structure
/// can drive recursion.
fn count_pages_bounded(doc: &Document, limits: &ResourceLimits) -> Result<usize, PdfError> {
    let catalog = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|obj| resolve(doc, obj))
        .and_then(|obj| obj.as_dict().ok())
        .ok_or_else(|| PdfError::Parse("missing document catalog".into()))?;
    let Some(root) = catalog
        .get(b"Pages")
        .ok()
        .and_then(|obj| resolve(doc, obj))
        .and_then(|obj| obj.as_dict().ok())
    else {
        return Ok(0);
    };

    let mut visited = 0usize;
    let mut pages = 0usize;
    let mut stack: Vec<(&lopdf::Dictionary, usize)> = vec![(root, 1)];
    while let Some((dict, depth)) = stack.pop() {
        visited += 1;
        limits.check_page_tree_node(visited)?;
        limits.check_page_tree_depth(depth)?;
        match dict.get(b"Type").ok().and_then(|obj| obj.as_name().ok()) {
            Some(b"Page") => {
                pages += 1;
                limits.check_pages(pages)?;
            }
            _ => {
                if let Ok(kids) = dict.get(b"Kids").and_then(|obj| obj.as_array()) {
                    for kid in kids {
                        if let Some(kid_dict) =
                            resolve(doc, kid).and_then(|obj| obj.as_dict().ok())
                        {
                            stack.push((kid_dict, depth + 1));
                        }
                    }
                }
            }
        }
    }
    Ok(pages)
}
```

`pdf/render.rs` `render_first_page_cover(path, library_dirs, limits)`: after taking `RENDER_LOCK`, `limits.check_source_file(std::fs::metadata(path)?.len())?;`, `Deadline::start(limits).check()?;` before `load_pdf_from_file`, `deadline.check()?;` before the render call (the native render itself is uninterruptible; it is bounded instead by the source-size cap and the fixed 600 px target), and after encoding `limits.check_cover_png(png.len())?;` before returning.

Mechanical call-site updates (pass `&ResourceLimits::DEFAULTS`): `services/library_scanner.rs:60` (`parse_pdf`), `services/book_importer.rs:309` (`render_first_page_cover`), `services/metadata.rs:133` (`pdf::read_file_properties`), `pdf/writer.rs` tests (`parse_pdf`), `pdf/parser.rs`/`render.rs` existing tests, `services/metadata.rs:1498,1520` tests.

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml`
Expected: full suite passes, pristine output.

- [ ] **Step 5: Commit** — `feat(rust): enforce resource limits on PDF parse paths`

### Task 5: Documentation and full verification

**Files:**
- Create: `docs/RESOURCE_LIMITS.md`
- Modify: `docs/ARCHITECTURE.md` (module table row + doc link), `AGENTS.md` (working-documents list line)

- [ ] **Step 1:** Write `docs/RESOURCE_LIMITS.md`: the DEFAULTS table (field, value, provisional rationale), the enforcement map (same table as this plan, updated to final names), the error contract (`LimitExceeded` -> `EpubError::Limit`/`PdfError::Limit` -> IPC string), the R-3 interpretation (wall-clock deadline = CPU bound for the synchronous parser; memory via size quotas; per-parse CPU accounting moves to the killable worker), and the R-4 note: values are provisional; benchmarking real corpora and tuning is follow-up work.
- [ ] **Step 2:** Add the module-table row `limits/ | std, thiserror | runtime crates` to `docs/ARCHITECTURE.md` and a `docs/RESOURCE_LIMITS.md` bullet to the AGENTS.md working-documents list. PERFORMANCE.md/DATABASE.md need no change: parse limits do not touch reader budgets (PERF-* are renderer-side) or the schema; note this in the report.
- [ ] **Step 3:** `just format` (Rust touched), then `just test-rust`, then `just check`.
- [ ] **Step 4:** Commit — `docs: document parser resource limits`

## Self-review

- Spec coverage: every R-1/R-2 quota family has a field, an enforcement point, a tripping test, and a passing normal book; R-3 is deadline + memory caps with the CPU interpretation documented; R-4 is the documentation task plus named tests. Acceptance criteria: typed errors everywhere, no panic paths added, tests per limit, normal fixture passes.
- Placeholder scan: all code blocks are complete; no TBD/TODO steps.
- Type consistency: `ResourceLimits`/`DEFAULTS`/`LimitExceeded`/`Deadline`/`read_bounded` names match across tasks; parse signatures take `&ResourceLimits` consistently; external callers all pass `DEFAULTS`.
