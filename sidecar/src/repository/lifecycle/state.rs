//! Replay a trash snapshot into the durable tables: the fresh record, the
//! reading state, the lists, and the local trash row.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repository::metadata;

use super::snapshot::{BookRowSnapshot, BookSnapshot};
use super::{expires_at, now};

pub(super) async fn insert_fresh_record(
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

pub(super) async fn restore_replace(
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
    let restored_id: i64 = if snapshot.book_id > 0 && id_taken.is_none() {
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

pub(super) async fn restore_lists(
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

pub(super) async fn insert_local_trash(
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
