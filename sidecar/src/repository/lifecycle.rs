//! Reset, Forget, and the 30-day book trash (ADR 0014 D5, ticket
//! tuxbooks-ip6.7).
//!
//! Reset keeps the durable identity and clears what the user owns. Forget
//! snapshots the whole book, deletes the identity, and, when a file row is
//! still in the library, rebinds it to a fresh record so the entry never
//! disappears. The snapshot lives in `book_trash`, separate from `sync_trash`
//! (which holds one annotation or collection entity per row).

use std::collections::HashMap;

use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::domain::{
    BookTrashEntry, ForgetOutcome, RestoreConflict, RestoreMode, RestoreOutcome, RestoreStatus,
};
use crate::error::AppError;
use crate::repository::metadata;
use crate::sync::model::{MAX_FIELD_STRING_BYTES, TRASH_DAYS};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct BookRowSnapshot {
    uid: String,
    created_at: String,
    title: Option<String>,
    subtitle: Option<String>,
    author: Option<String>,
    publisher: Option<String>,
    language: Option<String>,
    isbn: Option<String>,
    description: Option<String>,
    publication_date: Option<String>,
    series: Option<String>,
    series_index: Option<f64>,
    cover_path: Option<String>,
    last_opened_at: Option<String>,
    progress_percent: Option<f64>,
    annotation_count: i64,
    metadata_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct ProgressSnapshot {
    chapter_href: Option<String>,
    cfi: Option<String>,
    character_offset: Option<i64>,
    page_number: Option<i64>,
    scroll_offset: Option<f64>,
    progress_percent: Option<f64>,
    locator: Option<String>,
    progression: Option<f64>,
    locations: Option<String>,
    engine: Option<String>,
    schema_version: Option<i64>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct AnnotationSnapshot {
    sync_uid: Option<String>,
    kind: String,
    cfi: Option<String>,
    chapter_href: Option<String>,
    page_number: Option<i64>,
    page_fraction: Option<f64>,
    text: Option<String>,
    color: Option<String>,
    geometry: Option<String>,
    note: Option<String>,
    label: Option<String>,
    created_at: String,
    modified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct CollectionSnapshot {
    collection_id: i64,
    added_at: String,
    /// Portable collection id. Local collection ids are machine-specific and
    /// must not cross the sync boundary.
    #[serde(default)]
    collection_uid: Option<String>,
    #[serde(default)]
    collection_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct OverrideSnapshot {
    title: Option<String>,
    subtitle: Option<String>,
    publisher: Option<String>,
    language: Option<String>,
    isbn: Option<String>,
    description: Option<String>,
    publication_date: Option<String>,
    series: Option<String>,
    series_index: Option<f64>,
    cover_path: Option<String>,
    authors_customized: bool,
    subjects_customized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
struct ProviderSnapshot {
    provider: String,
    remote_id: String,
    status: Option<String>,
    status_updated_at: Option<String>,
    linked_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BookSnapshot {
    book_id: i64,
    book: BookRowSnapshot,
    progress: Option<ProgressSnapshot>,
    annotations: Vec<AnnotationSnapshot>,
    collections: Vec<CollectionSnapshot>,
    overrides: Option<OverrideSnapshot>,
    authors: Vec<String>,
    subjects: Vec<String>,
    providers: Vec<ProviderSnapshot>,
    /// Content hashes that pointed at the old identity. Forget deletes them;
    /// the snapshot lets Replace recreate the old discovery index.
    aliases: Vec<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct SnapshotRow {
    id: i64,
    book_id: i64,
    book_uid: String,
    replacement_book_uid: Option<String>,
    snapshot_json: String,
    deleted_at: String,
    expires_at: String,
}

fn now() -> String {
    crate::sync::clock::now_rfc3339()
}

fn expires_at() -> String {
    (Utc::now() + Duration::days(TRASH_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Clear the user-owned state while keeping the durable identity and the
/// current file. Progress, annotations, collection membership, metadata
/// overrides (and the customized lists), and provider links go; the effective
/// metadata falls back to the source file.
pub async fn reset(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    let uid = metadata::book_uid_for_id(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let file_id = metadata::primary_file_id(pool, &uid).await?;

    let mut tx = pool.begin().await?;
    for table in [
        "reading_progress",
        "annotations",
        "book_collections",
        "book_metadata_overrides",
        "book_authors",
        "book_subjects",
        "book_provider_links",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE book_uid = ?1"))
            .bind(&uid)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "UPDATE book_records SET progress_percent = NULL, annotation_count = 0 WHERE uid = ?1",
    )
    .bind(&uid)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    if let Some(file_id) = file_id {
        metadata::recompute_effective(pool, &uid, file_id).await?;
    }
    metadata::sweep_orphans(pool).await?;
    Ok(())
}

/// Forget one book. The snapshot and every delete are one transaction after
/// the provider links are unlinked through the existing operation. The file
/// rows (if any) move to a fresh record; the old record goes to the trash.
pub async fn forget(pool: &SqlitePool, book_id: i64) -> Result<ForgetOutcome, AppError> {
    let snapshot = load_snapshot(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let old_uid = snapshot.book.uid.clone();

    // Provider history belongs to the provider. Only the local association
    // goes (ADR 0014 D5).
    for link in &snapshot.providers {
        crate::services::providers::unlink_book(pool, &old_uid, &link.provider).await?;
    }

    let mut tx = pool.begin().await?;
    // The snapshot was read outside the transaction; fail cleanly if the book
    // vanished in the meantime.
    let still_there: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(&mut *tx)
        .await?;
    if still_there.is_none() {
        return Err(AppError::NotFound);
    }

    let file_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books WHERE book_uid = ?1")
        .bind(&old_uid)
        .fetch_one(&mut *tx)
        .await?;
    let replacement_uid = if file_count > 0 {
        Some(insert_fresh_record(&mut tx, &snapshot.book).await?)
    } else {
        None
    };

    if let Some(new_uid) = &replacement_uid {
        sqlx::query("UPDATE books SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&old_uid)
            .bind(new_uid)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE sync_book_bindings SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&old_uid)
            .bind(new_uid)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(&old_uid)
            .execute(&mut *tx)
            .await?;
        for hash in &snapshot.aliases {
            sqlx::query(
                "INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)
                 ON CONFLICT(content_hash) DO UPDATE SET book_uid = excluded.book_uid",
            )
            .bind(hash)
            .bind(new_uid)
            .execute(&mut *tx)
            .await?;
        }
    } else {
        sqlx::query("DELETE FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(&old_uid)
            .execute(&mut *tx)
            .await?;
    }

    let snapshot_json = serde_json::to_string(&snapshot).map_err(|err| {
        AppError::InvalidInput(format!("book snapshot is not serializable: {err}"))
    })?;
    let trash_id: i64 = sqlx::query_scalar(
        "INSERT INTO book_trash
            (book_id, book_uid, replacement_book_uid, snapshot_json, deleted_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING id",
    )
    .bind(snapshot.book_id)
    .bind(&old_uid)
    .bind(&replacement_uid)
    .bind(snapshot_json)
    .bind(now())
    .bind(expires_at())
    .fetch_one(&mut *tx)
    .await?;

    // Cascades the old identity's progress, annotations, collections,
    // overrides, lists, and provider rows. FTS triggers drop its index row.
    sqlx::query("DELETE FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let replacement_book_id = match &replacement_uid {
        Some(uid) => {
            let id: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
                .bind(uid)
                .fetch_optional(pool)
                .await?;
            // The fresh identity starts from the source file, not the old
            // book's curated/effective snapshot: Forget moved that state to
            // the trash. The file row is already rebound, so this resolves
            // the same bytes the library entry points at.
            if let Some(file_id) = metadata::primary_file_id(pool, uid).await? {
                metadata::recompute_effective(pool, uid, file_id).await?;
            }
            id
        }
        None => None,
    };
    Ok(ForgetOutcome {
        forgotten_book_id: book_id,
        replacement_book_id,
        trash_id,
    })
}

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
                    conflict: None,
                });
            }
            _ => {}
        }
    }

    let restored_id = restore_replace(pool, &snapshot, replacement_id).await?;
    mark_restored(pool, trash_id, "restore").await?;
    Ok(RestoreOutcome {
        status: RestoreStatus::Restored,
        book_id: Some(restored_id),
        book_uid: Some(snapshot.book.uid.clone()),
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

async fn restore_conflict(
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

async fn load_snapshot(pool: &SqlitePool, book_id: i64) -> Result<Option<BookSnapshot>, AppError> {
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

async fn insert_fresh_record(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    old: &BookRowSnapshot,
) -> Result<String, AppError> {
    let uid: String = sqlx::query_scalar(
        "INSERT INTO book_records (
            uid, title, subtitle, author, publisher, language, isbn, description,
            publication_date, series, series_index, series_id, cover_path,
            metadata_state
         )
         VALUES (
            lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            (SELECT id FROM series WHERE name = ?9), ?11, ?12
         )
         RETURNING uid",
    )
    .bind(&old.title)
    .bind(&old.subtitle)
    .bind(&old.author)
    .bind(&old.publisher)
    .bind(&old.language)
    .bind(&old.isbn)
    .bind(&old.description)
    .bind(&old.publication_date)
    .bind(&old.series)
    .bind(old.series_index)
    .bind(&old.cover_path)
    .bind(&old.metadata_state)
    .fetch_one(&mut **tx)
    .await?;
    Ok(uid)
}

async fn restore_replace(
    pool: &SqlitePool,
    snapshot: &BookSnapshot,
    replacement_id: Option<i64>,
) -> Result<i64, AppError> {
    let old_uid = snapshot.book.uid.clone();
    let mut tx = pool.begin().await?;

    if let Some(replacement_id) = replacement_id {
        let fresh_uid: Option<String> =
            sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
                .bind(replacement_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(fresh_uid) = fresh_uid {
            if fresh_uid != old_uid {
                sqlx::query("UPDATE books SET book_uid = ?2 WHERE book_uid = ?1")
                    .bind(&fresh_uid)
                    .bind(&old_uid)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("UPDATE sync_book_bindings SET book_uid = ?2 WHERE book_uid = ?1")
                    .bind(&fresh_uid)
                    .bind(&old_uid)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("DELETE FROM sync_book_aliases WHERE book_uid = ?1")
                    .bind(&fresh_uid)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("DELETE FROM book_records WHERE uid = ?1")
                    .bind(&fresh_uid)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    // An identity that reappeared while the book was in the trash (a sync
    // merge, an unusual manual import) loses to the snapshot: Restore means
    // the old record wins.
    sqlx::query("DELETE FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .execute(&mut *tx)
        .await?;

    let id_taken: Option<i64> = if snapshot.book_id > 0 {
        sqlx::query_scalar("SELECT id FROM book_records WHERE id = ?1")
            .bind(snapshot.book_id)
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    let restored_id: i64 = if id_taken.is_none() {
        sqlx::query_scalar(
            "INSERT INTO book_records (
                id, uid, created_at, title, subtitle, author, publisher, language,
                isbn, description, publication_date, series, series_index, series_id,
                cover_path, last_opened_at, progress_percent, annotation_count,
                metadata_state
             )
             VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                (SELECT id FROM series WHERE name = ?12), ?14, ?15, ?16, ?17, ?18
             )
             RETURNING id",
        )
        .bind(snapshot.book_id)
        .bind(&old_uid)
        .bind(&snapshot.book.created_at)
        .bind(&snapshot.book.title)
        .bind(&snapshot.book.subtitle)
        .bind(&snapshot.book.author)
        .bind(&snapshot.book.publisher)
        .bind(&snapshot.book.language)
        .bind(&snapshot.book.isbn)
        .bind(&snapshot.book.description)
        .bind(&snapshot.book.publication_date)
        .bind(&snapshot.book.series)
        .bind(snapshot.book.series_index)
        .bind(&snapshot.book.cover_path)
        .bind(&snapshot.book.last_opened_at)
        .bind(snapshot.book.progress_percent)
        .bind(snapshot.annotations.len() as i64)
        .bind(&snapshot.book.metadata_state)
        .fetch_one(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar(
            "INSERT INTO book_records (
                uid, created_at, title, subtitle, author, publisher, language, isbn,
                description, publication_date, series, series_index, series_id,
                cover_path, last_opened_at, progress_percent, annotation_count,
                metadata_state
             )
             VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                (SELECT id FROM series WHERE name = ?11), ?13, ?14, ?15, ?16, ?17
             )
             RETURNING id",
        )
        .bind(&old_uid)
        .bind(&snapshot.book.created_at)
        .bind(&snapshot.book.title)
        .bind(&snapshot.book.subtitle)
        .bind(&snapshot.book.author)
        .bind(&snapshot.book.publisher)
        .bind(&snapshot.book.language)
        .bind(&snapshot.book.isbn)
        .bind(&snapshot.book.description)
        .bind(&snapshot.book.publication_date)
        .bind(&snapshot.book.series)
        .bind(snapshot.book.series_index)
        .bind(&snapshot.book.cover_path)
        .bind(&snapshot.book.last_opened_at)
        .bind(snapshot.book.progress_percent)
        .bind(snapshot.annotations.len() as i64)
        .bind(&snapshot.book.metadata_state)
        .fetch_one(&mut *tx)
        .await?
    };

    restore_state(&mut tx, &old_uid, snapshot).await?;
    for hash in &snapshot.aliases {
        sqlx::query(
            "INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)
             ON CONFLICT(content_hash) DO UPDATE SET book_uid = excluded.book_uid",
        )
        .bind(hash)
        .bind(&old_uid)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    if let Some(file_id) = metadata::primary_file_id(pool, &old_uid).await? {
        metadata::recompute_effective(pool, &old_uid, file_id).await?;
    }
    Ok(restored_id)
}

async fn restore_state(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    uid: &str,
    snapshot: &BookSnapshot,
) -> Result<(), AppError> {
    if let Some(progress) = &snapshot.progress {
        sqlx::query(
            "INSERT INTO reading_progress (
                book_uid, chapter_href, cfi, character_offset, page_number,
                scroll_offset, progress_percent, locator, progression, locations,
                engine, schema_version, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )
        .bind(uid)
        .bind(&progress.chapter_href)
        .bind(&progress.cfi)
        .bind(progress.character_offset)
        .bind(progress.page_number)
        .bind(progress.scroll_offset)
        .bind(progress.progress_percent)
        .bind(&progress.locator)
        .bind(progress.progression)
        .bind(&progress.locations)
        .bind(&progress.engine)
        .bind(progress.schema_version)
        .bind(&progress.updated_at)
        .execute(&mut **tx)
        .await?;
    }

    for annotation in &snapshot.annotations {
        sqlx::query(
            "INSERT OR IGNORE INTO annotations (
                book_uid, sync_uid, kind, cfi, chapter_href, page_number,
                page_fraction, text, color, geometry, note, label,
                created_at, modified_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )
        .bind(uid)
        .bind(&annotation.sync_uid)
        .bind(&annotation.kind)
        .bind(&annotation.cfi)
        .bind(&annotation.chapter_href)
        .bind(annotation.page_number)
        .bind(annotation.page_fraction)
        .bind(&annotation.text)
        .bind(&annotation.color)
        .bind(&annotation.geometry)
        .bind(&annotation.note)
        .bind(&annotation.label)
        .bind(&annotation.created_at)
        .bind(&annotation.modified_at)
        .execute(&mut **tx)
        .await?;
    }

    for membership in &snapshot.collections {
        sqlx::query(
            "INSERT OR IGNORE INTO book_collections (book_uid, collection_id, added_at)
             SELECT ?1, ?2, ?3
             WHERE EXISTS (SELECT 1 FROM collections WHERE id = ?2)",
        )
        .bind(uid)
        .bind(membership.collection_id)
        .bind(&membership.added_at)
        .execute(&mut **tx)
        .await?;
    }

    if let Some(overrides) = &snapshot.overrides {
        sqlx::query(
            "INSERT OR REPLACE INTO book_metadata_overrides (
                book_uid, title, subtitle, publisher, language, isbn, description,
                publication_date, series, series_index, cover_path,
                authors_customized, subjects_customized
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )
        .bind(uid)
        .bind(&overrides.title)
        .bind(&overrides.subtitle)
        .bind(&overrides.publisher)
        .bind(&overrides.language)
        .bind(&overrides.isbn)
        .bind(&overrides.description)
        .bind(&overrides.publication_date)
        .bind(&overrides.series)
        .bind(overrides.series_index)
        .bind(&overrides.cover_path)
        .bind(overrides.authors_customized)
        .bind(overrides.subjects_customized)
        .execute(&mut **tx)
        .await?;
    }

    restore_lists(tx, uid, &snapshot.authors, &snapshot.subjects).await?;

    for link in &snapshot.providers {
        sqlx::query(
            "INSERT OR IGNORE INTO book_provider_links (
                book_uid, provider, remote_id, status, status_updated_at,
                linked_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(uid)
        .bind(&link.provider)
        .bind(&link.remote_id)
        .bind(&link.status)
        .bind(&link.status_updated_at)
        .bind(&link.linked_at)
        .bind(&link.updated_at)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn restore_lists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    uid: &str,
    authors: &[String],
    subjects: &[String],
) -> Result<(), AppError> {
    for name in authors {
        sqlx::query("INSERT OR IGNORE INTO authors (name) VALUES (?1)")
            .bind(name)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("DELETE FROM book_authors WHERE book_uid = ?1")
        .bind(uid)
        .execute(&mut **tx)
        .await?;
    for (position, name) in authors.iter().enumerate() {
        sqlx::query(
            "INSERT INTO book_authors (book_uid, author_id, position)
             VALUES (?1, (SELECT id FROM authors WHERE name = ?2), ?3)",
        )
        .bind(uid)
        .bind(name)
        .bind(position as i64)
        .execute(&mut **tx)
        .await?;
    }

    for name in subjects {
        sqlx::query("INSERT OR IGNORE INTO subjects (name) VALUES (?1)")
            .bind(name)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("DELETE FROM book_subjects WHERE book_uid = ?1")
        .bind(uid)
        .execute(&mut **tx)
        .await?;
    for name in subjects {
        sqlx::query(
            "INSERT INTO book_subjects (book_uid, subject_id)
             VALUES (?1, (SELECT id FROM subjects WHERE name = ?2))",
        )
        .bind(uid)
        .bind(name)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn merge_into(
    pool: &SqlitePool,
    snapshot: &BookSnapshot,
    replacement_id: i64,
) -> Result<(), AppError> {
    let fresh_uid: String = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(replacement_id)
        .fetch_one(pool)
        .await?;
    let file_id = metadata::primary_file_id(pool, &fresh_uid).await?;
    let fresh_progress_at: Option<String> =
        sqlx::query_scalar("SELECT updated_at FROM reading_progress WHERE book_uid = ?1")
            .bind(&fresh_uid)
            .fetch_optional(pool)
            .await?;
    // Newer wins. With no fresh row, the old row is the only state there is.
    let old_is_newer = match (&snapshot.progress, &fresh_progress_at) {
        (Some(old), Some(fresh)) => old.updated_at.as_str() > fresh.as_str(),
        (Some(_), None) => true,
        (None, _) => false,
    };

    let mut tx = pool.begin().await?;
    if old_is_newer {
        if let Some(progress) = &snapshot.progress {
            sqlx::query(
                "INSERT INTO reading_progress (
                    book_uid, chapter_href, cfi, character_offset, page_number,
                    scroll_offset, progress_percent, locator, progression,
                    locations, engine, schema_version, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(book_uid) DO UPDATE SET
                    chapter_href = excluded.chapter_href,
                    cfi = excluded.cfi,
                    character_offset = excluded.character_offset,
                    page_number = excluded.page_number,
                    scroll_offset = excluded.scroll_offset,
                    progress_percent = excluded.progress_percent,
                    locator = excluded.locator,
                    progression = excluded.progression,
                    locations = excluded.locations,
                    engine = excluded.engine,
                    schema_version = excluded.schema_version,
                    updated_at = excluded.updated_at",
            )
            .bind(&fresh_uid)
            .bind(&progress.chapter_href)
            .bind(&progress.cfi)
            .bind(progress.character_offset)
            .bind(progress.page_number)
            .bind(progress.scroll_offset)
            .bind(progress.progress_percent)
            .bind(&progress.locator)
            .bind(progress.progression)
            .bind(&progress.locations)
            .bind(&progress.engine)
            .bind(progress.schema_version)
            .bind(&progress.updated_at)
            .execute(&mut *tx)
            .await?;
        }
    }

    // Union annotations. A portable sync uid already on the fresh book is the
    // same annotation, not a second copy.
    let existing: Vec<String> = sqlx::query_scalar(
        "SELECT sync_uid FROM annotations WHERE book_uid = ?1 AND sync_uid IS NOT NULL",
    )
    .bind(&fresh_uid)
    .fetch_all(&mut *tx)
    .await?;
    let seen: HashMap<&str, ()> = existing.iter().map(|uid| (uid.as_str(), ())).collect();
    for annotation in &snapshot.annotations {
        let duplicate = annotation
            .sync_uid
            .as_deref()
            .is_some_and(|uid| seen.contains_key(uid));
        if duplicate {
            continue;
        }
        sqlx::query(
            "INSERT INTO annotations (
                book_uid, sync_uid, kind, cfi, chapter_href, page_number,
                page_fraction, text, color, geometry, note, label,
                created_at, modified_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )
        .bind(&fresh_uid)
        .bind(&annotation.sync_uid)
        .bind(&annotation.kind)
        .bind(&annotation.cfi)
        .bind(&annotation.chapter_href)
        .bind(annotation.page_number)
        .bind(annotation.page_fraction)
        .bind(&annotation.text)
        .bind(&annotation.color)
        .bind(&annotation.geometry)
        .bind(&annotation.note)
        .bind(&annotation.label)
        .bind(&annotation.created_at)
        .bind(&annotation.modified_at)
        .execute(&mut *tx)
        .await?;
    }

    for membership in &snapshot.collections {
        sqlx::query(
            "INSERT OR IGNORE INTO book_collections (book_uid, collection_id, added_at)
             SELECT ?1, ?2, ?3
             WHERE EXISTS (SELECT 1 FROM collections WHERE id = ?2)",
        )
        .bind(&fresh_uid)
        .bind(membership.collection_id)
        .bind(&membership.added_at)
        .execute(&mut *tx)
        .await?;
    }

    // Current metadata is the user's latest word. Fill in old overrides only
    // when the fresh book has none at all.
    let fresh_overrides: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM book_metadata_overrides WHERE book_uid = ?1")
            .bind(&fresh_uid)
            .fetch_optional(&mut *tx)
            .await?;
    if fresh_overrides.is_none() {
        if let Some(overrides) = &snapshot.overrides {
            sqlx::query(
                "INSERT INTO book_metadata_overrides (
                    book_uid, title, subtitle, publisher, language, isbn, description,
                    publication_date, series, series_index, cover_path,
                    authors_customized, subjects_customized
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )
            .bind(&fresh_uid)
            .bind(&overrides.title)
            .bind(&overrides.subtitle)
            .bind(&overrides.publisher)
            .bind(&overrides.language)
            .bind(&overrides.isbn)
            .bind(&overrides.description)
            .bind(&overrides.publication_date)
            .bind(&overrides.series)
            .bind(overrides.series_index)
            .bind(&overrides.cover_path)
            .bind(overrides.authors_customized)
            .bind(overrides.subjects_customized)
            .execute(&mut *tx)
            .await?;
        }
        restore_lists(&mut tx, &fresh_uid, &snapshot.authors, &snapshot.subjects).await?;
    }

    for link in &snapshot.providers {
        sqlx::query(
            "INSERT OR IGNORE INTO book_provider_links (
                book_uid, provider, remote_id, status, status_updated_at,
                linked_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&fresh_uid)
        .bind(&link.provider)
        .bind(&link.remote_id)
        .bind(&link.status)
        .bind(&link.status_updated_at)
        .bind(&link.linked_at)
        .bind(&link.updated_at)
        .execute(&mut *tx)
        .await?;
    }

    let annotation_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE book_uid = ?1")
            .bind(&fresh_uid)
            .fetch_one(&mut *tx)
            .await?;
    let progress_percent: Option<f64> =
        sqlx::query_scalar("SELECT progress_percent FROM reading_progress WHERE book_uid = ?1")
            .bind(&fresh_uid)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    sqlx::query(
        "UPDATE book_records SET annotation_count = ?2, progress_percent = ?3 WHERE uid = ?1",
    )
    .bind(&fresh_uid)
    .bind(annotation_count)
    .bind(progress_percent)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    if let Some(file_id) = file_id {
        metadata::recompute_effective(pool, &fresh_uid, file_id).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared Forget and restore (ADR 0014 D3/D5, ticket tuxbooks-ip6.9)
// ---------------------------------------------------------------------------

fn parse_snapshot(json: &str) -> Result<BookSnapshot, AppError> {
    serde_json::from_str(json)
        .map_err(|err| AppError::InvalidInput(format!("book snapshot is not readable: {err}")))
}

fn serialize_snapshot(snapshot: &BookSnapshot) -> Result<String, AppError> {
    serde_json::to_string(snapshot)
        .map_err(|err| AppError::InvalidInput(format!("book snapshot is not serializable: {err}")))
}

/// Turn the local trash snapshot into the portable shape that crosses the
/// sync boundary. Local collection ids become collection uids, and provider
/// links stay local (they are not part of the shared contract).
pub async fn shared_snapshot_json(
    pool: &SqlitePool,
    local_json: &str,
) -> Result<Option<String>, AppError> {
    let mut snapshot = parse_snapshot(local_json)?;
    snapshot.book_id = 0;
    snapshot.providers.clear();
    for collection in &mut snapshot.collections {
        if collection.collection_uid.is_none() {
            let row: Option<(Option<String>, Option<String>)> =
                sqlx::query_as("SELECT sync_uid, name FROM collections WHERE id = ?1")
                    .bind(collection.collection_id)
                    .fetch_optional(pool)
                    .await?;
            if let Some((uid, name)) = row {
                collection.collection_uid = uid;
                collection.collection_name = name;
            }
        }
        // Local ids are meaningless on the receiving machine.
        collection.collection_id = 0;
    }
    let json = serialize_snapshot(&snapshot)?;
    if json.len() > MAX_FIELD_STRING_BYTES {
        return Ok(None);
    }
    Ok(Some(json))
}

/// Turn a shared snapshot back into the local shape. Collection uids resolve
/// to the receiving machine's ids; unknown shelves are skipped and named so
/// the caller can surface them instead of silently losing the membership.
async fn local_snapshot_json(
    pool: &SqlitePool,
    shared_json: &str,
    local_book_id: i64,
    local_book_uid: &str,
) -> Result<(String, Vec<String>), AppError> {
    let mut snapshot = parse_snapshot(shared_json)?;
    snapshot.book_id = local_book_id;
    snapshot.book.uid = local_book_uid.to_string();
    let mut unresolved = Vec::new();
    for collection in &mut snapshot.collections {
        let id: Option<i64> = match (
            collection.collection_uid.as_deref(),
            collection.collection_name.as_deref(),
        ) {
            (Some(uid), _) => {
                sqlx::query_scalar("SELECT id FROM collections WHERE sync_uid = ?1")
                    .bind(uid)
                    .fetch_optional(pool)
                    .await?
            }
            (None, Some(name)) => {
                sqlx::query_scalar("SELECT id FROM collections WHERE name = ?1")
                    .bind(name)
                    .fetch_optional(pool)
                    .await?
            }
            (None, None) => None,
        };
        match id {
            Some(id) => collection.collection_id = id,
            None => {
                collection.collection_id = 0;
                unresolved.push(
                    collection
                        .collection_name
                        .clone()
                        .or_else(|| collection.collection_uid.clone())
                        .unwrap_or_else(|| "unknown collection".into()),
                );
            }
        }
    }
    Ok((serialize_snapshot(&snapshot)?, unresolved))
}

async fn load_book_row(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<BookRowSnapshot>, AppError> {
    let row = sqlx::query_as::<_, BookRowSnapshot>(
        "SELECT br.uid, br.created_at, br.title, br.subtitle, br.author, br.publisher,
                br.language, br.isbn, br.description, br.publication_date,
                (SELECT name FROM series WHERE id = br.series_id) AS series,
                br.series_index, br.cover_path, br.last_opened_at,
                br.progress_percent, br.annotation_count, br.metadata_state
         FROM book_records br WHERE br.id = ?1",
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Create the fresh identity that keeps a file in the library after a Forget.
/// `source` is either the shared snapshot's book row or the old local row.
async fn insert_fresh_from_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    new_uid: &str,
    source: &BookRowSnapshot,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO book_records (
            uid, title, subtitle, author, publisher, language, isbn, description,
            publication_date, series, series_index, series_id, cover_path,
            metadata_state
         )
         VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            (SELECT id FROM series WHERE name = ?10), ?12, ?13
         )
         ON CONFLICT(uid) DO NOTHING",
    )
    .bind(new_uid)
    .bind(&source.title)
    .bind(&source.subtitle)
    .bind(&source.author)
    .bind(&source.publisher)
    .bind(&source.language)
    .bind(&source.isbn)
    .bind(&source.description)
    .bind(&source.publication_date)
    .bind(&source.series)
    .bind(source.series_index)
    .bind(&source.cover_path)
    .bind(&source.metadata_state)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_local_trash(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    book_id: i64,
    old_uid: &str,
    replacement_uid: Option<&str>,
    snapshot_json: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO book_trash
            (book_id, book_uid, replacement_book_uid, snapshot_json, deleted_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(book_uid) WHERE restored_at IS NULL DO UPDATE SET
            book_id = excluded.book_id,
            replacement_book_uid = excluded.replacement_book_uid,
            snapshot_json = excluded.snapshot_json,
            expires_at = excluded.expires_at",
    )
    .bind(book_id)
    .bind(old_uid)
    .bind(replacement_uid)
    .bind(snapshot_json)
    .bind(now())
    .bind(expires_at())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Apply a shared Forget on this machine: keep any current file under the
/// sender's fresh identity, erase the old identity, and put the snapshot in
/// this machine's Reading-history trash.
pub async fn apply_remote_forget(
    pool: &SqlitePool,
    old_uid: &str,
    replacement_uid: Option<&str>,
    shared_snapshot: Option<&str>,
) -> Result<Option<i64>, AppError> {
    let old_id: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
        .bind(old_uid)
        .fetch_optional(pool)
        .await?;
    let local = match shared_snapshot {
        Some(shared) => match local_snapshot_json(pool, shared, old_id.unwrap_or(0), old_uid).await
        {
            Ok(local) => Some(local),
            Err(err) => {
                let _ = crate::sync::identity::record_issue(
                    pool,
                    &format!("forget-snapshot-invalid:{old_uid}"),
                    "book_snapshot_invalid",
                    &format!(
                        "the shared Forget carried an unreadable snapshot ({err}); \
                         the delete was applied but no local restore is available"
                    ),
                    None,
                )
                .await;
                None
            }
        },
        None => None,
    };
    let old_row = match old_id {
        Some(id) => load_book_row(pool, id).await?,
        None => None,
    };
    let snapshot_for_aliases = local
        .as_ref()
        .map(|(json, _)| parse_snapshot(json))
        .transpose()?;
    let mut alias_hashes = snapshot_for_aliases
        .as_ref()
        .map(|snapshot| snapshot.aliases.clone())
        .unwrap_or_default();
    let bound_hashes: Vec<String> =
        sqlx::query_scalar("SELECT content_hash FROM sync_book_bindings WHERE book_uid = ?1")
            .bind(old_uid)
            .fetch_all(pool)
            .await?;
    alias_hashes.extend(bound_hashes);
    alias_hashes.retain(|hash| crate::sync::model::is_hex_hash(hash));
    alias_hashes.sort();
    alias_hashes.dedup();

    // The sender had no file and so published no replacement uuid, but this
    // machine may still hold the file. Keep its library entry under a fresh
    // identity and publish that identity later; the old uuid stays dead.
    let mut effective_replacement = replacement_uid.map(str::to_string);
    let mut minted_replacement = false;
    if effective_replacement.is_none() {
        let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books WHERE book_uid = ?1")
            .bind(old_uid)
            .fetch_one(pool)
            .await?;
        if files > 0 {
            effective_replacement = Some(
                sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
                    .fetch_one(pool)
                    .await?,
            );
            minted_replacement = true;
        }
    }
    let replacement_uid = effective_replacement.as_deref();

    let mut tx = pool.begin().await?;
    match replacement_uid {
        Some(replacement) => {
            if let Some(snapshot) = &snapshot_for_aliases {
                insert_fresh_from_row(&mut tx, replacement, &snapshot.book).await?;
            } else if let Some(row) = &old_row {
                insert_fresh_from_row(&mut tx, replacement, row).await?;
            } else {
                let source = BookRowSnapshot {
                    uid: old_uid.to_string(),
                    created_at: now(),
                    title: Some("Unknown".into()),
                    subtitle: None,
                    author: None,
                    publisher: None,
                    language: None,
                    isbn: None,
                    description: None,
                    publication_date: None,
                    series: None,
                    series_index: None,
                    cover_path: None,
                    last_opened_at: None,
                    progress_percent: None,
                    annotation_count: 0,
                    metadata_state: "waiting_for_file".into(),
                };
                insert_fresh_from_row(&mut tx, replacement, &source).await?;
            }
            sqlx::query("UPDATE books SET book_uid = ?2 WHERE book_uid = ?1")
                .bind(old_uid)
                .bind(replacement)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE sync_book_bindings SET book_uid = ?2 WHERE book_uid = ?1")
                .bind(old_uid)
                .bind(replacement)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM sync_book_aliases WHERE book_uid = ?1")
                .bind(old_uid)
                .execute(&mut *tx)
                .await?;
            for hash in &alias_hashes {
                sqlx::query(
                    "INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)
                     ON CONFLICT(content_hash) DO UPDATE SET book_uid = excluded.book_uid",
                )
                .bind(hash)
                .bind(replacement)
                .execute(&mut *tx)
                .await?;
            }
        }
        None => {
            sqlx::query("DELETE FROM sync_book_aliases WHERE book_uid = ?1")
                .bind(old_uid)
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(id) = old_id {
        sqlx::query("DELETE FROM book_records WHERE id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM book_records WHERE uid = ?1")
            .bind(old_uid)
            .execute(&mut *tx)
            .await?;
    }

    let mut unresolved = Vec::new();
    if let Some((local_json, names)) = &local {
        unresolved = names.clone();
        insert_local_trash(
            &mut tx,
            old_id.unwrap_or(0),
            old_uid,
            replacement_uid,
            local_json,
        )
        .await?;
    }
    tx.commit().await?;

    if minted_replacement {
        if let Some(uid) = replacement_uid {
            for hash in &alias_hashes {
                let _ = crate::sync::identity::mark_identity_dirty(pool, hash, uid).await;
            }
        }
    }

    if let Some(names) = (!unresolved.is_empty()).then_some(unresolved) {
        let _ = crate::sync::identity::record_issue(
            pool,
            &format!("forget-collections:{old_uid}"),
            "forget_membership_skipped",
            &format!(
                "the restored snapshot named shelves this library does not have yet ({})",
                names.join(", ")
            ),
            None,
        )
        .await;
    }
    if local.is_none() {
        let _ = crate::sync::identity::record_issue(
            pool,
            &format!("forget-snapshot:{old_uid}"),
            "book_snapshot_missing",
            "another machine forgot this book without a usable snapshot; the delete was applied but no restore is available here",
            None,
        )
        .await;
    }

    match replacement_uid {
        Some(uid) => Ok(
            sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
                .bind(uid)
                .fetch_optional(pool)
                .await?,
        ),
        None => Ok(None),
    }
}

/// Apply a shared restore on this machine. The local trash snapshot wins over
/// the shared one when both exist, so local-only provider links survive.
pub async fn apply_remote_restore(
    pool: &SqlitePool,
    old_uid: &str,
    shared_snapshot: Option<&str>,
) -> Result<Option<i64>, AppError> {
    type TrashRow = (i64, Option<String>, String);
    let row: Option<TrashRow> = sqlx::query_as(
        "SELECT id, replacement_book_uid, snapshot_json FROM book_trash
         WHERE book_uid = ?1 AND restored_at IS NULL
         ORDER BY id DESC LIMIT 1",
    )
    .bind(old_uid)
    .fetch_optional(pool)
    .await?;

    let (trash_id, trash_replacement, snapshot_json) = match row {
        Some((id, replacement, snapshot)) => (Some(id), replacement, snapshot),
        None => {
            let Some(shared) = shared_snapshot else {
                let _ = crate::sync::identity::record_issue(
                    pool,
                    &format!("restore-snapshot:{old_uid}"),
                    "book_snapshot_missing",
                    "a shared restore arrived without a snapshot; the book was not recreated",
                    None,
                )
                .await;
                return Ok(None);
            };
            let (local, unresolved) = local_snapshot_json(pool, shared, 0, old_uid).await?;
            if !unresolved.is_empty() {
                let _ = crate::sync::identity::record_issue(
                    pool,
                    &format!("restore-collections:{old_uid}"),
                    "forget_membership_skipped",
                    &format!(
                        "the restored snapshot named shelves this library does not have yet ({})",
                        unresolved.join(", ")
                    ),
                    None,
                )
                .await;
            }
            (None, None, local)
        }
    };
    let mut snapshot = parse_snapshot(&snapshot_json)?;
    snapshot.book.uid = old_uid.to_string();
    let replacement_id = match trash_replacement {
        Some(uid) => {
            let uid = crate::sync::identity::canonical_book_uid(pool, &uid).await?;
            sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
                .bind(uid)
                .fetch_optional(pool)
                .await?
        }
        None => None,
    };

    if let Some(replacement_id) = replacement_id {
        if let Some(conflict) = restore_conflict(pool, replacement_id).await? {
            let _ = crate::sync::identity::record_issue(
                pool,
                &format!("restore-conflict:{old_uid}"),
                "restore_conflict",
                &format!(
                    "a shared restore replaced newer local state on the fresh book \
                     ({}% progress, {} annotations)",
                    conflict.progress_percent.unwrap_or(0.0),
                    conflict.annotation_count
                ),
                None,
            )
            .await;
        }
    }

    let restored_id = restore_replace(pool, &snapshot, replacement_id).await?;
    if let Some(trash_id) = trash_id {
        sqlx::query("UPDATE book_trash SET restored_at = ?2, resolution = 'restore' WHERE id = ?1")
            .bind(trash_id)
            .bind(now())
            .execute(pool)
            .await?;
    }
    Ok(Some(restored_id))
}

/// Close a remote trash entry after the user chose Keep or Merge. The old
/// identity stays forgotten; merged state travels through ordinary entity
/// operations on the fresh identity.
pub async fn apply_remote_discard(
    pool: &SqlitePool,
    old_uid: &str,
) -> Result<Option<i64>, AppError> {
    sqlx::query(
        "UPDATE book_trash SET restored_at = ?2, resolution = 'discard'
         WHERE book_uid = ?1 AND restored_at IS NULL",
    )
    .bind(old_uid)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(None)
}
