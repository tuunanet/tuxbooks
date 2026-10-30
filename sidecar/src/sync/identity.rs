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
use crate::repository::books;

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
            sqlx::query("UPDATE books SET book_uid = ?2, hash_state = 'hashed' WHERE id = ?1")
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

    sqlx::query("UPDATE books SET book_uid = ?2, hash_state = 'hashed' WHERE id = ?1")
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

/// The durable uid a content hash is already known by, if any. Relink uses
/// this to refuse attaching a file whose bytes belong to another book.
pub(crate) async fn alias_book_uid(
    pool: &SqlitePool,
    content_hash: &str,
) -> Result<Option<String>, AppError> {
    let uid: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(content_hash)
            .fetch_optional(pool)
            .await?;
    Ok(uid)
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

/// Whether `uid` (after identity merges) has an open shared Forget. `None`
/// means the identity is live; `Some(replacement)` means it was forgotten,
/// with the fresh identity the current file was rebound to, when there is one.
pub(crate) async fn forgotten_replacement(
    pool: &SqlitePool,
    uid: &str,
) -> Result<Option<Option<String>>, AppError> {
    let canonical = canonical_book_uid(pool, uid).await?;
    let replacement: Option<Option<String>> = sqlx::query_scalar(
        "SELECT replacement_book_uid FROM sync_book_trash
         WHERE book_uid = ?1 AND restored_at IS NULL",
    )
    .bind(&canonical)
    .fetch_optional(pool)
    .await?;
    Ok(replacement)
}

/// Resolve a candidate identity for alias selection. A forgotten uuid is not
/// a candidate; its fresh replacement is, so both machines keep the bytes under
/// one live identity.
async fn resolve_identity(pool: &SqlitePool, uid: &str) -> Result<Option<String>, AppError> {
    let uid = canonical_book_uid(pool, uid).await?;
    Ok(match forgotten_replacement(pool, &uid).await? {
        Some(Some(replacement)) => Some(replacement),
        Some(None) => None,
        None => Some(uid),
    })
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
    // Delete wins. Folding a live or forgotten identity into a forgotten one
    // would resurrect the old uuid through sync_book_merges; leave the two
    // identities alone until an explicit restore clears the tombstone.
    if forgotten_replacement(pool, &winner).await?.is_some()
        || forgotten_replacement(pool, &loser).await?.is_some()
    {
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

    // Fold the losing durable record into the winner and point every local
    // file row at it. Progress uses the winner's value (the deterministic
    // canonical identity), annotation counts add up, and the latest opened
    // timestamp wins.
    sqlx::query(
        r#"
        INSERT INTO book_records (
            uid, created_at, title, subtitle, author, publisher, language,
            isbn, description, publication_date, series, series_index,
            cover_path, last_opened_at, progress_percent, annotation_count,
            metadata_state
        )
        SELECT
            ?2,
            COALESCE(
                (SELECT created_at FROM book_records WHERE uid = ?2),
                (SELECT created_at FROM book_records WHERE uid = ?1),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            ),
            COALESCE(
                (SELECT title FROM book_records WHERE uid = ?2),
                (SELECT title FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT subtitle FROM book_records WHERE uid = ?2),
                (SELECT subtitle FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT author FROM book_records WHERE uid = ?2),
                (SELECT author FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT publisher FROM book_records WHERE uid = ?2),
                (SELECT publisher FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT language FROM book_records WHERE uid = ?2),
                (SELECT language FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT isbn FROM book_records WHERE uid = ?2),
                (SELECT isbn FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT description FROM book_records WHERE uid = ?2),
                (SELECT description FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT publication_date FROM book_records WHERE uid = ?2),
                (SELECT publication_date FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT series FROM book_records WHERE uid = ?2),
                (SELECT series FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT series_index FROM book_records WHERE uid = ?2),
                (SELECT series_index FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT cover_path FROM book_records WHERE uid = ?2),
                (SELECT cover_path FROM book_records WHERE uid = ?1)
            ),
            (SELECT MAX(last_opened_at) FROM book_records WHERE uid IN (?1, ?2)),
            COALESCE(
                (SELECT progress_percent FROM book_records WHERE uid = ?2),
                (SELECT progress_percent FROM book_records WHERE uid = ?1)
            ),
            COALESCE((SELECT annotation_count FROM book_records WHERE uid = ?2), 0)
                + COALESCE((SELECT annotation_count FROM book_records WHERE uid = ?1), 0),
            CASE
                WHEN COALESCE(
                    (SELECT metadata_state FROM book_records WHERE uid = ?2), ''
                ) = 'available'
                OR COALESCE(
                    (SELECT metadata_state FROM book_records WHERE uid = ?1), ''
                ) = 'available'
                THEN 'available'
                ELSE 'waiting_for_file'
            END
        WHERE EXISTS (SELECT 1 FROM book_records WHERE uid IN (?1, ?2))
        ON CONFLICT(uid) DO UPDATE SET
            created_at = excluded.created_at,
            title = excluded.title,
            subtitle = excluded.subtitle,
            author = excluded.author,
            publisher = excluded.publisher,
            language = excluded.language,
            isbn = excluded.isbn,
            description = excluded.description,
            publication_date = excluded.publication_date,
            series = excluded.series,
            series_index = excluded.series_index,
            cover_path = excluded.cover_path,
            last_opened_at = excluded.last_opened_at,
            progress_percent = excluded.progress_percent,
            annotation_count = excluded.annotation_count,
            metadata_state = excluded.metadata_state
        "#,
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE books SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;

    // User state moved to the durable key in 0018. Annotations from both
    // copies are kept (union; duplicate highlights are possible). Progress
    // keeps the newest saved position; a tie falls back deterministically to
    // the losing copy's row so exactly one survives.
    sqlx::query("UPDATE annotations SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM reading_progress WHERE book_uid = ?2 AND EXISTS (
             SELECT 1 FROM reading_progress l
             WHERE l.book_uid = ?1
               AND l.updated_at >= reading_progress.updated_at
         )",
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE OR IGNORE reading_progress SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM reading_progress WHERE book_uid = ?1")
        .bind(&loser)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE book_records SET
             progress_percent = (SELECT progress_percent FROM reading_progress WHERE book_uid = ?2),
             annotation_count = (SELECT COUNT(*) FROM annotations WHERE book_uid = ?2)
         WHERE uid = ?2",
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;

    // Metadata overrides and collection membership now belong to the durable
    // book too. The newest copy's overrides win; a tie keeps the winner.
    // Memberships from both copies are unioned.
    let (winner_newest, loser_newest): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT
             (SELECT MAX(modified_at) FROM books WHERE book_uid = ?2),
             (SELECT MAX(modified_at) FROM books WHERE book_uid = ?1)",
    )
    .bind(&loser)
    .bind(&winner)
    .fetch_one(&mut *tx)
    .await?;
    let winner_has_overrides: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM book_metadata_overrides WHERE book_uid = ?1)",
    )
    .bind(&winner)
    .fetch_one(&mut *tx)
    .await?;
    let loser_has_overrides: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM book_metadata_overrides WHERE book_uid = ?1)",
    )
    .bind(&loser)
    .fetch_one(&mut *tx)
    .await?;
    let loser_is_newer = match (&loser_newest, &winner_newest) {
        (Some(loser), Some(winner)) => loser > winner,
        (Some(_), None) => true,
        _ => false,
    };
    if loser_has_overrides && (!winner_has_overrides || loser_is_newer) {
        sqlx::query("DELETE FROM book_authors WHERE book_uid = ?1")
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM book_subjects WHERE book_uid = ?1")
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM book_metadata_overrides WHERE book_uid = ?1")
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE book_metadata_overrides SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&loser)
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE book_authors SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&loser)
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE book_subjects SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&loser)
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "INSERT OR IGNORE INTO book_collections (book_uid, collection_id, added_at)
         SELECT ?2, collection_id, added_at FROM book_collections WHERE book_uid = ?1",
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM book_records WHERE uid = ?1")
        .bind(&loser)
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

    // The surviving book's effective metadata may now come from the newer
    // copy's source and overrides, so recompute it once the durable rows have
    // settled.
    if let Some(file_id) = crate::repository::metadata::primary_file_id(pool, &winner).await? {
        crate::repository::metadata::recompute_effective(pool, &winner, file_id).await?;
    }
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

    #[tokio::test]
    async fn a_pending_rehash_survives_a_missed_snapshot_update() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::write(&path, b"version one").unwrap();
        let book_id = book_with_file(&pool, &path).await;
        let first = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();

        // Simulate a crash after the rewrite but before the snapshot update:
        // the row and the binding both still describe the old file.
        books::mark_rehash_pending(&pool, book_id).await.unwrap();
        std::fs::write(&path, b"version two is longer").unwrap();
        let second = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();

        assert_eq!(first.book_uid, second.book_uid);
        assert_ne!(first.content_hash, second.content_hash);
        let (pending, hashed): (i64, String) = sqlx::query_as(
            "SELECT b.rehash_pending, s.content_hash
             FROM books b JOIN sync_book_bindings s ON s.book_id = b.id
             WHERE b.id = ?1",
        )
        .bind(book_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending, 0);
        assert_eq!(hashed, second.content_hash);
    }

    #[tokio::test]
    async fn duplicate_bindings_share_one_uuid_and_record_an_issue() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let first_path = tmp.path().join("first.epub");
        let second_path = tmp.path().join("second.epub");
        std::fs::write(&first_path, b"the same bytes").unwrap();
        std::fs::write(&second_path, b"the same bytes").unwrap();
        let first = book_with_file(&pool, &first_path).await;
        let second = book_with_file(&pool, &second_path).await;

        let first_identity = ensure_book_identity(&pool, first).await.unwrap().unwrap();
        let second_identity = ensure_book_identity(&pool, second).await.unwrap().unwrap();
        assert_eq!(first_identity.book_uid, second_identity.book_uid);

        let issues: Vec<(String, String)> =
            sqlx::query_as("SELECT kind, detail FROM sync_issues WHERE kind = 'duplicate_book'")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(issues.len(), 1, "one duplicate issue for the second copy");
        assert!(issues[0].1.contains("first.epub"));
        assert!(issues[0].1.contains("second.epub"));
    }

    async fn two_durable_books(pool: &SqlitePool, dir: &std::path::Path) -> (String, String) {
        for (name, bytes) in [
            ("one.epub", b"first bytes".as_slice()),
            ("two.epub", b"second bytes".as_slice()),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, bytes).unwrap();
            books::upsert_book(
                pool,
                &NewBook {
                    path: path.to_string_lossy().into_owned(),
                    title: name.into(),
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
                    file_size: bytes.len() as i64,
                    file_mtime: 0,
                },
            )
            .await
            .unwrap();
        }
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT uid, id FROM book_records ORDER BY id")
                .fetch_all(pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), 2);
        (rows[0].0.clone(), rows[1].0.clone())
    }

    async fn state_row(pool: &SqlitePool, kind: &str, uid: &str, book_uid: &str, wall: i64) {
        sqlx::query(
            "INSERT INTO sync_state_entities
                (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device)
             VALUES (?1, ?2, ?3, ?4, 0, 'other')",
        )
        .bind(kind)
        .bind(uid)
        .bind(book_uid)
        .bind(wall)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn state_field(
        pool: &SqlitePool,
        kind: &str,
        uid: &str,
        field: &str,
        value: &str,
        wall: i64,
    ) {
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 'other')",
        )
        .bind(kind)
        .bind(uid)
        .bind(field)
        .bind(value)
        .bind(wall)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn identity_lookup_skips_missing_unavailable_and_vanished_books() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        assert!(
            ensure_book_identity(&pool, 999).await.unwrap().is_none(),
            "a missing row has no identity"
        );

        let missing = tmp.path().join("gone.epub");
        let present = tmp.path().join("present.epub");
        std::fs::write(&present, b"present bytes").unwrap();
        let id = book_with_file(&pool, &present).await;
        sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            ensure_book_identity(&pool, id).await.unwrap().is_none(),
            "an unavailable book is skipped"
        );

        sqlx::query("UPDATE books SET available = 1, path = ?2 WHERE id = ?1")
            .bind(id)
            .bind(missing.to_string_lossy().into_owned())
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            ensure_book_identity(&pool, id).await.unwrap().is_none(),
            "a vanished file is skipped, not an error"
        );
    }

    #[tokio::test]
    async fn bind_hash_reuses_the_uuid_the_migration_already_assigned() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::write(&path, b"already identified").unwrap();
        let file_id = book_with_file(&pool, &path).await;
        let existing = "a1".repeat(16);
        sqlx::query("UPDATE books SET book_uid = ?2 WHERE id = ?1")
            .bind(file_id)
            .bind(&existing)
            .execute(&pool)
            .await
            .unwrap();

        let identity = bind_hash(&pool, file_id, &"b2".repeat(32), 18, 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(identity.book_uid, existing);
        let binding: String =
            sqlx::query_scalar("SELECT book_uid FROM sync_book_bindings WHERE book_id = ?1")
                .bind(file_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(binding, existing);
    }

    #[tokio::test]
    async fn merging_two_identities_moves_every_piece_of_state() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let (loser, winner) = two_durable_books(&pool, tmp.path()).await;

        let collection_id: i64 =
            sqlx::query_scalar("INSERT INTO collections (name) VALUES ('Shelf') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query(
            "INSERT INTO annotations (book_uid, sync_uid, kind) VALUES (?1, ?2, 'bookmark')",
        )
        .bind(&loser)
        .bind("a3".repeat(16))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO reading_progress (book_uid, progress_percent, updated_at)
             VALUES (?1, 80.0, '2026-02-01T00:00:00.000Z')",
        )
        .bind(&loser)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO reading_progress (book_uid, progress_percent, updated_at)
             VALUES (?1, 10.0, '2026-01-01T00:00:00.000Z')",
        )
        .bind(&winner)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO book_metadata_overrides (book_uid, title) VALUES (?1, 'Loser title')",
        )
        .bind(&loser)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO book_collections (book_uid, collection_id) VALUES (?1, ?2)")
            .bind(&loser)
            .bind(collection_id)
            .execute(&pool)
            .await
            .unwrap();

        // Mirror state under both identities, with the loser's clocks newer.
        state_row(&pool, "progress", &loser, &loser, 200).await;
        state_field(&pool, "progress", &loser, "progress_percent", "80.0", 200).await;
        state_row(&pool, "progress", &winner, &winner, 100).await;
        state_field(&pool, "progress", &winner, "progress_percent", "10.0", 100).await;
        state_row(&pool, "opened", &loser, &loser, 50).await;
        state_field(
            &pool,
            "opened",
            &loser,
            "last_opened_at",
            "\"2026-02-01T00:00:00.000Z\"",
            50,
        )
        .await;
        state_row(&pool, "metadata", &loser, &loser, 0).await;
        state_field(&pool, "metadata", &loser, "title", "\"Loser title\"", 60).await;
        let membership = format!("collection-uid:{loser}");
        state_row(&pool, "membership", &membership, &loser, 70).await;
        sqlx::query(
            "INSERT INTO sync_trash
                (kind, entity_uid, book_uid, prior_json, deleted_wall, deleted_count,
                 deleted_dev, deleted_at, expires_at)
             VALUES ('annotation', 'gone', ?1, '{}', 1, 0, 'other',
                     '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')",
        )
        .bind(&loser)
        .execute(&pool)
        .await
        .unwrap();

        merge_book_identity(&pool, &loser, &winner).await.unwrap();

        let old_exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
                .bind(&loser)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(old_exists, 0, "the losing durable record is folded in");
        let (percent, annotations): (Option<f64>, i64) = sqlx::query_as(
            "SELECT progress_percent, annotation_count FROM book_records WHERE uid = ?1",
        )
        .bind(&winner)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(percent, Some(80.0), "the newer locator wins");
        assert_eq!(annotations, 1);
        let annotation_owner: String =
            sqlx::query_scalar("SELECT book_uid FROM annotations LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(annotation_owner, winner);
        let progress: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM reading_progress WHERE book_uid = ?1")
                .bind(&loser)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(progress, 0, "the loser's progress row is deleted");
        let override_owner: String =
            sqlx::query_scalar("SELECT book_uid FROM book_metadata_overrides LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(override_owner, winner);
        let shelf: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2",
        )
        .bind(&winner)
        .bind(collection_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(shelf, 1, "memberships are unioned");
        let membership_owner: String = sqlx::query_scalar(
            "SELECT entity_uid FROM sync_state_entities WHERE kind = 'membership' LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(membership_owner, format!("collection-uid:{winner}"));
        let trash_owner: String = sqlx::query_scalar("SELECT book_uid FROM sync_trash LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(trash_owner, winner);
        let (state, deleted) = crate::sync::merge::load_state(
            &pool,
            crate::sync::model::EntityKind::Progress,
            &winner,
        )
        .await
        .unwrap();
        assert!(!deleted);
        assert_eq!(
            state.get("progress_percent"),
            Some(&serde_json::json!(80.0))
        );
        let loser_state: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_state_fields WHERE kind = 'progress' AND entity_uid = ?1",
        )
        .bind(&loser)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(loser_state, 0);
    }

    #[tokio::test]
    async fn merging_identities_declines_when_forgotten_or_already_equal() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let (a, b) = two_durable_books(&pool, tmp.path()).await;

        merge_book_identity(&pool, &a, &a).await.unwrap();
        let merges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_merges")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(merges, 0, "the same identity needs no merge");

        sqlx::query(
            "INSERT INTO sync_book_trash
                (book_uid, snapshot_json, deleted_wall, deleted_count, deleted_dev,
                 deleted_at, expires_at)
             VALUES (?1, NULL, 1, 0, 'other', '2026-01-01T00:00:00.000Z',
                     '2999-01-01T00:00:00.000Z')",
        )
        .bind(&b)
        .execute(&pool)
        .await
        .unwrap();
        merge_book_identity(&pool, &a, &b).await.unwrap();
        let merges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_merges")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            merges, 0,
            "a forgotten identity is not resurrected by a merge"
        );
        let still_there: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
                .bind(&a)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(still_there, 1);
    }

    #[tokio::test]
    async fn merging_collections_moves_fields_memberships_and_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let loser = "b4".repeat(16);
        let winner = "b5".repeat(16);
        let book_uid = "b6".repeat(16);
        state_row(&pool, "collection", &loser, "", 0).await;
        state_field(&pool, "collection", &loser, "name", "\"Shelf\"", 10).await;
        state_row(
            &pool,
            "membership",
            &format!("{loser}:{book_uid}"),
            &book_uid,
            0,
        )
        .await;
        state_field(
            &pool,
            "membership",
            &format!("{loser}:{book_uid}"),
            "present",
            "true",
            10,
        )
        .await;
        sqlx::query(
            "INSERT INTO sync_trash
                (kind, entity_uid, book_uid, prior_json, deleted_wall, deleted_count,
                 deleted_dev, deleted_at, expires_at)
             VALUES ('collection', ?1, NULL, '{\"name\":\"Shelf\"}', 1, 0, 'other',
                     '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')",
        )
        .bind(&loser)
        .execute(&pool)
        .await
        .unwrap();

        merge_collection_identity(&pool, &loser, &winner)
            .await
            .unwrap();

        let name: String = sqlx::query_scalar(
            "SELECT value_json FROM sync_state_fields
             WHERE kind = 'collection' AND entity_uid = ?1 AND field = 'name'",
        )
        .bind(&winner)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(name, "\"Shelf\"");
        let leftover: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_state_entities
             WHERE kind = 'collection' AND entity_uid = ?1",
        )
        .bind(&loser)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(leftover, 0);
        let membership_uid: String = sqlx::query_scalar(
            "SELECT entity_uid FROM sync_state_entities WHERE kind = 'membership' LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(membership_uid, format!("{winner}:{book_uid}"));
        let trash_owner: String =
            sqlx::query_scalar("SELECT entity_uid FROM sync_trash WHERE kind = 'collection'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(trash_owner, winner);
        assert_eq!(
            canonical_entity_uid(&pool, crate::sync::model::EntityKind::Collection, &loser)
                .await
                .unwrap(),
            winner
        );
    }

    #[tokio::test]
    async fn canonical_entity_ids_follow_a_chain_and_issues_are_refreshed_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        for (loser, winner) in [("a", "b"), ("b", "c")] {
            sqlx::query(
                "INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)",
            )
            .bind(loser)
            .bind(winner)
            .execute(&pool)
            .await
            .unwrap();
        }
        assert_eq!(
            canonical_entity_uid(&pool, crate::sync::model::EntityKind::Collection, "a")
                .await
                .unwrap(),
            "c"
        );

        record_issue(&pool, "one-key", "first_kind", "first detail", None)
            .await
            .unwrap();
        record_issue(
            &pool,
            "one-key",
            "second_kind",
            "second detail",
            Some("ops/file.json"),
        )
        .await
        .unwrap();
        let rows: Vec<(String, String, Option<String>)> =
            sqlx::query_as("SELECT kind, detail, file_name FROM sync_issues")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), 1, "one open issue per key");
        assert_eq!(rows[0].0, "second_kind");
        assert_eq!(rows[0].1, "second detail");
        assert_eq!(rows[0].2.as_deref(), Some("ops/file.json"));

        touch_last_sync(&pool).await.unwrap();
        let last: String = sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = ?1")
            .bind(crate::sync::clock::META_LAST_SYNC)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!last.is_empty());
    }
}
