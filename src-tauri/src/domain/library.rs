use serde::Serialize;

/// Aggregate counts for the whole library. Returned by the `get_library_stats` IPC command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub book_count: i64,
    pub collection_count: i64,
}
