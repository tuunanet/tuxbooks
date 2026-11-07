//! List the 30-day trash and restore one entry, replacing the identity the
//! Forget left in the library.

use sqlx::SqlitePool;

use crate::domain::{BookTrashEntry, RestoreConflict, RestoreMode, RestoreOutcome, RestoreStatus};
use crate::error::AppError;
use crate::repository::metadata;

use super::merge::merge_into;
use super::now;
use super::snapshot::{
    load_book_row, AnnotationSnapshot, BookSnapshot, CollectionSnapshot, OverrideSnapshot,
    ProgressSnapshot, ProviderSnapshot, SnapshotRow,
};
use super::state::restore_replace;

/// Open, unexpired forgotten books, newest first. `hasNewState` tells the UI
/// whether Restore needs a Replace / Keep / Merge choice.
pub async fn list_trash(pool: &SqlitePool) -> Result<Vec<BookTrashEntry>, AppError> {
    let rows: Vec<SnapshotRow> = sqlx::query_as(
        "SELECT id, book_id, book_uid, replacement_book_uid, snapshot_json,
                deleted_at, expires_at
         FROM book_trash
         WHERE restored_at IS NULL AND expires_at > ?1
         ORDER BY deleted_at DESC, id DESC LIMIT 200",
    )
    .bind(now())
    .fetch_all(pool)
    .await?;

    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let snapshot: BookSnapshot = serde_json::from_str(&row.snapshot_json).map_err(|err| {
            AppError::InvalidInput(format!("trash snapshot is unreadable: {err}"))
        })?;
        let replacement_book_id = match &row.replacement_book_uid {
            Some(uid) => {
                sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
                    .bind(uid)
                    .fetch_optional(pool)
                    .await?
            }
            None => None,
        };
        let has_new_state = match replacement_book_id {
            Some(id) => has_new_state(pool, id).await?,
            None => false,
        };
        entries.push(BookTrashEntry {
            id: row.id,
            book_id: row.book_id,
            book_uid: row.book_uid,
            title: snapshot.book.title.clone(),
            author: snapshot.book.author.clone(),
            deleted_at: row.deleted_at,
            expires_at: row.expires_at,
            progress_percent: snapshot
                .progress
                .as_ref()
                .and_then(|progress| progress.progress_percent)
                .or(snapshot.book.progress_percent),
            annotation_count: snapshot.annotations.len() as i64,
            replacement_book_id,
            has_new_state,
        });
    }
    Ok(entries)
}

/// Restore a forgotten book. `None` restores silently when the fresh identity
/// has no new progress or annotations and reports a conflict when it does.
/// Replace restores the old record, Keep discards the snapshot, and Merge
/// folds the old state into the current identity (newer progress, union of
/// annotations).
pub async fn restore(
    pool: &SqlitePool,
    trash_id: i64,
    mode: Option<RestoreMode>,
) -> Result<RestoreOutcome, AppError> {
    let row: Option<SnapshotRow> = sqlx::query_as(
        "SELECT id, book_id, book_uid, replacement_book_uid, snapshot_json,
                deleted_at, expires_at
         FROM book_trash
         WHERE id = ?1 AND restored_at IS NULL AND expires_at > ?2",
    )
    .bind(trash_id)
    .bind(now())
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(RestoreOutcome {
            status: RestoreStatus::NotFound,
            book_id: None,
            book_uid: None,
            replaced_book_ids: Vec::new(),
            conflict: None,
        });
    };
    let snapshot: BookSnapshot = serde_json::from_str(&row.snapshot_json)
        .map_err(|err| AppError::InvalidInput(format!("trash snapshot is unreadable: {err}")))?;
    let replacement_id = match &row.replacement_book_uid {
        Some(uid) => {
            sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
                .bind(uid)
                .fetch_optional(pool)
                .await?
        }
        None => None,
    };

    if let Some(replacement_id) = replacement_id {
        let conflict = restore_conflict(pool, replacement_id).await?;
        if conflict.is_some() && mode.is_none() {
            return Ok(RestoreOutcome {
                status: RestoreStatus::Conflict,
                book_id: Some(replacement_id),
                book_uid: row.replacement_book_uid.clone(),
                replaced_book_ids: Vec::new(),
                conflict,
            });
        }

        match mode {
            Some(RestoreMode::Keep) => {
                mark_restored(pool, trash_id, "discard").await?;
                let book_uid: Option<String> =
                    sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
                        .bind(replacement_id)
                        .fetch_optional(pool)
                        .await?;
                return Ok(RestoreOutcome {
                    status: RestoreStatus::Kept,
                    book_id: Some(replacement_id),
                    book_uid,
                    replaced_book_ids: Vec::new(),
                    conflict: None,
                });
            }
            Some(RestoreMode::Merge) => {
                merge_into(pool, &snapshot, replacement_id).await?;
                mark_restored(pool, trash_id, "discard").await?;
                let book_uid: Option<String> =
                    sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
                        .bind(replacement_id)
                        .fetch_optional(pool)
                        .await?;
                return Ok(RestoreOutcome {
                    status: RestoreStatus::Restored,
                    book_id: Some(replacement_id),
                    book_uid,
                    replaced_book_ids: Vec::new(),
                    conflict: None,
                });
            }
            _ => {}
        }
    }

    // Ids the renderer can still be holding for this entry: the fresh
    // identity, and the old record as it was before restore_replace put it
    // back. The old id comes back only when the snapshot's id is free, so a
    // restore can move the public id and leave a card behind.
    let mut replaced_book_ids: Vec<i64> = Vec::new();
    if let Some(id) = replacement_id {
        replaced_book_ids.push(id);
    }
    let old_id: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&snapshot.book.uid)
        .fetch_optional(pool)
        .await?;
    if let Some(id) = old_id {
        replaced_book_ids.push(id);
    }

    let restored_id = restore_replace(pool, &snapshot, replacement_id).await?;
    replaced_book_ids.retain(|id| *id != restored_id);
    replaced_book_ids.sort_unstable();
    replaced_book_ids.dedup();
    mark_restored(pool, trash_id, "restore").await?;
    Ok(RestoreOutcome {
        status: RestoreStatus::Restored,
        book_id: Some(restored_id),
        book_uid: Some(snapshot.book.uid.clone()),
        replaced_book_ids,
        conflict: None,
    })
}

async fn mark_restored(pool: &SqlitePool, trash_id: i64, resolution: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE book_trash SET restored_at = ?2, resolution = ?3 WHERE id = ?1")
        .bind(trash_id)
        .bind(now())
        .bind(resolution)
        .execute(pool)
        .await?;
    Ok(())
}

async fn has_new_state(pool: &SqlitePool, book_id: i64) -> Result<bool, AppError> {
    Ok(restore_conflict(pool, book_id).await?.is_some())
}

pub(super) async fn restore_conflict(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<RestoreConflict>, AppError> {
    let progress: Option<f64> = sqlx::query_scalar(
        "SELECT rp.progress_percent FROM reading_progress rp
         JOIN book_records br ON br.uid = rp.book_uid
         WHERE br.id = ?1",
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    let annotation_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM annotations a
         JOIN book_records br ON br.uid = a.book_uid
         WHERE br.id = ?1",
    )
    .bind(book_id)
    .fetch_one(pool)
    .await?;
    if progress.is_none() && annotation_count == 0 {
        return Ok(None);
    }
    Ok(Some(RestoreConflict {
        progress_percent: progress,
        annotation_count,
    }))
}

pub(super) async fn load_snapshot(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<BookSnapshot>, AppError> {
    let Some(book) = load_book_row(pool, book_id).await? else {
        return Ok(None);
    };
    let uid = book.uid.clone();
    let progress = sqlx::query_as::<_, ProgressSnapshot>(
        "SELECT chapter_href, cfi, character_offset, page_number, scroll_offset,
                progress_percent, locator, progression, locations, engine,
                schema_version, updated_at
         FROM reading_progress WHERE book_uid = ?1",
    )
    .bind(&uid)
    .fetch_optional(pool)
    .await?;
    let annotations = sqlx::query_as::<_, AnnotationSnapshot>(
        "SELECT sync_uid, kind, cfi, chapter_href, page_number, page_fraction,
                text, color, geometry, note, label, created_at, modified_at
         FROM annotations WHERE book_uid = ?1 ORDER BY id",
    )
    .bind(&uid)
    .fetch_all(pool)
    .await?;
    let collections = sqlx::query_as::<_, CollectionSnapshot>(
        "SELECT bc.collection_id, bc.added_at,
                c.sync_uid AS collection_uid, c.name AS collection_name
         FROM book_collections bc
         LEFT JOIN collections c ON c.id = bc.collection_id
         WHERE bc.book_uid = ?1 ORDER BY bc.collection_id",
    )
    .bind(&uid)
    .fetch_all(pool)
    .await?;
    let overrides = sqlx::query_as::<_, OverrideSnapshot>(
        "SELECT title, subtitle, publisher, language, isbn, description,
                publication_date, series, series_index, cover_path,
                authors_customized, subjects_customized
         FROM book_metadata_overrides WHERE book_uid = ?1",
    )
    .bind(&uid)
    .fetch_optional(pool)
    .await?;
    let authors = metadata::list_book_authors(pool, &uid).await?;
    let subjects = metadata::list_book_subjects(pool, &uid).await?;
    let providers = sqlx::query_as::<_, ProviderSnapshot>(
        "SELECT provider, remote_id, status, status_updated_at, linked_at, updated_at
         FROM book_provider_links WHERE book_uid = ?1 ORDER BY provider",
    )
    .bind(&uid)
    .fetch_all(pool)
    .await?;
    let aliases: Vec<String> =
        sqlx::query_scalar("SELECT content_hash FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(&uid)
            .fetch_all(pool)
            .await?;
    Ok(Some(BookSnapshot {
        book_id,
        book,
        progress,
        annotations,
        collections,
        overrides,
        authors,
        subjects,
        providers,
        aliases,
    }))
}
