//! Shared resource limits for hostile-document parsing (issue #83, R-1..R-4).
//!
//! Every EPUB/PDF parse entry point enforces this quota table before and
//! while touching attacker-controlled bytes: a hostile file must fail fast
//! with a typed bounded-resource error instead of hanging, allocating
//! indefinitely, or crashing the sidecar. The sandboxed document worker
//! (#81) and fuzzing (#88) reuse this module; values are provisional until
//! benchmarked (R-4 follow-up), see docs/RESOURCE_LIMITS.md.

use std::io::Read;
use std::time::{Duration, Instant};

/// Quota table enforced by every parser entry point. `DEFAULTS` is the
/// documented baseline; tests and the future worker override fields freely.
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
impl ResourceLimits {
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
}

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
        Self {
            limit,
            detail: detail.to_string(),
        }
    }
}

/// Wall-clock budget for one parse (R-3), checked between parsing stages.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    started: Instant,
    budget: Duration,
}

impl Deadline {
    pub fn start(limits: &ResourceLimits) -> Self {
        Self {
            started: Instant::now(),
            budget: Duration::from_secs(limits.max_parse_seconds),
        }
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
        (bytes <= self.max_source_file_bytes)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_source_file_bytes", format!("{bytes} bytes")))
    }

    pub fn check_entries(&self, count: usize) -> Result<(), LimitExceeded> {
        (count <= self.max_entries)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_entries", format!("{count} entries")))
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
        (total <= self.max_total_uncompressed_bytes)
            .then_some(())
            .ok_or_else(|| {
                LimitExceeded::new("max_total_uncompressed_bytes", format!("{total} bytes"))
            })
    }

    pub fn check_xml_bytes(&self, len: usize) -> Result<(), LimitExceeded> {
        (len <= self.max_xml_bytes)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_xml_bytes", format!("{len} bytes")))
    }

    pub fn check_xml_depth(&self, depth: usize) -> Result<(), LimitExceeded> {
        (depth <= self.max_xml_depth)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_xml_depth", format!("depth {depth}")))
    }

    pub fn check_metadata_string(&self, value: &str) -> Result<(), LimitExceeded> {
        (value.len() <= self.max_metadata_string_bytes)
            .then_some(())
            .ok_or_else(|| {
                LimitExceeded::new(
                    "max_metadata_string_bytes",
                    format!("{} bytes", value.len()),
                )
            })
    }

    pub fn check_pages(&self, count: usize) -> Result<(), LimitExceeded> {
        (count <= self.max_pages)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_pages", format!("{count} pages")))
    }

    pub fn check_page_tree_node(&self, visited: usize) -> Result<(), LimitExceeded> {
        (visited <= self.max_page_tree_nodes)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_page_tree_nodes", format!("{visited} nodes")))
    }

    pub fn check_page_tree_depth(&self, depth: usize) -> Result<(), LimitExceeded> {
        (depth <= self.max_page_tree_depth)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_page_tree_depth", format!("depth {depth}")))
    }

    pub fn check_cover_png(&self, len: usize) -> Result<(), LimitExceeded> {
        (len <= self.max_cover_png_bytes)
            .then_some(())
            .ok_or_else(|| LimitExceeded::new("max_cover_png_bytes", format!("{len} bytes")))
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
        assert_eq!(
            tight().check_source_file(1_001).unwrap_err().limit,
            "max_source_file_bytes"
        );
    }

    #[test]
    fn entry_count_over_limit_is_rejected() {
        assert_eq!(tight().check_entries(4).unwrap_err().limit, "max_entries");
    }

    #[test]
    fn oversized_member_is_rejected() {
        assert_eq!(
            tight().check_member(1_001, 10).unwrap_err().limit,
            "max_compressed_member_bytes"
        );
        assert_eq!(
            tight().check_member(10, 1_001).unwrap_err().limit,
            "max_decompressed_bytes"
        );
    }

    #[test]
    fn total_uncompressed_over_limit_is_rejected() {
        assert_eq!(
            tight().check_total_uncompressed(2_001).unwrap_err().limit,
            "max_total_uncompressed_bytes"
        );
    }

    #[test]
    fn oversized_xml_is_rejected() {
        assert_eq!(
            tight().check_xml_bytes(101).unwrap_err().limit,
            "max_xml_bytes"
        );
    }

    #[test]
    fn deep_xml_is_rejected() {
        assert_eq!(
            tight().check_xml_depth(5).unwrap_err().limit,
            "max_xml_depth"
        );
    }

    #[test]
    fn oversized_metadata_string_is_rejected() {
        let err = tight().check_metadata_string(&"x".repeat(51)).unwrap_err();
        assert_eq!(err.limit, "max_metadata_string_bytes");
    }

    #[test]
    fn page_and_tree_budgets_are_rejected() {
        assert_eq!(tight().check_pages(3).unwrap_err().limit, "max_pages");
        assert_eq!(
            tight().check_page_tree_node(5).unwrap_err().limit,
            "max_page_tree_nodes"
        );
        assert_eq!(
            tight().check_page_tree_depth(4).unwrap_err().limit,
            "max_page_tree_depth"
        );
    }

    #[test]
    fn cover_png_over_limit_is_rejected() {
        assert_eq!(
            tight().check_cover_png(101).unwrap_err().limit,
            "max_cover_png_bytes"
        );
    }

    #[test]
    fn read_bounded_rejects_a_stream_larger_than_the_cap() {
        let data = vec![0u8; 1_001];
        match read_bounded(&data[..], 1_000).unwrap_err() {
            ReadBoundedError::Limit(err) => assert_eq!(err.limit, "max_decompressed_bytes"),
            other => panic!("expected limit error, got: {other:?}"),
        }
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
        let limits = ResourceLimits {
            max_parse_seconds: 60,
            ..tight()
        };
        Deadline::start(&limits).check().unwrap();
    }

    #[test]
    fn defaults_leave_room_for_real_books() {
        let d = ResourceLimits::DEFAULTS;
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
