//! Book identity: a shared uuid linked to content hashes.
//!
//! Paths and row ids are machine-specific. A book's shared identity is a uuid;
//! the SHA-256 of its bytes is only a discovery key. A metadata embed rewrites
//! the file, so the same uuid gains a new hash alias instead of becoming a new
//! book.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::error::AppError;

use super::clock::now_rfc3339;
use super::model::{EntityKind, Hlc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookIdentity {
    pub book_id: i64,
    pub book_uid: String,
    pub content_hash: String,
    pub size: i64,
    pub mtime: i64,
}

/// Hash the book file and bind the row, or return `None` when the file is
/// unavailable. Hashing runs on the blocking pool: a 1 GiB PDF must not stall
/// the Tokio reactor.
pub async fn ensure_book_identity(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<BookIdentity>, AppError> {
    let row: Option<(String, i64, i64, i64)> =
        sqlx::query_as("SELECT path, available, file_size, file_mtime FROM books WHERE id = ?1")
            .bind(book_id)
            .fetch_optional(pool)
            .await?;
    let Some((path, available, stored_size, stored_mtime)) = row else {
        return Ok(None);
    };
    if available == 0 {
        return Ok(None);
    }

    let existing: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT book_uid, content_hash, hashed_size, hashed_mtime
         FROM sync_book_bindings WHERE book_id = ?1",
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    if let Some((uid, hash, size, mtime)) = &existing {
        if *size == stored_size && *mtime == stored_mtime {
            return Ok(Some(BookIdentity {
                book_id,
                book_uid: uid.clone(),
                content_hash: hash.clone(),
                size: *size,
                mtime: *mtime,
            }));
        }
    }

    let path = PathBuf::from(path);
    let hashed = match tokio::task::spawn_blocking(move || hash_file(&path)).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => return Ok(None),
        Err(err) => {
            return Err(AppError::InvalidInput(format!(
                "book hash task failed: {err}"
            )))
        }
    };
    let (hash, size, mtime) = hashed;
    bind_hash(pool, book_id, &hash, size, mtime).await
}

fn hash_file(path: &Path) -> Result<(String, i64, i64), std::io::Error> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((
        format!("{:x}", hasher.finalize()),
        metadata.len() as i64,
        mtime,
    ))
}

pub async fn bind_hash(
    pool: &SqlitePool,
    book_id: i64,
    content_hash: &str,
    size: i64,
    mtime: i64,
) -> Result<Option<BookIdentity>, AppError> {
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT book_uid, content_hash FROM sync_book_bindings WHERE book_id = ?1")
            .bind(book_id)
            .fetch_optional(pool)
            .await?;
    let alias: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(content_hash)
            .fetch_optional(pool)
            .await?;

    let existing_uid = match &existing {
        Some((uid, _)) => Some(canonical_book_uid(pool, uid).await?),
        None => None,
    };
    let alias_uid = match &alias {
        Some(uid) => Some(canonical_book_uid(pool, uid).await?),
        None => None,
    };
    let uid = match (&existing_uid, &alias_uid) {
        (Some(existing), Some(alias)) => existing.min(alias).clone(),
        (Some(existing), None) => existing.clone(),
        (None, Some(alias)) => alias.clone(),
        (None, None) => {
            sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
                .fetch_one(pool)
                .await?
        }
    };

    if let (Some(existing), Some(alias)) = (&existing_uid, &alias_uid) {
        if existing != alias {
            let (loser, winner) = if existing < alias {
                (alias, existing)
            } else {
                (existing, alias)
            };
            merge_book_identity(pool, loser, winner).await?;
        }
    } else if let Some(existing) = &existing_uid {
        if existing != &uid {
            merge_book_identity(pool, existing, &uid).await?;
        }
    } else if let Some(alias) = &alias_uid {
        if alias != &uid {
            merge_book_identity(pool, alias, &uid).await?;
        }
    }

    sqlx::query(
        r#"
        INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)
        ON CONFLICT(content_hash) DO UPDATE SET book_uid = excluded.book_uid
        "#,
    )
    .bind(content_hash)
    .bind(&uid)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO sync_book_bindings
            (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(book_id) DO UPDATE SET
            book_uid = excluded.book_uid,
            content_hash = excluded.content_hash,
            hashed_size = excluded.hashed_size,
            hashed_mtime = excluded.hashed_mtime,
            bound_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(book_id)
    .bind(&uid)
    .bind(content_hash)
    .bind(size)
    .bind(mtime)
    .execute(pool)
    .await?;

    let hash_is_new = existing
        .as_ref()
        .is_none_or(|(_, hash)| hash != content_hash);
    if hash_is_new {
        mark_identity_dirty(pool, content_hash, &uid).await?;
    }

    Ok(Some(BookIdentity {
        book_id,
        book_uid: uid,
        content_hash: content_hash.to_string(),
        size,
        mtime,
    }))
}

/// Publish an alias through the normal dirty/op pipeline. Identity operations
/// are not produced by a SQL trigger, so the identity service reaches the same
/// table the capture pass drains.
pub async fn mark_identity_dirty(
    pool: &SqlitePool,
    content_hash: &str,
    book_uid: &str,
) -> Result<(), AppError> {
    let payload = serde_json::json!({
        "content_hash": content_hash,
        "book_uid": book_uid,
    });
    sqlx::query(
        r#"
        INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
        VALUES ('book_identity', ?1, 'upsert', NULL, ?2)
        ON CONFLICT(kind, entity_key) DO UPDATE SET
            op = 'upsert',
            old_json = NULL,
            new_json = excluded.new_json,
            changed_at = excluded.changed_at
        "#,
    )
    .bind(content_hash)
    .bind(payload.to_string())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn canonical_book_uid(pool: &SqlitePool, uid: &str) -> Result<String, AppError> {
    let mut current = uid.to_string();
    for _ in 0..32 {
        let next: Option<String> =
            sqlx::query_scalar("SELECT winner FROM sync_book_merges WHERE loser = ?1")
                .bind(&current)
                .fetch_optional(pool)
                .await?;
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    Ok(current)
}

/// Re-key every shared row from `loser` to `winner`. This is how two devices
/// that imported the same bytes before meeting converge on one identity.
pub async fn merge_book_identity(
    pool: &SqlitePool,
    loser: &str,
    winner: &str,
) -> Result<(), AppError> {
    let winner = canonical_book_uid(pool, winner).await?;
    let loser = canonical_book_uid(pool, loser).await?;
    if loser == winner {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)
        ON CONFLICT(loser) DO UPDATE SET winner = excluded.winner
        "#,
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE sync_book_bindings SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sync_book_aliases SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;

    for kind in [
        EntityKind::Progress,
        EntityKind::Metadata,
        EntityKind::Opened,
    ] {
        merge_self_keyed(&mut tx, kind, &loser, &winner).await?;
    }
    sqlx::query("UPDATE sync_state_entities SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;

    // Memberships are keyed collection:book, so the suffix changes too.
    let memberships: Vec<String> = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities
         WHERE kind = 'membership' AND book_uid = ?1",
    )
    .bind(&winner)
    .fetch_all(&mut *tx)
    .await?;
    for uid in memberships {
        if let Some((collection, _)) = uid.rsplit_once(':') {
            let next = format!("{collection}:{winner}");
            merge_entity_uid(&mut tx, EntityKind::Membership, &uid, &next, &winner).await?;
        }
    }

    sqlx::query("UPDATE sync_trash SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn merge_self_keyed(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    loser: &str,
    winner: &str,
) -> Result<(), AppError> {
    if kind.merge_mode() == super::model::MergeMode::Entity {
        let loser_clock = entity_clock(tx, kind, loser).await?;
        let winner_clock = entity_clock(tx, kind, winner).await?;
        match (loser_clock, winner_clock) {
            (Some(loser_hlc), Some(winner_hlc)) => {
                if loser_hlc > winner_hlc {
                    sqlx::query(
                        "DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(winner)
                    .execute(&mut **tx)
                    .await?;
                    sqlx::query(
                        "DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(winner)
                    .execute(&mut **tx)
                    .await?;
                    rekey_entity_uid(tx, kind, loser, winner, Some(winner)).await?;
                } else {
                    sqlx::query(
                        "DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(loser)
                    .execute(&mut **tx)
                    .await?;
                    sqlx::query(
                        "DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(loser)
                    .execute(&mut **tx)
                    .await?;
                }
            }
            (Some(_), None) => {
                rekey_entity_uid(tx, kind, loser, winner, Some(winner)).await?;
            }
            _ => {}
        }
    } else {
        // Field-level: each field keeps whichever clock is newer. The winner
        // entity may not exist yet (the only state was under the loser), so
        // materialize the entity row before moving fields under it.
        sqlx::query(
            r#"
            INSERT INTO sync_state_entities
                (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device,
                 deleted, deleted_wall, deleted_count, deleted_dev,
                 restored_wall, restored_count, restored_dev)
            SELECT kind, ?2, ?2, hlc_wall, hlc_counter, hlc_device,
                   deleted, deleted_wall, deleted_count, deleted_dev,
                   restored_wall, restored_count, restored_dev
            FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?3
            ON CONFLICT(kind, entity_uid) DO NOTHING
            "#,
        )
        .bind(kind.as_str())
        .bind(winner)
        .bind(loser)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
            SELECT ?1, ?2, ?2
            WHERE EXISTS (
                SELECT 1 FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?3
            )
            ON CONFLICT(kind, entity_uid) DO NOTHING
            "#,
        )
        .bind(kind.as_str())
        .bind(winner)
        .bind(loser)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
            SELECT kind, ?2, field, value_json, hlc_wall, hlc_counter, hlc_device
            FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?3
            ON CONFLICT(kind, entity_uid, field) DO UPDATE SET
                value_json = excluded.value_json,
                hlc_wall = excluded.hlc_wall,
                hlc_counter = excluded.hlc_counter,
                hlc_device = excluded.hlc_device
            WHERE (excluded.hlc_wall, excluded.hlc_counter, excluded.hlc_device)
                > (sync_state_fields.hlc_wall, sync_state_fields.hlc_counter,
                   sync_state_fields.hlc_device)
            "#,
        )
        .bind(kind.as_str())
        .bind(winner)
        .bind(loser)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2")
            .bind(kind.as_str())
            .bind(loser)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2")
            .bind(kind.as_str())
            .bind(loser)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn entity_clock(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    uid: &str,
) -> Result<Option<Hlc>, AppError> {
    let row: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT hlc_wall, hlc_counter, hlc_device FROM sync_state_entities
         WHERE kind = ?1 AND entity_uid = ?2",
    )
    .bind(kind.as_str())
    .bind(uid)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|(wall, counter, device)| Hlc {
        wall,
        counter: counter as u32,
        device,
    }))
}

async fn rekey_entity_uid(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    from: &str,
    to: &str,
    book_uid: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query("UPDATE sync_state_fields SET entity_uid = ?2 WHERE kind = ?1 AND entity_uid = ?3")
        .bind(kind.as_str())
        .bind(to)
        .bind(from)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "UPDATE sync_state_entities SET entity_uid = ?2, book_uid = COALESCE(?3, book_uid)
         WHERE kind = ?1 AND entity_uid = ?4",
    )
    .bind(kind.as_str())
    .bind(to)
    .bind(book_uid)
    .bind(from)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn merge_entity_uid(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    from: &str,
    to: &str,
    book_uid: &str,
) -> Result<(), AppError> {
    if from == to {
        return Ok(());
    }
    let from_clock = entity_clock(tx, kind, from).await?;
    let to_clock = entity_clock(tx, kind, to).await?;
    match (from_clock, to_clock) {
        (Some(from_hlc), Some(to_hlc)) => {
            if from_hlc > to_hlc {
                sqlx::query("DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(to)
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(to)
                    .execute(&mut **tx)
                    .await?;
                rekey_entity_uid(tx, kind, from, to, Some(book_uid)).await?;
            } else {
                sqlx::query("DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(from)
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(from)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        (Some(_), None) => rekey_entity_uid(tx, kind, from, to, Some(book_uid)).await?,
        _ => {}
    }
    Ok(())
}

/// Merge two local collections that share a name (the local UNIQUE constraint
/// means the user sees one shelf). The caller picks canonical ids and projects
/// the surviving row.
pub async fn merge_collection_identity(
    pool: &SqlitePool,
    loser: &str,
    winner: &str,
) -> Result<(), AppError> {
    if loser == winner {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)
        ON CONFLICT(kind, loser) DO UPDATE SET winner = excluded.winner
        "#,
    )
    .bind(loser)
    .bind(winner)
    .execute(&mut *tx)
    .await?;

    // The collection entity is field-level (name/created_at). Make sure the
    // surviving entity exists before moving fields under it.
    sqlx::query(
        "INSERT INTO sync_state_entities (kind, entity_uid) VALUES ('collection', ?1)
         ON CONFLICT(kind, entity_uid) DO NOTHING",
    )
    .bind(winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
        SELECT kind, ?2, field, value_json, hlc_wall, hlc_counter, hlc_device
        FROM sync_state_fields WHERE kind = 'collection' AND entity_uid = ?1
        ON CONFLICT(kind, entity_uid, field) DO UPDATE SET
            value_json = excluded.value_json,
            hlc_wall = excluded.hlc_wall,
            hlc_counter = excluded.hlc_counter,
            hlc_device = excluded.hlc_device
        WHERE (excluded.hlc_wall, excluded.hlc_counter, excluded.hlc_device)
            > (sync_state_fields.hlc_wall, sync_state_fields.hlc_counter,
               sync_state_fields.hlc_device)
        "#,
    )
    .bind(loser)
    .bind(winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sync_state_fields WHERE kind = 'collection' AND entity_uid = ?1")
        .bind(loser)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sync_state_entities WHERE kind = 'collection' AND entity_uid = ?1")
        .bind(loser)
        .execute(&mut *tx)
        .await?;
    // Membership entity ids embed the collection uid.
    let memberships: Vec<String> = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities
         WHERE kind = 'membership' AND entity_uid LIKE ?1",
    )
    .bind(format!("{loser}:%"))
    .fetch_all(&mut *tx)
    .await?;
    for uid in memberships {
        if let Some((_, book)) = uid.rsplit_once(':') {
            let next = format!("{winner}:{book}");
            merge_entity_uid(&mut tx, EntityKind::Membership, &uid, &next, book).await?;
        }
    }
    sqlx::query(
        "UPDATE sync_trash SET entity_uid = ?2 WHERE kind = 'collection' AND entity_uid = ?1",
    )
    .bind(loser)
    .bind(winner)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn canonical_entity_uid(
    pool: &SqlitePool,
    kind: EntityKind,
    uid: &str,
) -> Result<String, AppError> {
    let mut current = uid.to_string();
    for _ in 0..32 {
        let next: Option<String> = sqlx::query_scalar(
            "SELECT winner FROM sync_entity_merges WHERE kind = ?1 AND loser = ?2",
        )
        .bind(kind.as_str())
        .bind(&current)
        .fetch_optional(pool)
        .await?;
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    Ok(current)
}

/// Record an issue without duplicating an open row for the same key.
pub async fn record_issue(
    pool: &SqlitePool,
    key: &str,
    kind: &str,
    detail: &str,
    file_name: Option<&str>,
) -> Result<(), AppError> {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM sync_issues WHERE issue_key = ?1 AND resolved_at IS NULL LIMIT 1",
    )
    .bind(key)
    .fetch_optional(pool)
    .await?;
    if let Some(id) = existing {
        sqlx::query(
            "UPDATE sync_issues SET kind = ?2, detail = ?3, file_name = ?4,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        )
        .bind(id)
        .bind(kind)
        .bind(detail)
        .bind(file_name)
        .execute(pool)
        .await?;
        return Ok(());
    }
    sqlx::query(
        r#"
        INSERT INTO sync_issues (issue_key, kind, detail, file_name)
        VALUES (?1, ?2, ?3, ?4)
        "#,
    )
    .bind(key)
    .bind(kind)
    .bind(detail)
    .bind(file_name)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn touch_last_sync(pool: &SqlitePool) -> Result<(), AppError> {
    super::clock::set_meta(pool, super::clock::META_LAST_SYNC, &now_rfc3339()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::NewBook;
    use crate::repository::books;

    fn snapshot(path: &std::path::Path) -> (i64, i64) {
        let metadata = std::fs::metadata(path).unwrap();
        let mtime = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        (metadata.len() as i64, mtime)
    }

    async fn book_with_file(pool: &SqlitePool, path: &std::path::Path) -> i64 {
        let (file_size, file_mtime) = snapshot(path);
        books::upsert_book(
            pool,
            &NewBook {
                path: path.to_string_lossy().into_owned(),
                title: "Identity test".into(),
                subtitle: None,
                author: None,
                authors: Vec::new(),
                subjects: Vec::new(),
                publisher: None,
                language: None,
                isbn: None,
                description: None,
                publication_date: None,
                series: None,
                series_index: None,
                cover_path: None,
                file_size,
                file_mtime,
            },
        )
        .await
        .unwrap()
        .0
    }

    #[tokio::test]
    async fn a_rewrite_keeps_the_uuid_and_adds_a_hash_alias() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::write(&path, b"version one").unwrap();
        let book_id = book_with_file(&pool, &path).await;

        let first = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();
        std::fs::write(&path, b"version two is longer").unwrap();
        let (file_size, file_mtime) = snapshot(&path);
        books::update_file_snapshot(&pool, book_id, file_size, file_mtime)
            .await
            .unwrap();
        let second = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();

        assert_eq!(first.book_uid, second.book_uid);
        assert_ne!(first.content_hash, second.content_hash);
        let aliases: Vec<(String, String)> =
            sqlx::query_as("SELECT content_hash, book_uid FROM sync_book_aliases")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(aliases.len(), 2);
        assert!(aliases.iter().all(|(_, uid)| uid == &first.book_uid));
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty WHERE kind = 'book_identity'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(pending >= 1, "the new alias is published");
    }
}
