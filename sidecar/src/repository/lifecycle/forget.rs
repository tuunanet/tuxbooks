//! Reset and Forget: the two moves that keep or retire a durable identity.

use sqlx::SqlitePool;

use crate::domain::ForgetOutcome;
use crate::error::AppError;
use crate::repository::metadata;

use super::restore::load_snapshot;
use super::state::insert_fresh_record;
use super::{expires_at, now};

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
