//! Apply what another machine shared: a Forget, a restore, or the discard
//! that closes a trash entry after Keep or Merge.

use sqlx::SqlitePool;

use crate::error::AppError;

use super::now;
use super::restore::restore_conflict;
use super::snapshot::{
    insert_fresh_from_row, load_book_row, local_snapshot_json, parse_snapshot, BookRowSnapshot,
};
use super::state::{insert_local_trash, restore_replace};

async fn mark_library_reload(pool: &SqlitePool) -> Result<(), AppError> {
    crate::sync::clock::set_meta(pool, crate::sync::clock::META_LIBRARY_RELOAD, "1").await
}

pub async fn apply_remote_forget(
    pool: &SqlitePool,
    old_uid: &str,
    replacement_uid: Option<&str>,
    shared_snapshot: Option<&str>,
) -> Result<Option<i64>, AppError> {
    // The file moves to a fresh identity while its old card is still up.
    mark_library_reload(pool).await?;
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
    // The fresh identity loses its record to the restored one.
    mark_library_reload(pool).await?;
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
