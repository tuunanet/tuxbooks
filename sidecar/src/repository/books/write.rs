//! File-row writes: import upserts, snapshots, and relink.

use sqlx::SqlitePool;

use crate::domain::NewBook;
use crate::error::AppError;

/// A file row just persisted, with both its internal id and the durable book
/// it belongs to.
#[derive(Debug, Clone, Copy)]
pub struct UpsertedBook {
    /// Public numeric id (`book_records.id`).
    pub id: i64,
    /// Internal file row id (`books.id`).
    pub file_id: i64,
    pub inserted: bool,
}

/// Insert a new file row and return its durable book id. Errors if `path`
/// already exists — use [`upsert_book`] for scan imports.
pub async fn insert_book(pool: &SqlitePool, book: &NewBook) -> Result<i64, AppError> {
    let file_id = insert_file_row(pool, book).await?;
    durable_id_for_file(pool, file_id)
        .await?
        .ok_or_else(|| AppError::InvalidInput("new book has no durable record".into()))
}

/// Insert a new file row and return its internal row id. The 0017 insert
/// trigger creates the durable book record in the same statement; the
/// per-file source snapshot and the effective metadata are recorded right
/// after it.
async fn insert_file_row(pool: &SqlitePool, book: &NewBook) -> Result<i64, AppError> {
    let id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO books (book_uid, path, title, subtitle, author, publisher, language, isbn, description, cover_path, file_size, file_mtime)
        VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        RETURNING id
        "#,
    )
    .bind(&book.path)
    .bind(&book.title)
    .bind(&book.subtitle)
    .bind(&book.author)
    .bind(&book.publisher)
    .bind(&book.language)
    .bind(&book.isbn)
    .bind(&book.description)
    .bind(&book.cover_path)
    .bind(book.file_size)
    .bind(book.file_mtime)
    .fetch_one(pool)
    .await?;
    crate::repository::metadata::record_imported_source(pool, id, book).await?;
    Ok(id)
}

/// Insert a file row already bound to a known durable book. Used by relink:
/// the book comes from Reading history, so the new location must not mint a
/// second durable record. The 0019 insert trigger sees the existing
/// `book_uid` and leaves the durable snapshot alone (`ON CONFLICT DO
/// NOTHING`); the caller records the fresh source metadata afterwards.
pub async fn insert_file_for_book(
    pool: &SqlitePool,
    durable_id: i64,
    book: &NewBook,
) -> Result<i64, AppError> {
    let uid: Option<String> = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(durable_id)
        .fetch_optional(pool)
        .await?;
    let uid = uid.ok_or(AppError::NotFound)?;
    let file_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO books (
            book_uid, path, title, subtitle, author, publisher, language, isbn,
            description, cover_path, file_size, file_mtime
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        RETURNING id
        "#,
    )
    .bind(&uid)
    .bind(&book.path)
    .bind(&book.title)
    .bind(&book.subtitle)
    .bind(&book.author)
    .bind(&book.publisher)
    .bind(&book.language)
    .bind(&book.isbn)
    .bind(&book.description)
    .bind(&book.cover_path)
    .bind(book.file_size)
    .bind(book.file_mtime)
    .fetch_one(pool)
    .await?;
    crate::repository::metadata::record_imported_source(pool, file_id, book).await?;
    Ok(file_id)
}

/// Update an existing file row (matched by path). Returns false if no row
/// matched. The file was just seen on disk, so the row also becomes available
/// again.
pub async fn update_book_by_path(pool: &SqlitePool, book: &NewBook) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE books
        SET title = ?2, subtitle = ?3, author = ?4, publisher = ?5, language = ?6,
            isbn = ?7, description = ?8, cover_path = ?9,
            hash_state = CASE
                WHEN available = 0 OR file_size != ?10 OR file_mtime != ?11 THEN 'pending'
                ELSE hash_state
            END,
            hash_attempts = CASE
                WHEN available = 0 OR file_size != ?10 OR file_mtime != ?11 THEN 0
                ELSE hash_attempts
            END,
            hash_retry_at = CASE
                WHEN available = 0 OR file_size != ?10 OR file_mtime != ?11 THEN NULL
                ELSE hash_retry_at
            END,
            file_size = ?10, file_mtime = ?11, available = 1,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE path = ?1
        "#,
    )
    .bind(&book.path)
    .bind(&book.title)
    .bind(&book.subtitle)
    .bind(&book.author)
    .bind(&book.publisher)
    .bind(&book.language)
    .bind(&book.isbn)
    .bind(&book.description)
    .bind(&book.cover_path)
    .bind(book.file_size)
    .bind(book.file_mtime)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Insert the file row or update it if `path` is already present. Returns the
/// durable book id and whether it was newly inserted.
pub async fn upsert_book(pool: &SqlitePool, book: &NewBook) -> Result<(i64, bool), AppError> {
    let upserted = upsert_file(pool, book).await?;
    Ok((upserted.id, upserted.inserted))
}

/// The importer's form of [`upsert_book`]: it also needs the file row id to
/// record source metadata against the file that was just read.
pub async fn upsert_file(pool: &SqlitePool, book: &NewBook) -> Result<UpsertedBook, AppError> {
    if let Some(file_id) = find_file_id_by_path(pool, &book.path).await? {
        update_book_by_path(pool, book).await?;
        crate::repository::metadata::record_imported_source(pool, file_id, book).await?;
        let id = durable_id_for_file(pool, file_id)
            .await?
            .ok_or_else(|| AppError::InvalidInput("book row has no durable record".into()))?;
        Ok(UpsertedBook {
            id,
            file_id,
            inserted: false,
        })
    } else {
        let file_id = insert_file_row(pool, book).await?;
        let id = durable_id_for_file(pool, file_id)
            .await?
            .ok_or_else(|| AppError::InvalidInput("new book has no durable record".into()))?;
        Ok(UpsertedBook {
            id,
            file_id,
            inserted: true,
        })
    }
}

pub async fn find_file_id_by_path(pool: &SqlitePool, path: &str) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM books WHERE path = ?1")
        .bind(path)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

/// The durable book id behind a file row.
pub async fn durable_id_for_file(pool: &SqlitePool, file_id: i64) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT br.id FROM books b JOIN book_records br ON br.uid = b.book_uid WHERE b.id = ?1",
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

/// The file row the reader should use for a durable book: an available copy
/// first, then the lowest id, then path. `None` when the book currently has no
/// file (Reading history, ADR 0014 D6).
pub async fn active_file_id(pool: &SqlitePool, durable_id: i64) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT b.id FROM books b \
         JOIN book_records br ON br.uid = b.book_uid \
         WHERE br.id = ?1 ORDER BY b.available DESC, b.id, b.path LIMIT 1",
    )
    .bind(durable_id)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

pub async fn mark_opened(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE book_records SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Outcome of [`relink_book`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelinkOutcome {
    /// The row now points at the new path and is available again.
    Relinked,
    /// Another row already owns `new_path` — the caller decides what happens
    /// with both rows (the relink target stays untouched).
    PathConflict,
}

/// Replace one file row's content (used for explicit reconnection): new path,
/// fresh parsed metadata, file snapshot, and availability. The durable book,
/// and therefore reading progress and annotations, is unchanged.
pub async fn update_book_by_id(
    pool: &SqlitePool,
    file_id: i64,
    book: &NewBook,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE books
        SET path = ?2, title = ?3, subtitle = ?4, author = ?5, publisher = ?6,
            language = ?7, isbn = ?8, description = ?9, cover_path = ?10,
            hash_state = 'pending',
            hash_attempts = 0,
            hash_retry_at = NULL,
            file_size = ?11, file_mtime = ?12, available = 1,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        "#,
    )
    .bind(file_id)
    .bind(&book.path)
    .bind(&book.title)
    .bind(&book.subtitle)
    .bind(&book.author)
    .bind(&book.publisher)
    .bind(&book.language)
    .bind(&book.isbn)
    .bind(&book.description)
    .bind(&book.cover_path)
    .bind(book.file_size)
    .bind(book.file_mtime)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Mark that the stored file snapshot may not describe the bytes on disk.
/// The sync identity sweep treats this as a forced rehash, so a crash between
/// a rewrite and the snapshot update cannot strand the book identity.
pub async fn mark_rehash_pending(pool: &SqlitePool, file_id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE books SET rehash_pending = 1, hash_state = 'pending',
         hash_attempts = 0, hash_retry_at = NULL WHERE id = ?1",
    )
    .bind(file_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_rehash_pending(pool: &SqlitePool, file_id: i64) -> Result<(), AppError> {
    sqlx::query("UPDATE books SET rehash_pending = 0 WHERE id = ?1")
        .bind(file_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Refresh only the size/mtime snapshot after a rewrite that already updated
/// the source metadata. The sync identity sweep watches this snapshot to know
/// when to rehash the file.
pub async fn update_file_snapshot(
    pool: &SqlitePool,
    file_id: i64,
    file_size: i64,
    file_mtime: i64,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE books SET file_size = ?2, file_mtime = ?3, hash_state = 'pending',
         hash_attempts = 0, hash_retry_at = NULL WHERE id = ?1",
    )
    .bind(file_id)
    .bind(file_size)
    .bind(file_mtime)
    .execute(pool)
    .await?;
    Ok(())
}

/// Point an existing file row at a new filesystem path (rename/move within a
/// watched location, or explicit reconnection), updating its file snapshot.
/// The durable book is unchanged, so reading progress and annotations survive.
pub async fn relink_book(
    pool: &SqlitePool,
    file_id: i64,
    new_path: &str,
    file_size: i64,
    file_mtime: i64,
) -> Result<RelinkOutcome, AppError> {
    let result = match sqlx::query(
        r#"
        UPDATE books
        SET path = ?2, file_size = ?3, file_mtime = ?4, available = 1,
            hash_state = 'pending',
            hash_attempts = 0,
            hash_retry_at = NULL,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        "#,
    )
    .bind(file_id)
    .bind(new_path)
    .bind(file_size)
    .bind(file_mtime)
    .execute(pool)
    .await
    {
        Err(err)
            if err
                .as_database_error()
                .is_some_and(|e| e.is_unique_violation()) =>
        {
            return Ok(RelinkOutcome::PathConflict);
        }
        other => other?,
    };
    if result.rows_affected() == 0 {
        return Ok(RelinkOutcome::PathConflict);
    }
    Ok(RelinkOutcome::Relinked)
}
