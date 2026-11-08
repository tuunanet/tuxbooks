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
            // The conflict count is diagnostics-only (ADR 0017 D2): the live
            // status payload no longer carries it, so the support report
            // counts the rows itself.
            conflicts: open_conflict_count(pool).await?,
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

/// The rows the conflict diagnostics talk about: unresolved, never
/// `progress`. Both queries share the fragment so the count and the sample
/// cover the same set.
const OPEN_CONFLICT_WHERE: &str = "c.resolved_at IS NULL AND c.kind <> 'progress'";

/// The open-conflict total for support's report, matching the sample query.
async fn open_conflict_count(pool: &SqlitePool) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM sync_conflicts c WHERE {OPEN_CONFLICT_WHERE}"
    ))
    .fetch_one(pool)
    .await?;
    Ok(count)
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
        WHERE {OPEN_CONFLICT_WHERE}
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
mod tests;
