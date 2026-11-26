//! Durable-record identity: attach, detach, and the Last known path seam.

use sqlx::SqlitePool;

use super::get_book;
use crate::domain::Book;
use crate::error::AppError;

/// A Reading-history book selected for relink: its durable key and the cover
/// snapshot used as the fallback when the picked file cannot extract one.
#[derive(Debug, Clone)]
pub struct RelinkTarget {
    pub book_uid: String,
    pub cover_path: Option<String>,
}

/// Make sure a durable record exists for a shared identity that has no local
/// file yet. A waiting book on a machine that never saw the file has mirror
/// state but no `book_records` row; attaching its exact bytes needs that row
/// first, so it is created under the same uid with no metadata.
///
/// Returns the record id and whether this call inserted it. The caller rolls a
/// new record back when the attach fails, so a rejected file never leaves an
/// untitled Reading-history row.
pub async fn ensure_durable_record(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<(i64, bool), AppError> {
    let inserted = sqlx::query(
        "INSERT INTO book_records (uid, metadata_state) VALUES (?1, 'waiting_for_file')
         ON CONFLICT(uid) DO NOTHING",
    )
    .bind(book_uid)
    .execute(pool)
    .await?
    .rows_affected()
        > 0;
    let id = durable_id_for_uid(pool, book_uid)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok((id, inserted))
}

/// The durable record id a uid holds right now. The sync projection can
/// move the id an earlier outcome reported; the uid is the stable key.
pub async fn durable_id_for_uid(pool: &SqlitePool, book_uid: &str) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
        .bind(book_uid)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

/// Remove a record a failed attach created, but only while nothing points at
/// it. A file row or binding means the attach got far enough to keep the book.
pub async fn discard_empty_durable_record(
    pool: &SqlitePool,
    durable_id: i64,
    book_uid: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM book_records
         WHERE id = ?1 AND uid = ?2
           AND NOT EXISTS (SELECT 1 FROM books WHERE book_uid = ?2)
           AND NOT EXISTS (SELECT 1 FROM sync_book_bindings WHERE book_uid = ?2)",
    )
    .bind(durable_id)
    .bind(book_uid)
    .execute(pool)
    .await?;
    Ok(())
}

/// The durable record a relink will attach a file to, or `None` when the id
/// names no book.
pub async fn relink_target(
    pool: &SqlitePool,
    durable_id: i64,
) -> Result<Option<RelinkTarget>, AppError> {
    let target = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT uid, cover_path FROM book_records WHERE id = ?1",
    )
    .bind(durable_id)
    .fetch_optional(pool)
    .await?
    .map(|(book_uid, cover_path)| RelinkTarget {
        book_uid,
        cover_path,
    });
    Ok(target)
}

/// Whether a durable book still has any file row. Relink only applies to a
/// Reading-history book, which by definition has none.
pub async fn has_file_rows(pool: &SqlitePool, book_uid: &str) -> Result<bool, AppError> {
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books WHERE book_uid = ?1")
        .bind(book_uid)
        .fetch_one(pool)
        .await?;
    Ok(rows > 0)
}

/// A relinked book has a file again, so its snapshot is no longer waiting.
pub async fn mark_metadata_available(pool: &SqlitePool, durable_id: i64) -> Result<(), AppError> {
    sqlx::query("UPDATE book_records SET metadata_state = 'available' WHERE id = ?1")
        .bind(durable_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// End a book's library membership: delete every file row that points at it.
/// The durable book record, its reading progress, and its annotations stay.
/// The record keeps the Last known path of the copy the reader opened
/// (tuxbooks-t9p.1) until a file attaches again.
///
/// IMMEDIATE, not deferred: the path read must sit in the same write
/// snapshot as the delete, and a deferred read-then-write upgrade fails
/// outright against a concurrent writer (watcher, sync pass).
pub async fn delete_book(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let removed = delete_book_tx(&mut tx, id).await?;
    tx.commit().await?;
    Ok(removed)
}

/// Transaction body of [`delete_book`], shared with the Locate duplicate
/// detach, which runs inside its own transaction. The reader's copy is read
/// before the delete: a multi-row delete visits rows in rowid order, so only
/// this ordering stores the copy the reader opened rather than the row the
/// delete happened to visit last.
pub(crate) async fn delete_book_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: i64,
) -> Result<bool, AppError> {
    let uid: Option<String> = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(uid) = uid else {
        return Ok(false);
    };
    let active_path = active_path_for_uid(tx, &uid).await?;
    let result = sqlx::query("DELETE FROM books WHERE book_uid = ?1")
        .bind(&uid)
        .execute(&mut **tx)
        .await?;
    remember_last_known_path(tx, &uid, active_path).await?;
    Ok(result.rows_affected() > 0)
}

/// The path of the copy the reader opens for a durable uid: an available copy
/// first, then the lowest row id, then path (the active-file rule).
pub(crate) async fn active_path_for_uid(
    conn: &mut sqlx::SqliteConnection,
    uid: &str,
) -> Result<Option<String>, AppError> {
    let path: Option<String> = sqlx::query_scalar(
        "SELECT path FROM books WHERE book_uid = ?1 \
         ORDER BY available DESC, id, path LIMIT 1",
    )
    .bind(uid)
    .fetch_optional(conn)
    .await?;
    Ok(path)
}

/// Store the reader's copy as the record's Last known path once no file row
/// remains bound to it. The NOT EXISTS guard keeps the hint cleared while any
/// row survived, so the path is remembered only while the book is detached.
pub(crate) async fn remember_last_known_path(
    conn: &mut sqlx::SqliteConnection,
    uid: &str,
    active_path: Option<String>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE book_records SET last_known_path = ?2 \
         WHERE uid = ?1 AND NOT EXISTS (SELECT 1 FROM books WHERE book_uid = ?1)",
    )
    .bind(uid)
    .bind(active_path)
    .execute(conn)
    .await?;
    Ok(())
}

/// Delete one file row (one copy inside a folder being unwatched). When it
/// was the book's last row, the durable record keeps the Last known path of
/// the copy the reader opened, which may be another row deleted in the same
/// unwatch (tuxbooks-t9p.1). IMMEDIATE transaction, like [`delete_book`].
pub async fn delete_file_row(pool: &SqlitePool, file_id: i64) -> Result<bool, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let uid: Option<String> = sqlx::query_scalar("SELECT book_uid FROM books WHERE id = ?1")
        .bind(file_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(uid) = uid else {
        return Ok(false);
    };
    let active_path = active_path_for_uid(&mut tx, &uid).await?;
    let result = sqlx::query("DELETE FROM books WHERE id = ?1")
        .bind(file_id)
        .execute(&mut *tx)
        .await?;
    remember_last_known_path(&mut tx, &uid, active_path).await?;
    tx.commit().await?;
    Ok(result.rows_affected() > 0)
}

/// Every file row of a durable book, oldest first.
pub async fn file_ids_for_book(pool: &SqlitePool, id: i64) -> Result<Vec<i64>, AppError> {
    let ids = sqlx::query_scalar(
        "SELECT b.id FROM books b \
         JOIN book_records br ON br.uid = b.book_uid \
         WHERE br.id = ?1 ORDER BY b.id",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

/// Mark books unavailable/available for an exact path or every file row under
/// a directory prefix (`path` itself or `path/...`). Returns the durable books
/// whose active file changed, with their fresh availability so callers can
/// notify the UI.
pub async fn set_availability_prefix(
    pool: &SqlitePool,
    path_prefix: &str,
    available: bool,
) -> Result<Vec<Book>, AppError> {
    let mut affected: Vec<i64> = sqlx::query_scalar(
        r#"
        SELECT br.id
        FROM books b
        JOIN book_records br ON br.uid = b.book_uid
        WHERE b.available != ?2
          AND (b.path = ?1 OR substr(b.path, 1, length(?1) + 1) = ?1 || '/')
        GROUP BY br.id
        "#,
    )
    .bind(path_prefix)
    .bind(available)
    .fetch_all(pool)
    .await?;

    if !affected.is_empty() {
        sqlx::query(
            r#"
            UPDATE books SET available = ?2
            WHERE available != ?2
              AND (path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/')
            "#,
        )
        .bind(path_prefix)
        .bind(available)
        .execute(pool)
        .await?;
    }
    // Re-read through the active-file rule: a gone duplicate must not hide a live copy.
    let mut books = Vec::with_capacity(affected.len());
    for id in affected.drain(..) {
        if let Some(book) = get_book(pool, id).await? {
            books.push(book);
        }
    }
    Ok(books)
}
