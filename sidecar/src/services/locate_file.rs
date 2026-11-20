//! Locate File resolution: reconnect a missing book to a picked file, or
//! explain why that file already belongs to another library entry.
//!
//! The merge path only runs when it cannot misplace user state: an entry with
//! no progress, annotations, collections, overrides, provider or edition links
//! has nothing to lose, and identical bytes keep every locator valid.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sqlx::SqlitePool;

use crate::domain::Book;
use crate::error::AppError;
use crate::repository::books;
use crate::repository::reading_history;
use crate::services::library_reconciler::reconnect_book;
use crate::sync::identity::{hash_file, merge_book_identity};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocateOutcome {
    Reconnected {
        book: Book,
    },
    Merged {
        book: Book,
        #[serde(rename = "mergedFrom")]
        merged_from: MergedFrom,
    },
    Detached {
        book: Book,
        #[serde(rename = "detachedFrom")]
        detached_from: MergedFrom,
    },
    Conflict {
        conflict: Box<LocateConflict>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedFrom {
    pub id: i64,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateConflict {
    /// The library entry that already owns the picked file.
    pub owner: Book,
    /// The missing entry Locate File was trying to restore.
    pub candidate: Book,
    pub candidate_state: LocateState,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateState {
    pub annotations: i64,
    pub has_progress: bool,
    pub progress_percent: Option<f64>,
    pub collections: i64,
    pub has_metadata_overrides: bool,
    pub provider_links: i64,
    pub edition_links: i64,
}

impl LocateState {
    /// User-authored state that a different-bytes merge could misplace.
    /// Last-opened alone is not content and does not block the merge.
    pub fn has_state(&self) -> bool {
        self.annotations > 0
            || self.has_progress
            || self.collections > 0
            || self.has_metadata_overrides
            || self.provider_links > 0
            || self.edition_links > 0
    }
}

/// Resolve one Locate File pick. A path outside the library reconnects the
/// missing book. A path another entry owns merges when that is lossless and
/// otherwise reports the conflict for the user to resolve.
pub async fn locate_book(
    pool: &SqlitePool,
    book_id: i64,
    path: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
) -> Result<LocateOutcome, AppError> {
    if !path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "no file exists at {}",
            path.display()
        )));
    }
    let candidate = books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let picked = path.to_string_lossy().into_owned();
    let Some(existing_file_id) = books::find_file_id_by_path(pool, &picked).await? else {
        let book = reconnect_book(pool, book_id, path, covers_dir, pdfium_dirs).await?;
        return Ok(LocateOutcome::Reconnected { book });
    };
    let owner_id = books::durable_id_for_file(pool, existing_file_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if owner_id == book_id {
        // The picked path is another file row of the same durable book; make
        // that row available instead of reporting a no-op reconnect.
        let (size, mtime) = crate::services::book_importer::file_stats(path).ok_or_else(|| {
            AppError::InvalidInput(format!("could not read that file: {}", path.display()))
        })?;
        match books::relink_book(pool, existing_file_id, &picked, size, mtime).await? {
            books::RelinkOutcome::Relinked => {}
            books::RelinkOutcome::PathConflict => {
                return Err(AppError::InvalidInput(
                    "that path is already attached to another book".into(),
                ));
            }
        }
        let book = books::get_book(pool, book_id)
            .await?
            .ok_or(AppError::NotFound)?;
        return Ok(LocateOutcome::Reconnected { book });
    }
    let owner = books::get_book(pool, owner_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let candidate_uid = candidate.book_uid.clone().ok_or_else(|| {
        AppError::InvalidInput("this library entry has no durable identity".into())
    })?;
    let owner_uid = owner.book_uid.clone().ok_or_else(|| {
        AppError::InvalidInput("the entry that owns this file has no durable identity".into())
    })?;

    let state = load_state(pool, &candidate_uid).await?;
    if !state.has_state() {
        // Nothing user-authored can be misplaced. Detach the stale entry to
        // Reading history instead of merging two different byte streams, and
        // record the owner so the row explains what it is.
        reading_history::detach_duplicate(pool, candidate.id, &owner_uid).await?;
        let book = books::get_book(pool, owner_id)
            .await?
            .ok_or(AppError::NotFound)?;
        return Ok(LocateOutcome::Detached {
            book,
            detached_from: MergedFrom {
                id: candidate.id,
                title: candidate.title,
            },
        });
    }
    if matches_bound_hash(pool, &candidate_uid, path).await? {
        merge_book_identity(pool, &candidate_uid, &owner_uid).await?;
        if !books::file_ids_for_book(pool, candidate.id)
            .await?
            .is_empty()
        {
            return Err(AppError::InvalidInput(
                "this entry could not be merged; pick another file or move it to Reading history"
                    .into(),
            ));
        }
        let book = books::get_book(pool, owner_id)
            .await?
            .ok_or(AppError::NotFound)?;
        return Ok(LocateOutcome::Merged {
            book,
            merged_from: MergedFrom {
                id: candidate.id,
                title: candidate.title,
            },
        });
    }

    Ok(LocateOutcome::Conflict {
        conflict: Box::new(LocateConflict {
            owner,
            candidate,
            candidate_state: state,
        }),
    })
}

async fn load_state(pool: &SqlitePool, book_uid: &str) -> Result<LocateState, AppError> {
    let annotations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let has_progress: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM reading_progress WHERE book_uid = ?1)")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let progress_percent: Option<f64> =
        sqlx::query_scalar("SELECT progress_percent FROM reading_progress WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_optional(pool)
            .await?
            .flatten();
    let collections: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let has_metadata_overrides: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM book_metadata_overrides WHERE book_uid = ?1)",
    )
    .bind(book_uid)
    .fetch_one(pool)
    .await?;
    let provider_links: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM book_provider_links WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let edition_links: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM book_edition_links WHERE book_uid_a = ?1 OR book_uid_b = ?1",
    )
    .bind(book_uid)
    .fetch_one(pool)
    .await?;
    Ok(LocateState {
        annotations,
        has_progress,
        progress_percent,
        collections,
        has_metadata_overrides,
        provider_links,
        edition_links,
    })
}

/// Whether the picked bytes match any hash this entry was bound to. A missing
/// binding means the app cannot prove the bytes are the same, so it asks.
async fn matches_bound_hash(
    pool: &SqlitePool,
    book_uid: &str,
    path: &Path,
) -> Result<bool, AppError> {
    let hashes: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT content_hash FROM sync_book_bindings WHERE book_uid = ?1",
    )
    .bind(book_uid)
    .fetch_all(pool)
    .await?;
    if hashes.is_empty() {
        return Ok(false);
    }
    let path = path.to_path_buf();
    let (picked, _, _) = tokio::task::spawn_blocking(move || hash_file(&path))
        .await
        .map_err(|err| AppError::InvalidInput(format!("could not hash that file: {err}")))?
        .map_err(|err| AppError::InvalidInput(format!("could not read that file: {err}")))?;
    Ok(hashes.iter().any(|hash| hash == &picked))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_book(id: i64, title: &str) -> Book {
        Book {
            id,
            book_uid: Some(format!("{id:032x}")),
            file_id: Some(id),
            path: format!("/library/{id}.epub"),
            title: title.into(),
            subtitle: None,
            author: None,
            publisher: None,
            language: None,
            isbn: None,
            description: None,
            cover_path: None,
            added_at: chrono::Utc::now(),
            modified_at: chrono::Utc::now(),
            last_opened_at: None,
            available: true,
            file_size: 1,
            file_mtime: 1,
            hash_state: "hashed".into(),
            publication_date: None,
            series_id: None,
            series_index: None,
            series_name: None,
            progress_percent: None,
            progress_updated_at: None,
            provider_links: Vec::new(),
            newer_version_available: false,
        }
    }

    #[test]
    fn merged_outcome_uses_the_camel_case_wire_format() {
        let outcome = LocateOutcome::Merged {
            book: sample_book(4, "Machine Learning"),
            merged_from: MergedFrom {
                id: 3,
                title: "Old copy".into(),
            },
        };
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["kind"], "merged");
        assert_eq!(value["mergedFrom"]["id"], 3);
        assert_eq!(value["book"]["title"], "Machine Learning");
    }

    #[test]
    fn conflict_outcome_wraps_the_payload_and_state() {
        let outcome = LocateOutcome::Conflict {
            conflict: Box::new(LocateConflict {
                owner: sample_book(4, "Machine Learning"),
                candidate: sample_book(3, "Old copy"),
                candidate_state: LocateState {
                    annotations: 2,
                    progress_percent: Some(40.0),
                    ..LocateState::default()
                },
            }),
        };
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["kind"], "conflict");
        assert_eq!(value["conflict"]["owner"]["title"], "Machine Learning");
        assert_eq!(value["conflict"]["candidateState"]["annotations"], 2);
        assert_eq!(value["conflict"]["candidateState"]["progressPercent"], 40.0);
    }
}
