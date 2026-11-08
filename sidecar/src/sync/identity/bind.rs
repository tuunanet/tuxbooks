//! The discovery sweep: hash a book file and bind the row to an identity.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repository::books;

use super::alias::{canonical_book_uid, resolve_identity};
use super::merge::merge_book_identity;
use super::{record_issue, BookIdentity};

/// Hash the book file and bind the row, or return `None` when the file is
/// unavailable. Hashing runs on the blocking pool: a 1 GiB PDF must not stall
/// the Tokio reactor.
pub async fn ensure_book_identity(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<BookIdentity>, AppError> {
    let row: Option<(String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT path, available, file_size, file_mtime, rehash_pending
         FROM books WHERE id = ?1",
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    let Some((path, available, stored_size, stored_mtime, rehash_pending)) = row else {
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
        if rehash_pending == 0 && *size == stored_size && *mtime == stored_mtime {
            // The binding may predate the durable split (a sync fixture) or a
            // migration row; make sure the file row points at its book.
            sqlx::query(
                "UPDATE books
                 SET book_uid = ?2, hash_state = 'hashed', hash_attempts = 0, hash_retry_at = NULL
                 WHERE id = ?1",
            )
            .bind(book_id)
            .bind(uid)
            .execute(pool)
            .await?;
            ensure_book_record(pool, book_id).await?;
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
    let identity = bind_hash(pool, book_id, &hash, size, mtime).await?;
    books::clear_rehash_pending(pool, book_id).await?;
    Ok(identity)
}

pub(crate) fn hash_file(path: &Path) -> Result<(String, i64, i64), std::io::Error> {
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
    // A row that has not been bound yet may already own a durable record (the
    // migration assigned one). Reuse it instead of minting a second identity
    // for the same file.
    let current_uid: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM books WHERE id = ?1")
            .bind(book_id)
            .fetch_optional(pool)
            .await?
            .flatten();

    let existing_uid = match &existing {
        Some((uid, _)) => resolve_identity(pool, uid).await?,
        None => None,
    };
    let alias_uid = match &alias {
        Some(uid) => resolve_identity(pool, uid).await?,
        None => None,
    };
    let current_uid = match &current_uid {
        Some(uid) => resolve_identity(pool, uid).await?,
        None => None,
    };
    let uid = match (&existing_uid, &alias_uid) {
        (Some(existing), Some(alias)) => existing.min(alias).clone(),
        (Some(existing), None) => existing.clone(),
        (None, Some(alias)) => alias.clone(),
        (None, None) => match current_uid.clone() {
            Some(current) => current,
            None => {
                sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
                    .fetch_one(pool)
                    .await?
            }
        },
    };

    // A migration-assigned uuid is local until this hash publishes it. When it
    // meets an existing alias, fold the local record into the established
    // identity so both file rows and any recovered state end up on one book.
    if let Some(current) = &current_uid {
        let current = canonical_book_uid(pool, current).await?;
        if current != uid {
            merge_book_identity(pool, &current, &uid).await?;
        }
    }

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

    sqlx::query(
        "UPDATE books
         SET book_uid = ?2, hash_state = 'hashed', hash_attempts = 0, hash_retry_at = NULL
         WHERE id = ?1",
    )
    .bind(book_id)
    .bind(&uid)
    .execute(pool)
    .await?;
    ensure_book_record(pool, book_id).await?;

    record_duplicate_bindings(pool, &uid).await?;

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

/// Make sure a bound file row has its durable-record snapshot. The migration
/// and the insert trigger create it normally; this covers a row that was
/// inserted before the split or whose uuid was just assigned by a sync
/// fixture.
async fn ensure_book_record(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO book_records (
            uid, title, subtitle, author, publisher, language, isbn,
            description, publication_date, series, series_index, series_id,
            cover_path, metadata_state
        )
        SELECT b.book_uid, b.title, b.subtitle, b.author, b.publisher, b.language,
               b.isbn, b.description, b.publication_date,
               (SELECT name FROM series WHERE id = b.series_id), b.series_index,
               b.series_id, b.cover_path, 'available'
        FROM books b
        WHERE b.id = ?1 AND b.book_uid IS NOT NULL
        ON CONFLICT(uid) DO NOTHING
        "#,
    )
    .bind(book_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// A uuid can be bound to more than one local row when the library holds two
/// copies of the same content, or when a cloud client delivered two rewritten
/// versions of one book. Projection follows the lowest book id. Say so in Sync
/// issues instead of leaving the other copy silently empty.
pub(crate) async fn record_duplicate_bindings(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<(), AppError> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT b.id, b.path
         FROM sync_book_bindings s
         JOIN books b ON b.id = s.book_id
         WHERE s.book_uid = ?1
         ORDER BY b.id",
    )
    .bind(book_uid)
    .fetch_all(pool)
    .await?;
    if rows.len() < 2 {
        return Ok(());
    }
    let (canonical_id, canonical_path) = &rows[0];
    for (duplicate_id, duplicate_path) in rows.iter().skip(1) {
        record_issue(
            pool,
            &format!("duplicate-book:{book_uid}:{duplicate_id}"),
            "duplicate_book",
            &format!(
                "This library has more than one file for the same book. \
                 Annotations and progress follow \"{canonical_path}\" (book {canonical_id}). \
                 The duplicate is \"{duplicate_path}\" (book {duplicate_id}). \
                 Remove one copy if it is not wanted."
            ),
            None,
        )
        .await?;
    }
    Ok(())
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
