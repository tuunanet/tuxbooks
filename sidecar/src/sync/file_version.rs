//! The book `file_version` pointer (ADR 0018 D1): shared state keyed by book
//! uid, holding the content hash and byte size of the file the minting device
//! saw. It merges as one value, entity-level LWW like reading progress.
//!
//! The only minter is the re-import path (`handle_modified` → `import_file`)
//! on an upsert that UPDATED an existing book, and only when the freshly
//! computed hash differs from the winning pointer — the publish-only-on-
//! hash-change guard that also keeps adoption-driven re-imports (D3) silent.
//! A first import never mints (the file stays local, ADR 0013 D2), and a
//! locally deleted file never propagates. The pointer names bytes that travel
//! separately through `blobs/books/` (D2), staged by the capture pass before
//! the operation is published.

use serde_json::json;
use sqlx::SqlitePool;

use crate::error::AppError;

use super::identity::canonical_book_uid;
use super::merge;
use super::model::{is_hex_hash, EntityKind};

/// The winning version for a book, as the mirror holds it. The minting
/// re-import's HLC rides with the entity clock (`sync_state_entities`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WinningVersion {
    pub content_hash: String,
    pub size: i64,
}

/// Read the book's current winning `file_version` from the mirror. `None`
/// when no version has been published yet.
pub async fn winning(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<Option<WinningVersion>, AppError> {
    let (state, _) = merge::load_state(pool, EntityKind::FileVersion, book_uid).await?;
    let hash = state.get("content_hash").and_then(|v| v.as_str());
    let size = state.get("size").and_then(|v| v.as_i64());
    Ok(match (hash, size) {
        (Some(hash), Some(size)) if is_hex_hash(hash) => Some(WinningVersion {
            content_hash: hash.to_string(),
            size,
        }),
        _ => None,
    })
}

/// The mint (ADR 0018 D1). Called by `import_file` after an upsert that
/// updated an existing book row, once `ensure_book_identity` has hashed the
/// new bytes. Reads the fresh binding, applies the publish-only-on-hash-change
/// guard against the winning pointer, and records a `file_version` dirty row
/// whose write-time clock (migration 0030) is the minting re-import's HLC.
/// The capture pass turns the row into the staged blob and the operation.
pub async fn mint_after_reimport(pool: &SqlitePool, file_id: i64) -> Result<(), AppError> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT book_uid, content_hash, hashed_size
         FROM sync_book_bindings WHERE book_id = ?1",
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;
    // A file whose hash failed has nothing to publish.
    let Some((book_uid, content_hash, size)) = row else {
        return Ok(());
    };
    let uid = canonical_book_uid(pool, &book_uid).await?;
    // The loop break: an identical hash is never republished, so the
    // re-import an adoption triggers cannot mint (ADR 0018 D1/D3).
    if winning(pool, &uid)
        .await?
        .is_some_and(|winning| winning.content_hash == content_hash)
    {
        return Ok(());
    }
    let payload = json!({ "content_hash": content_hash, "size": size });
    sqlx::query(
        r#"
        INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
        VALUES ('file_version', ?1, 'upsert', NULL, ?2)
        ON CONFLICT(kind, entity_key) DO UPDATE SET
            op = 'upsert',
            old_json = NULL,
            new_json = excluded.new_json,
            changed_at = excluded.changed_at
        "#,
    )
    .bind(&uid)
    .bind(payload.to_string())
    .execute(pool)
    .await?;
    Ok(())
}

/// The available file whose bytes carry `hash`, for staging. Returns `None`
/// when no binding of this book still names those bytes — the local copy
/// moved on or vanished, and a local disappearance is not a shared event.
pub async fn file_path_for_hash(
    pool: &SqlitePool,
    book_uid: &str,
    content_hash: &str,
) -> Result<Option<String>, AppError> {
    let path: Option<String> = sqlx::query_scalar(
        "SELECT b.path FROM sync_book_bindings s
         JOIN books b ON b.id = s.book_id
         WHERE s.book_uid = ?1 AND s.content_hash = ?2 AND b.available = 1
         ORDER BY b.id LIMIT 1",
    )
    .bind(book_uid)
    .bind(content_hash)
    .fetch_optional(pool)
    .await?;
    Ok(path)
}

/// One available file copy whose bytes are not the book's winning version:
/// the candidate set for adoption (ADR 0018 D3) and the source of the
/// library's "newer version available" state. A book can have several file
/// rows; each copy settles on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsettledCopy {
    pub book_uid: String,
    pub book_id: i64,
    pub path: String,
    /// The hash this copy's binding last proved, from the identity sweep.
    /// The file's actual bytes can differ — adoption re-hashes before it
    /// touches anything.
    pub binding_hash: String,
}

/// Every available copy behind its book's winning pointer. Excludes books
/// without a pointer (nothing to adopt), settled copies, unavailable rows
/// (a vanished file is not adoption's business), and tombstoned pointers.
pub async fn unsettled_copies(pool: &SqlitePool) -> Result<Vec<UnsettledCopy>, AppError> {
    let rows: Vec<UnsettledCopy> = sqlx::query_as(
        r#"
        SELECT s.book_uid, s.book_id, b.path, s.content_hash
        FROM sync_book_bindings s
        JOIN books b ON b.id = s.book_id AND b.available = 1
        WHERE EXISTS (
            SELECT 1 FROM sync_state_fields f
            JOIN sync_state_entities e ON e.kind = f.kind AND e.entity_uid = f.entity_uid
            WHERE f.kind = 'file_version' AND f.field = 'content_hash'
              AND e.deleted = 0 AND e.entity_uid = s.book_uid
              AND json_extract(f.value_json, '$') != s.content_hash
        )
        ORDER BY s.book_id
        "#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(book_uid, book_id, path, binding_hash)| UnsettledCopy {
        book_uid,
        book_id,
        path,
        binding_hash,
    })
    .collect();
    Ok(rows)
}
