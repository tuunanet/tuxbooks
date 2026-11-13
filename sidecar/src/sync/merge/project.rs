//! Projection orchestration: which affected entities are pushed into the
//! local catalog, and the whole-book lifecycle projection.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::identity;
use crate::sync::kind::SyncIssueKind;
use crate::sync::model::EntityKind;

use super::catalog;
use super::state::load_state;
use super::Affected;

/// Project one entity's final mirror state into the local catalog. Collection
/// name collisions are resolved here because the local schema makes the name
/// unique.
pub async fn project(
    pool: &SqlitePool,
    folder_root: &std::path::Path,
    covers_dir: &std::path::Path,
    affected: &[Affected],
) -> Result<Vec<i64>, AppError> {
    let mut books = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in affected {
        if !seen.insert((item.kind, item.entity_uid.clone())) {
            continue;
        }
        if item.kind == EntityKind::BookIdentity {
            continue;
        }
        if item.kind == EntityKind::Collection {
            catalog::project_collection(pool, item).await?;
            continue;
        }
        if item.kind == EntityKind::Book {
            if let Some(id) = project_book_lifecycle(pool, &item.entity_uid).await? {
                books.push(id);
            }
            continue;
        }
        let Some(book_uid) = &item.book_uid else {
            continue;
        };
        let Some(book_id) = durable_record_id(pool, book_uid).await? else {
            continue;
        };
        let (state, deleted) = load_state(pool, item.kind, &item.entity_uid).await?;
        match item.kind {
            EntityKind::Annotation => {
                catalog::project_annotation(pool, book_id, item, &state, deleted).await?
            }
            EntityKind::Progress => {
                catalog::project_progress(pool, book_id, &state, deleted).await?
            }
            EntityKind::Metadata | EntityKind::Opened => {
                if item.kind == EntityKind::Metadata {
                    catalog::project_metadata(pool, book_id, folder_root, covers_dir, &state)
                        .await?
                } else {
                    catalog::project_opened(pool, book_id, &state).await?
                }
            }
            EntityKind::Membership => catalog::project_membership(pool, item, &state).await?,
            // The file version pointer is consumed by adoption (ADR 0018 D3);
            // projection touches nothing local.
            EntityKind::Collection
            | EntityKind::BookIdentity
            | EntityKind::Book
            | EntityKind::FileVersion => {}
        }
        books.push(book_id);
    }
    books.sort_unstable();
    books.dedup();
    Ok(books)
}

/// Project every shared entity attached to a book. Used when a newly imported
/// book binds to a portable id: state that arrived before the file existed is
/// applied in one step.
pub async fn project_book(
    pool: &SqlitePool,
    book_uid: &str,
    folder_root: &std::path::Path,
    covers_dir: &std::path::Path,
) -> Result<Vec<i64>, AppError> {
    if identity::forgotten_replacement(pool, book_uid)
        .await?
        .is_some()
    {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT kind, entity_uid, book_uid FROM sync_state_entities WHERE book_uid = ?1",
    )
    .bind(book_uid)
    .fetch_all(pool)
    .await?;
    let affected: Vec<Affected> = rows
        .into_iter()
        .filter_map(|(kind, entity_uid, book_uid)| {
            EntityKind::parse(&kind).map(|kind| Affected {
                kind,
                entity_uid,
                book_uid,
            })
        })
        .collect();
    project(pool, folder_root, covers_dir, &affected).await
}

/// The public numeric id of a durable book.
pub(super) async fn durable_record_id(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
        .bind(book_uid)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

/// Project a whole-book Forget, restore, or discard into the local durable
/// tables. The book-level mirror row is authoritative; a projection failure
/// becomes a visible Sync issue instead of silently dropping the snapshot.
async fn project_book_lifecycle(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<Option<i64>, AppError> {
    type LifecycleRow = (Option<String>, Option<String>, Option<String>, i64);
    let row: Option<LifecycleRow> = sqlx::query_as(
        "SELECT replacement_book_uid, snapshot_json, restored_at, discarded
         FROM sync_book_trash WHERE book_uid = ?1",
    )
    .bind(book_uid)
    .fetch_optional(pool)
    .await?;
    let Some((replacement, snapshot, restored_at, discarded)) = row else {
        return Ok(None);
    };
    let result = if restored_at.is_none() {
        crate::repository::lifecycle::apply_remote_forget(
            pool,
            book_uid,
            replacement.as_deref(),
            snapshot.as_deref(),
        )
        .await
    } else if discarded != 0 {
        crate::repository::lifecycle::apply_remote_discard(pool, book_uid).await
    } else {
        crate::repository::lifecycle::apply_remote_restore(pool, book_uid, snapshot.as_deref())
            .await
    };
    match result {
        Ok(id) => Ok(id),
        Err(err) => {
            identity::record_issue(
                pool,
                &format!("book-lifecycle:{book_uid}"),
                SyncIssueKind::BookLifecycleFailed,
                &format!("could not apply the shared change for forgotten book {book_uid}: {err}"),
                None,
            )
            .await?;
            Ok(None)
        }
    }
}

/// Replay the whole-book lifecycle projection from the mirror. Used by the
/// Retry action after `project_book_lifecycle` recorded a failure: the
/// operation is already marked applied, so another pass would not re-run it.
pub async fn retry_book_lifecycle(pool: &SqlitePool, book_uid: &str) -> Result<bool, AppError> {
    let canonical = identity::canonical_book_uid(pool, book_uid).await?;
    type LifecycleRow = (Option<String>, Option<String>, Option<String>, i64);
    let row: Option<LifecycleRow> = sqlx::query_as(
        "SELECT replacement_book_uid, snapshot_json, restored_at, discarded
         FROM sync_book_trash WHERE book_uid = ?1",
    )
    .bind(&canonical)
    .fetch_optional(pool)
    .await?;
    let Some((replacement, snapshot, restored_at, discarded)) = row else {
        return Ok(false);
    };
    if restored_at.is_none() {
        crate::repository::lifecycle::apply_remote_forget(
            pool,
            &canonical,
            replacement.as_deref(),
            snapshot.as_deref(),
        )
        .await?;
    } else if discarded != 0 {
        crate::repository::lifecycle::apply_remote_discard(pool, &canonical).await?;
    } else {
        crate::repository::lifecycle::apply_remote_restore(pool, &canonical, snapshot.as_deref())
            .await?;
    }
    Ok(true)
}
