//! Read a durable book into the portable trash snapshot, and turn a shared
//! snapshot back into rows this machine can hold.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::model::MAX_FIELD_STRING_BYTES;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub(super) struct BookRowSnapshot {
    pub(super) uid: String,
    pub(super) created_at: String,
    pub(super) title: Option<String>,
    pub(super) subtitle: Option<String>,
    pub(super) author: Option<String>,
    pub(super) publisher: Option<String>,
    pub(super) language: Option<String>,
    pub(super) isbn: Option<String>,
    pub(super) description: Option<String>,
    pub(super) publication_date: Option<String>,
    pub(super) series: Option<String>,
    pub(super) series_index: Option<f64>,
    pub(super) cover_path: Option<String>,
    pub(super) last_opened_at: Option<String>,
    pub(super) progress_percent: Option<f64>,
    pub(super) annotation_count: i64,
    pub(super) metadata_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub(super) struct ProgressSnapshot {
    pub(super) chapter_href: Option<String>,
    pub(super) cfi: Option<String>,
    pub(super) character_offset: Option<i64>,
    pub(super) page_number: Option<i64>,
    pub(super) scroll_offset: Option<f64>,
    pub(super) progress_percent: Option<f64>,
    pub(super) locator: Option<String>,
    pub(super) progression: Option<f64>,
    pub(super) locations: Option<String>,
    pub(super) engine: Option<String>,
    pub(super) schema_version: Option<i64>,
    pub(super) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub(super) struct AnnotationSnapshot {
    pub(super) sync_uid: Option<String>,
    pub(super) kind: String,
    pub(super) cfi: Option<String>,
    pub(super) chapter_href: Option<String>,
    pub(super) page_number: Option<i64>,
    pub(super) page_fraction: Option<f64>,
    pub(super) text: Option<String>,
    pub(super) color: Option<String>,
    pub(super) geometry: Option<String>,
    pub(super) note: Option<String>,
    pub(super) label: Option<String>,
    pub(super) created_at: String,
    pub(super) modified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub(super) struct CollectionSnapshot {
    pub(super) collection_id: i64,
    pub(super) added_at: String,
    /// Portable collection id. Local collection ids are machine-specific and
    /// must not cross the sync boundary.
    #[serde(default)]
    pub(super) collection_uid: Option<String>,
    #[serde(default)]
    pub(super) collection_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub(super) struct OverrideSnapshot {
    pub(super) title: Option<String>,
    pub(super) subtitle: Option<String>,
    pub(super) publisher: Option<String>,
    pub(super) language: Option<String>,
    pub(super) isbn: Option<String>,
    pub(super) description: Option<String>,
    pub(super) publication_date: Option<String>,
    pub(super) series: Option<String>,
    pub(super) series_index: Option<f64>,
    pub(super) cover_path: Option<String>,
    pub(super) authors_customized: bool,
    pub(super) subjects_customized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub(super) struct ProviderSnapshot {
    pub(super) provider: String,
    pub(super) remote_id: String,
    pub(super) status: Option<String>,
    pub(super) status_updated_at: Option<String>,
    pub(super) linked_at: String,
    pub(super) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct BookSnapshot {
    pub(super) book_id: i64,
    pub(super) book: BookRowSnapshot,
    pub(super) progress: Option<ProgressSnapshot>,
    pub(super) annotations: Vec<AnnotationSnapshot>,
    pub(super) collections: Vec<CollectionSnapshot>,
    pub(super) overrides: Option<OverrideSnapshot>,
    pub(super) authors: Vec<String>,
    pub(super) subjects: Vec<String>,
    pub(super) providers: Vec<ProviderSnapshot>,
    /// Content hashes that pointed at the old identity. Forget deletes them;
    /// the snapshot lets Replace recreate the old discovery index.
    pub(super) aliases: Vec<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(super) struct SnapshotRow {
    pub(super) id: i64,
    pub(super) book_id: i64,
    pub(super) book_uid: String,
    pub(super) replacement_book_uid: Option<String>,
    pub(super) snapshot_json: String,
    pub(super) deleted_at: String,
    pub(super) expires_at: String,
}

// Shared Forget and restore (ADR 0014 D3/D5, ticket tuxbooks-ip6.9)
// ---------------------------------------------------------------------------

pub(super) fn parse_snapshot(json: &str) -> Result<BookSnapshot, AppError> {
    serde_json::from_str(json)
        .map_err(|err| AppError::InvalidInput(format!("book snapshot is not readable: {err}")))
}

pub(super) fn serialize_snapshot(snapshot: &BookSnapshot) -> Result<String, AppError> {
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
pub(super) async fn local_snapshot_json(
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

pub(super) async fn load_book_row(
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
pub(super) async fn insert_fresh_from_row(
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
