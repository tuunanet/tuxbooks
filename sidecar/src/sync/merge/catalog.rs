//! The per-kind catalog projections: mirror state becomes rows in the local
//! annotations, reading progress, collections, memberships, and book records.

use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::model::{EntityKind, State};
use crate::sync::store;

use super::project::durable_record_id;
use super::state::load_state;
use super::Affected;

pub(super) async fn project_annotation(
    pool: &SqlitePool,
    book_id: i64,
    item: &Affected,
    state: &State,
    deleted: bool,
) -> Result<(), AppError> {
    if deleted {
        sqlx::query("DELETE FROM annotations WHERE sync_uid = ?1")
            .bind(&item.entity_uid)
            .execute(pool)
            .await?;
        return Ok(());
    }
    let kind = state
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("bookmark");
    sqlx::query(
        r#"
        INSERT INTO annotations
            (book_uid, sync_uid, kind, cfi, chapter_href, page_number, page_fraction,
             text, color, geometry, note, label, created_at, modified_at)
        VALUES ((SELECT uid FROM book_records WHERE id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                COALESCE(?13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(sync_uid) DO UPDATE SET
            book_uid = excluded.book_uid,
            kind = excluded.kind,
            cfi = excluded.cfi,
            chapter_href = excluded.chapter_href,
            page_number = excluded.page_number,
            page_fraction = excluded.page_fraction,
            text = excluded.text,
            color = excluded.color,
            geometry = excluded.geometry,
            note = excluded.note,
            label = excluded.label,
            modified_at = excluded.modified_at
        "#,
    )
    .bind(book_id)
    .bind(&item.entity_uid)
    .bind(kind)
    .bind(string_or_none(state, "cfi"))
    .bind(string_or_none(state, "chapter_href"))
    .bind(integer_or_none(state, "page_number"))
    .bind(number_or_none(state, "page_fraction"))
    .bind(string_or_none(state, "text"))
    .bind(string_or_none(state, "color"))
    .bind(string_or_none(state, "geometry"))
    .bind(string_or_none(state, "note"))
    .bind(string_or_none(state, "label"))
    .bind(string_or_none(state, "created_at"))
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn project_progress(
    pool: &SqlitePool,
    book_id: i64,
    state: &State,
    deleted: bool,
) -> Result<(), AppError> {
    if deleted {
        sqlx::query(
            "DELETE FROM reading_progress \
             WHERE book_uid = (SELECT uid FROM book_records WHERE id = ?1)",
        )
        .bind(book_id)
        .execute(pool)
        .await?;
        return Ok(());
    }
    sqlx::query(
        r#"
        INSERT INTO reading_progress
            (book_uid, chapter_href, cfi, character_offset, page_number, scroll_offset,
             progress_percent, locator, progression, locations, engine, schema_version)
        VALUES ((SELECT uid FROM book_records WHERE id = ?1),
                ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(book_id)
    .bind(string_or_none(state, "chapter_href"))
    .bind(string_or_none(state, "cfi"))
    .bind(integer_or_none(state, "character_offset"))
    .bind(integer_or_none(state, "page_number"))
    .bind(number_or_none(state, "scroll_offset"))
    .bind(number_or_none(state, "progress_percent"))
    .bind(string_or_none(state, "locator"))
    .bind(number_or_none(state, "progression"))
    .bind(string_or_none(state, "locations"))
    .bind(string_or_none(state, "engine"))
    .bind(integer_or_none(state, "schema_version"))
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn project_opened(
    pool: &SqlitePool,
    book_id: i64,
    state: &State,
) -> Result<(), AppError> {
    sqlx::query("UPDATE book_records SET last_opened_at = ?2 WHERE id = ?1")
        .bind(book_id)
        .bind(string_or_none(state, "last_opened_at"))
        .execute(pool)
        .await?;
    Ok(())
}

pub(super) async fn project_metadata(
    pool: &SqlitePool,
    book_id: i64,
    folder_root: &std::path::Path,
    covers_dir: &std::path::Path,
    state: &State,
) -> Result<(), AppError> {
    let cover_name = string_or_none(state, "cover_path");
    let cover_path = match cover_name {
        Some(name) => {
            if store::apply_cover_blob(folder_root, covers_dir, &name)? {
                Some(covers_dir.join(&name).to_string_lossy().into_owned())
            } else {
                None
            }
        }
        None => None,
    };
    let overrides = crate::repository::metadata::OverrideRow {
        title: string_or_none(state, "title"),
        subtitle: string_or_none(state, "subtitle"),
        publisher: string_or_none(state, "publisher"),
        language: string_or_none(state, "language"),
        isbn: string_or_none(state, "isbn"),
        description: string_or_none(state, "description"),
        publication_date: string_or_none(state, "publication_date"),
        series: string_or_none(state, "series"),
        series_index: number_or_none(state, "series_index"),
        cover_path,
        authors_customized: state
            .get("authors_customized")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        subjects_customized: state
            .get("subjects_customized")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    crate::services::metadata::apply_synced_overrides(
        pool,
        book_id,
        &overrides,
        &string_list(state, "authors"),
        &string_list(state, "subjects"),
    )
    .await
}

pub(super) async fn project_membership(
    pool: &SqlitePool,
    item: &Affected,
    state: &State,
) -> Result<(), AppError> {
    let Some((collection_uid, book_uid)) = item.entity_uid.split_once(':') else {
        return Ok(());
    };
    let present = state
        .get("present")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if durable_record_id(pool, book_uid).await?.is_none() {
        return Ok(());
    }
    let Some(collection_id) = local_collection_id(pool, collection_uid).await? else {
        return Ok(());
    };
    if present {
        // The op carries the timestamp from the device that added the book.
        // Keep it: the local default only covers a legacy payload with no
        // added_at, and an existing row keeps its time rather than moving to
        // this device's clock.
        sqlx::query(
            "INSERT INTO book_collections (book_uid, collection_id, added_at) \
             VALUES (?1, ?2, COALESCE(?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) \
             ON CONFLICT(book_uid, collection_id) DO UPDATE SET \
                 added_at = COALESCE(?3, book_collections.added_at)",
        )
        .bind(book_uid)
        .bind(collection_id)
        .bind(string_or_none(state, "added_at"))
        .execute(pool)
        .await?;
    } else {
        sqlx::query("DELETE FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2")
            .bind(book_uid)
            .bind(collection_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub(super) async fn project_collection(pool: &SqlitePool, item: &Affected) -> Result<(), AppError> {
    let (state, deleted) = load_state(pool, EntityKind::Collection, &item.entity_uid).await?;
    if deleted {
        sqlx::query("DELETE FROM collections WHERE sync_uid = ?1")
            .bind(&item.entity_uid)
            .execute(pool)
            .await?;
        return Ok(());
    }
    let Some(name) = state.get("name").and_then(Value::as_str) else {
        return Ok(());
    };
    let created_at = state
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00.000Z");

    let by_uid: Option<i64> = sqlx::query_scalar("SELECT id FROM collections WHERE sync_uid = ?1")
        .bind(&item.entity_uid)
        .fetch_optional(pool)
        .await?;
    if let Some(id) = by_uid {
        sqlx::query("UPDATE collections SET name = ?2, created_at = ?3 WHERE id = ?1")
            .bind(id)
            .bind(name)
            .bind(created_at)
            .execute(pool)
            .await?;
        project_collection_memberships(pool, &item.entity_uid).await?;
        return Ok(());
    }

    let same_name: Option<(i64, String)> =
        sqlx::query_as("SELECT id, COALESCE(sync_uid, '') FROM collections WHERE name = ?1")
            .bind(name)
            .fetch_optional(pool)
            .await?;
    if let Some((id, local_uid)) = same_name {
        let canonical = if local_uid.is_empty() {
            item.entity_uid.clone()
        } else if local_uid <= item.entity_uid {
            local_uid.clone()
        } else {
            item.entity_uid.clone()
        };
        if !local_uid.is_empty() && local_uid != canonical {
            crate::sync::identity::merge_collection_identity(pool, &local_uid, &canonical).await?;
        }
        if canonical != item.entity_uid {
            crate::sync::identity::merge_collection_identity(pool, &item.entity_uid, &canonical)
                .await?;
        }
        // The surviving row keeps the local id, so memberships keep pointing
        // at it; only the portable uid and display fields change.
        sqlx::query(
            "UPDATE collections SET sync_uid = ?2, name = ?3, created_at = ?4 WHERE id = ?1",
        )
        .bind(id)
        .bind(&canonical)
        .bind(name)
        .bind(created_at)
        .execute(pool)
        .await?;
        project_collection_memberships(pool, &canonical).await?;
        return Ok(());
    }

    sqlx::query("INSERT INTO collections (sync_uid, name, created_at) VALUES (?1, ?2, ?3)")
        .bind(&item.entity_uid)
        .bind(name)
        .bind(created_at)
        .execute(pool)
        .await?;
    project_collection_memberships(pool, &item.entity_uid).await?;
    Ok(())
}

async fn project_collection_memberships(
    pool: &SqlitePool,
    collection_uid: &str,
) -> Result<(), AppError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities
         WHERE kind = 'membership' AND entity_uid LIKE ?1",
    )
    .bind(format!("{collection_uid}:%"))
    .fetch_all(pool)
    .await?;
    for entity_uid in rows {
        let (state, deleted) = load_state(pool, EntityKind::Membership, &entity_uid).await?;
        if deleted {
            continue;
        }
        project_membership(
            pool,
            &Affected {
                kind: EntityKind::Membership,
                entity_uid,
                book_uid: None,
            },
            &state,
        )
        .await?;
    }
    Ok(())
}

async fn local_collection_id(
    pool: &SqlitePool,
    collection_uid: &str,
) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM collections WHERE sync_uid = ?1")
        .bind(collection_uid)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

fn string_or_none(state: &State, field: &str) -> Option<String> {
    state
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn integer_or_none(state: &State, field: &str) -> Option<i64> {
    state.get(field).and_then(Value::as_i64)
}

fn number_or_none(state: &State, field: &str) -> Option<f64> {
    state.get(field).and_then(Value::as_f64)
}

fn string_list(state: &State, field: &str) -> Vec<String> {
    state
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}
