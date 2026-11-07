//! Merge a trash snapshot into the identity that replaced the forgotten
//! book (the Merge choice of the restore conflict).

use std::collections::HashMap;

use sqlx::SqlitePool;

use super::state::restore_lists;
use crate::error::AppError;
use crate::repository::metadata;

use super::snapshot::BookSnapshot;

pub(super) async fn merge_into(
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
