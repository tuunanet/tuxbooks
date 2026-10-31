//! The user-initiated support snapshot (docs/SYNC.md, "Copy diagnostics").
//!
//! Collecting is read-only and happens only when the renderer asks: nothing is
//! written to disk, no pass runs, and no state is repaired. The payload names
//! the health of sync, the failed hashes, the open conflicts, the recent
//! identity merges, and the schema versions support needs.
//!
//! It deliberately never carries book contents, annotation text, notes, the
//! kept or discarded values of a conflict, cover bytes, or device tokens.
//! Paths, ids, titles, kinds, and times are included because support already
//! sees the first two in Settings and needs the rest to recognise a report.

use std::path::Path;

use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppError;

use super::clock::now_rfc3339;
use super::conflict::BOOK_UID_EXPR;
use super::engine::{SyncState, SyncStatus};
use super::model::OP_SCHEMA;
use super::store;

/// How many rows each list carries. The payload has to stay pasteable, so a
/// large library reports the newest items rather than everything.
const LIST_LIMIT: i64 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDiagnostics {
    pub generated_at: String,
    pub sync: DiagnosticsSync,
    pub hash_failed: Vec<HashFailedBook>,
    pub open_conflicts: Vec<DiagnosticConflict>,
    pub recent_merges: RecentMerges,
    pub versions: DiagnosticVersions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSync {
    pub enabled: bool,
    pub state: SyncState,
    pub folder: Option<String>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub counts: DiagnosticsCounts,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsCounts {
    pub pending_local: i64,
    pub waiting_books: i64,
    pub issues: i64,
    pub trash: i64,
    pub conflicts: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashFailedBook {
    pub book_id: i64,
    pub title: String,
    pub path: String,
    pub attempts: i64,
    pub retry_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticConflict {
    pub id: i64,
    pub kind: String,
    pub field: String,
    pub book_title: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMerges {
    pub books: Vec<BookMerge>,
    pub entities: Vec<EntityMerge>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMerge {
    pub loser: String,
    pub winner: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityMerge {
    pub kind: String,
    pub loser: String,
    pub winner: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticVersions {
    /// The sync folder's `library.json` schema, when the marker is readable.
    pub library_marker: Option<u32>,
    pub op_schema: u32,
    pub db_migration: i64,
}

/// Build the snapshot from the live sync status plus local tables. A missing
/// sync service, a disconnected folder, an unreadable marker, or an absent
/// database row must never fail the copy: the user needs the rest of the
/// report most.
pub async fn collect(
    pool: &SqlitePool,
    status: Option<&SyncStatus>,
) -> Result<SyncDiagnostics, AppError> {
    // enabled and state come from the engine, not from stored meta: a pass
    // that is running right now must report "syncing", not a stale "idle".
    let enabled = status.is_some_and(|status| status.enabled);
    let state = match status {
        Some(status) if enabled => status.state,
        _ => SyncState::Disabled,
    };
    let folder = status.and_then(|status| status.folder.clone());
    let last_sync_at = status.and_then(|status| status.last_sync_at.clone());
    let last_error = status.and_then(|status| status.last_error.clone());
    let counts = match status {
        Some(status) if enabled => DiagnosticsCounts {
            pending_local: status.pending_local,
            waiting_books: status.waiting_books,
            issues: status.issues,
            trash: status.trash,
            conflicts: status.conflicts,
        },
        _ => DiagnosticsCounts::default(),
    };

    let hash_failed = hash_failed(pool).await?;
    let open_conflicts = if enabled {
        open_conflicts(pool).await?
    } else {
        Vec::new()
    };
    let recent_merges = if enabled {
        recent_merges(pool).await?
    } else {
        RecentMerges::default()
    };
    let db_migration: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
            .fetch_one(pool)
            .await?;
    let library_marker = folder
        .as_deref()
        .and_then(|folder| store::library_schema(Path::new(folder)));

    Ok(SyncDiagnostics {
        generated_at: now_rfc3339(),
        sync: DiagnosticsSync {
            enabled,
            state,
            folder,
            last_sync_at,
            last_error,
            counts,
        },
        hash_failed,
        open_conflicts,
        recent_merges,
        versions: DiagnosticVersions {
            library_marker,
            op_schema: OP_SCHEMA,
            db_migration,
        },
    })
}

async fn hash_failed(pool: &SqlitePool) -> Result<Vec<HashFailedBook>, AppError> {
    type Row = (i64, String, String, i64, Option<String>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, title, path, hash_attempts, hash_retry_at
         FROM books
         WHERE hash_state = 'failed'
         ORDER BY id DESC
         LIMIT ?1",
    )
    .bind(LIST_LIMIT)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(book_id, title, path, attempts, retry_at)| HashFailedBook {
                book_id,
                title,
                path,
                attempts,
                retry_at,
            },
        )
        .collect())
}

/// Conflict rows without `winner_json` or `loser_json`: support needs the
/// shape of the queue, never the user's discarded text.
async fn open_conflicts(pool: &SqlitePool) -> Result<Vec<DiagnosticConflict>, AppError> {
    type Row = (i64, String, String, Option<String>, String);
    let rows: Vec<Row> = sqlx::query_as(&format!(
        r#"
        SELECT c.id, c.kind, c.field, br.title AS book_title, c.created_at
        FROM sync_conflicts c
        LEFT JOIN sync_state_entities e
               ON e.kind = c.kind AND e.entity_uid = c.entity_uid
        LEFT JOIN book_records br ON br.uid = {BOOK_UID_EXPR}
        WHERE c.resolved_at IS NULL AND c.kind <> 'progress'
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?1
        "#
    ))
    .bind(LIST_LIMIT)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, kind, field, book_title, created_at)| DiagnosticConflict {
                id,
                kind,
                field,
                book_title,
                created_at,
            },
        )
        .collect())
}

/// Recent identity and entity merges. Neither table carries a timestamp, so
/// rowid order is the only insertion order available.
async fn recent_merges(pool: &SqlitePool) -> Result<RecentMerges, AppError> {
    type BookRow = (String, String);
    let books: Vec<BookRow> =
        sqlx::query_as("SELECT loser, winner FROM sync_book_merges ORDER BY rowid DESC LIMIT ?1")
            .bind(LIST_LIMIT)
            .fetch_all(pool)
            .await?;
    type EntityRow = (String, String, String);
    let entities: Vec<EntityRow> = sqlx::query_as(
        "SELECT kind, loser, winner FROM sync_entity_merges ORDER BY rowid DESC LIMIT ?1",
    )
    .bind(LIST_LIMIT)
    .fetch_all(pool)
    .await?;
    Ok(RecentMerges {
        books: books
            .into_iter()
            .map(|(loser, winner)| BookMerge { loser, winner })
            .collect(),
        entities: entities
            .into_iter()
            .map(|(kind, loser, winner)| EntityMerge {
                kind,
                loser,
                winner,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    async fn pool_in(dir: &Path) -> SqlitePool {
        crate::db::connection::init_pool(&dir.join("t.db"))
            .await
            .unwrap()
    }

    fn enabled_status(folder: &Path) -> SyncStatus {
        SyncStatus {
            enabled: true,
            folder: Some(folder.to_string_lossy().into_owned()),
            library_id: None,
            device_id: None,
            device_name: None,
            state: SyncState::Idle,
            last_sync_at: Some("2026-10-31T10:00:00.000Z".into()),
            last_error: None,
            pending_local: 0,
            waiting_books: 0,
            issues: 0,
            trash: 0,
            conflicts: 0,
        }
    }

    fn disabled_status() -> SyncStatus {
        SyncStatus {
            enabled: false,
            folder: None,
            library_id: None,
            device_id: None,
            device_name: None,
            state: SyncState::Disabled,
            last_sync_at: None,
            last_error: None,
            pending_local: 9,
            waiting_books: 9,
            issues: 9,
            trash: 9,
            conflicts: 9,
        }
    }

    async fn add_failed_book(pool: &SqlitePool, title: &str, path: &str, attempts: i64) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO books (path, title, hash_state, hash_attempts, hash_retry_at)
             VALUES (?1, ?2, 'failed', ?3, '2999-01-01T00:00:00.000Z')
             RETURNING id",
        )
        .bind(path)
        .bind(title)
        .bind(attempts)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn enabled_payload_reports_live_status_counts_lists_and_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        store::connect(&folder, "a".repeat(32).as_str(), "Laptop", "now").unwrap();
        let mut status = enabled_status(&folder);
        status.pending_local = 4;
        status.waiting_books = 2;
        status.issues = 3;
        status.trash = 1;
        status.conflicts = 5;

        let book_id = add_failed_book(&pool, "Example", "/books/example.epub", 2).await;
        sqlx::query("INSERT INTO book_records (uid, title) VALUES (?1, 'Example')")
            .bind("b".repeat(32))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
             VALUES ('annotation', 'e', ?1)",
        )
        .bind("b".repeat(32))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sync_conflicts
                (kind, entity_uid, field, winner_json, loser_json,
                 winner_wall, winner_count, winner_dev,
                 loser_wall, loser_count, loser_dev, created_at)
             VALUES ('annotation', 'e', 'note', '\"kept secret\"', '\"lost secret\"',
                     2, 0, 'aaa', 1, 0, 'bbb', '2026-10-31T09:00:00.000Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
            .bind("c".repeat(32))
            .bind("d".repeat(32))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)",
        )
        .bind("f".repeat(32))
        .bind("a".repeat(32))
        .execute(&pool)
        .await
        .unwrap();

        let report = collect(&pool, Some(&status)).await.unwrap();
        assert!(report.sync.enabled);
        assert_eq!(report.sync.state, SyncState::Idle);
        assert_eq!(report.sync.counts.pending_local, 4);
        assert_eq!(report.sync.counts.waiting_books, 2);
        assert_eq!(report.sync.counts.issues, 3);
        assert_eq!(report.sync.counts.trash, 1);
        assert_eq!(report.sync.counts.conflicts, 5);
        assert_eq!(report.hash_failed.len(), 1);
        assert_eq!(report.hash_failed[0].book_id, book_id);
        assert_eq!(report.hash_failed[0].title, "Example");
        assert_eq!(report.hash_failed[0].path, "/books/example.epub");
        assert_eq!(report.hash_failed[0].attempts, 2);
        assert_eq!(report.open_conflicts.len(), 1);
        assert_eq!(report.open_conflicts[0].kind, "annotation");
        assert_eq!(report.open_conflicts[0].field, "note");
        assert_eq!(
            report.open_conflicts[0].book_title.as_deref(),
            Some("Example")
        );
        assert_eq!(report.recent_merges.books.len(), 1);
        assert_eq!(report.recent_merges.books[0].loser, "c".repeat(32));
        assert_eq!(report.recent_merges.entities[0].kind, "collection");
        assert_eq!(report.versions.library_marker, Some(OP_SCHEMA));
        assert_eq!(report.versions.op_schema, OP_SCHEMA);
        assert_eq!(report.versions.db_migration, max_migration(&pool).await);

        // The conflict values and any annotation text never appear.
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("kept secret"));
        assert!(!json.contains("lost secret"));
        assert!(!json.contains("winnerJson"));
        assert!(!json.contains("loserJson"));
    }

    #[tokio::test]
    async fn a_running_pass_reports_syncing() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        let mut status = enabled_status(&folder);
        status.state = SyncState::Syncing;

        let report = collect(&pool, Some(&status)).await.unwrap();
        assert_eq!(report.sync.state, SyncState::Syncing);
    }

    #[tokio::test]
    async fn disabled_sync_returns_zero_counts_and_local_version_data() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        add_failed_book(&pool, "Dangling", "/books/dangling.epub", 1).await;
        let status = disabled_status();

        let report = collect(&pool, Some(&status)).await.unwrap();
        assert!(!report.sync.enabled);
        assert_eq!(report.sync.state, SyncState::Disabled);
        assert!(report.sync.folder.is_none());
        assert_eq!(report.sync.counts.pending_local, 0);
        assert_eq!(report.sync.counts.waiting_books, 0);
        assert_eq!(report.sync.counts.issues, 0);
        assert_eq!(report.sync.counts.trash, 0);
        assert_eq!(report.sync.counts.conflicts, 0);
        assert!(report.open_conflicts.is_empty());
        assert!(report.recent_merges.books.is_empty());
        assert!(report.recent_merges.entities.is_empty());
        assert_eq!(report.hash_failed.len(), 1);
        assert!(report.versions.library_marker.is_none());
        assert_eq!(report.versions.op_schema, OP_SCHEMA);
        assert!(report.versions.db_migration > 0);
    }

    #[tokio::test]
    async fn all_empty_snapshot_still_reports_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        store::connect(&folder, "a".repeat(32).as_str(), "Laptop", "now").unwrap();
        let status = enabled_status(&folder);

        let report = collect(&pool, Some(&status)).await.unwrap();
        assert!(report.hash_failed.is_empty());
        assert!(report.open_conflicts.is_empty());
        assert!(report.recent_merges.books.is_empty());
        assert!(report.recent_merges.entities.is_empty());
        assert_eq!(report.versions.library_marker, Some(OP_SCHEMA));
        assert_eq!(report.versions.op_schema, OP_SCHEMA);
        assert_eq!(report.versions.db_migration, max_migration(&pool).await);
    }

    #[tokio::test]
    async fn missing_service_is_disabled_with_zero_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;

        let report = collect(&pool, None).await.unwrap();
        assert!(!report.sync.enabled);
        assert_eq!(report.sync.state, SyncState::Disabled);
        assert!(report.sync.folder.is_none());
        assert_eq!(report.sync.counts.pending_local, 0);
        assert_eq!(report.sync.counts.issues, 0);
        assert!(report.hash_failed.is_empty());
        assert!(report.open_conflicts.is_empty());
        assert_eq!(report.versions.op_schema, OP_SCHEMA);
        assert!(report.versions.db_migration > 0);
    }

    #[tokio::test]
    async fn a_missing_or_unreadable_marker_is_null_without_failing() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        let status = enabled_status(&folder);

        // No library.json yet.
        let report = collect(&pool, Some(&status)).await.unwrap();
        assert!(report.versions.library_marker.is_none());

        // Present but not valid JSON.
        fs::create_dir_all(folder.join("TuxBooks")).unwrap();
        fs::write(folder.join("TuxBooks/library.json"), b"{not json").unwrap();
        let report = collect(&pool, Some(&status)).await.unwrap();
        assert!(report.versions.library_marker.is_none());
    }

    #[tokio::test]
    async fn lists_are_capped_at_the_limit_with_the_newest_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        let status = enabled_status(&folder);

        let mut newest_id = 0;
        for index in 0..(LIST_LIMIT + 3) {
            newest_id = add_failed_book(
                &pool,
                &format!("Book {index}"),
                &format!("/books/{index}.epub"),
                1,
            )
            .await;
        }
        for index in 0..(LIST_LIMIT + 3) {
            sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
                .bind(format!("loser-{index}"))
                .bind(format!("winner-{index}"))
                .execute(&pool)
                .await
                .unwrap();
        }
        for index in 0..(LIST_LIMIT + 3) {
            sqlx::query(
                "INSERT INTO sync_conflicts
                    (kind, entity_uid, field, winner_json, loser_json,
                     winner_wall, winner_count, winner_dev,
                     loser_wall, loser_count, loser_dev, created_at)
                 VALUES ('annotation', ?1, 'note', 'null', 'null', 2, 0, 'aaa',
                         1, 0, 'bbb', '2026-10-31T09:00:00.000Z')",
            )
            .bind(format!("entity-{index}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        let report = collect(&pool, Some(&status)).await.unwrap();
        assert_eq!(report.hash_failed.len(), LIST_LIMIT as usize);
        assert_eq!(report.open_conflicts.len(), LIST_LIMIT as usize);
        assert_eq!(report.recent_merges.books.len(), LIST_LIMIT as usize);
        // Hash failures come newest first, so the newest failing book survives
        // the cap and the oldest is dropped.
        assert_eq!(report.hash_failed[0].book_id, newest_id);
        assert!(!report.hash_failed.iter().any(|book| book.title == "Book 0"));
    }

    #[tokio::test]
    async fn an_error_status_keeps_the_error_and_a_relative_folder_has_no_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let mut status = enabled_status(Path::new("relative/path"));
        status.state = SyncState::Error;
        status.last_error = Some("sync folder is unavailable".into());

        let report = collect(&pool, Some(&status)).await.unwrap();
        assert_eq!(report.sync.state, SyncState::Error);
        assert_eq!(
            report.sync.last_error.as_deref(),
            Some("sync folder is unavailable")
        );
        assert!(report.versions.library_marker.is_none());
    }

    async fn max_migration(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(pool)
            .await
            .unwrap()
    }
}
