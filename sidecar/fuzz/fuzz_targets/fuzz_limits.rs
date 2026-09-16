use tuxbooks_lib::limits::ResourceLimits;

/// Quota table for fuzz runs: the production DEFAULTS with tighter byte
/// caps, so a hostile archive or PDF trips its quota within microseconds
/// instead of inflating toward the 512 MiB production ceiling. Keeps
/// libFuzzer execs fast and hang-free (docs/TESTING.md "Fuzzing").
pub fn limits() -> ResourceLimits {
    ResourceLimits {
        max_source_file_bytes: 1 << 20,
        max_entries: 512,
        max_compressed_member_bytes: 1 << 20,
        max_decompressed_bytes: 1 << 20,
        max_total_uncompressed_bytes: 4 << 20,
        max_stream_decompressed_bytes: 1 << 20,
        max_xml_bytes: 256 << 10,
        max_xml_depth: 256,
        max_metadata_string_bytes: 64 << 10,
        max_pages: 10_000,
        max_page_tree_nodes: 100_000,
        max_page_tree_depth: 128,
        max_cover_png_bytes: 1 << 20,
        max_parse_seconds: 30,
    }
}
