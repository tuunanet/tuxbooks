use serde::Serialize;

/// Aggregate counts for the whole library. Returned by the `get_library_stats` IPC command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub book_count: i64,
    pub collection_count: i64,
}

/// Book count and total file bytes under one watched library location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLocationStat {
    pub id: i64,
    pub path: String,
    pub added_at: String,
    pub book_count: i64,
    pub total_bytes: i64,
}

/// Row counts for the catalog tables shown on the Data tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCounts {
    pub books: i64,
    pub authors: i64,
    pub collections: i64,
    pub annotations: i64,
    pub reading_progress: i64,
}

/// The storage read model for the Data tab: per-location book stats, the
/// library's total book bytes, and the catalog row counts. Returned by the
/// `get_storage_stats` IPC command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub locations: Vec<LibraryLocationStat>,
    pub book_total_bytes: i64,
    pub catalog: CatalogCounts,
}

/// Where a broken database was found and where it was moved, set once at
/// startup when the service quarantined it. Returned by the
/// `get_startup_recovery` IPC command so main can name the file in the
/// recovery dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupRecovery {
    pub from: String,
    pub to: String,
}
