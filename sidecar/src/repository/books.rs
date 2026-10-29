use sqlx::SqlitePool;

use crate::domain::Book;
use crate::domain::NewBook;
use crate::domain::SearchHit;
use crate::error::AppError;
use crate::repository::library_locations::{list_locations, location_index, owning_location};

/// Effective book columns for SELECT queries. The public `id` is the durable
/// book record; `file_id` names the active file row internally (never
/// serialized). The bibliographic fields come from that file row, because
/// effective metadata still lives there until ticket .4; `series_name`
/// resolves the normalized `series` table, and the `reading_progress` join
/// exposes the coarse reading position that backs the "In Progress" /
/// "Finished" library sections (milestone 10).
const BOOK_COLUMNS: &str = "br.id, br.uid AS book_uid, bf.id AS file_id, bf.path, bf.title, \
     bf.subtitle, bf.author, bf.publisher, bf.language, bf.isbn, bf.description, \
     bf.cover_path, bf.added_at, bf.modified_at, br.last_opened_at, bf.available, \
     bf.file_size, bf.file_mtime, bf.publication_date, bf.series_id, bf.series_index, \
     s.name AS series_name, rp.progress_percent AS progress_percent, \
     rp.updated_at AS progress_updated_at";
/// Per-file-row variant of [`BOOK_COLUMNS`] for callers that need every
/// location (reconciliation, unwatch, move recovery), not the collapsed
/// library entry. `id` is still the durable book.
const FILE_ROW_COLUMNS: &str = "br.id, br.uid AS book_uid, b.id AS file_id, b.path, b.title, \
     b.subtitle, b.author, b.publisher, b.language, b.isbn, b.description, \
     b.cover_path, b.added_at, b.modified_at, br.last_opened_at, b.available, \
     b.file_size, b.file_mtime, b.publication_date, b.series_id, b.series_index, \
     s.name AS series_name, rp.progress_percent AS progress_percent, \
     rp.updated_at AS progress_updated_at";
const FILE_ROW_FROM: &str = " FROM books b \
     JOIN book_records br ON br.uid = b.book_uid \
     LEFT JOIN series s ON s.id = b.series_id \
     LEFT JOIN reading_progress rp ON rp.book_uid = br.uid";
/// The active file of a book is the available copy with the lowest row id, so
/// a duplicate copy that disappeared never hides the one that is still there.
const BOOK_FROM: &str = " FROM book_records br \
     JOIN books bf ON bf.id = ( \
         SELECT b2.id FROM books b2 WHERE b2.book_uid = br.uid \
         ORDER BY b2.available DESC, b2.id LIMIT 1 \
     ) \
     LEFT JOIN series s ON s.id = bf.series_id \
     LEFT JOIN reading_progress rp ON rp.book_uid = br.uid";

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
/// trigger creates the durable book record in the same statement.
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
    Ok(id)
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
                WHEN file_size != ?10 OR file_mtime != ?11 THEN 'pending'
                ELSE hash_state
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
/// first, then the lowest id. `None` when the book currently has no file
/// (Reading history, which this slice keeps for ticket .5).
pub async fn active_file_id(pool: &SqlitePool, durable_id: i64) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT b.id FROM books b \
         JOIN book_records br ON br.uid = b.book_uid \
         WHERE br.id = ?1 ORDER BY b.available DESC, b.id LIMIT 1",
    )
    .bind(durable_id)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

pub async fn get_book_by_path(pool: &SqlitePool, path: &str) -> Result<Option<Book>, AppError> {
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT br.id FROM books b JOIN book_records br ON br.uid = b.book_uid WHERE b.path = ?1",
    )
    .bind(path)
    .fetch_optional(pool)
    .await?;
    match id {
        Some(id) => get_book(pool, id).await,
        None => Ok(None),
    }
}

/// Library entries: one per durable book that currently has a file.
pub async fn count_books(pool: &SqlitePool) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT book_uid) FROM books")
        .fetch_one(pool)
        .await?;
    Ok(count)
}

pub async fn list_books(pool: &SqlitePool) -> Result<Vec<Book>, AppError> {
    let books = sqlx::query_as::<_, Book>(&format!(
        "SELECT {BOOK_COLUMNS}{BOOK_FROM} ORDER BY bf.title COLLATE NOCASE, br.id"
    ))
    .fetch_all(pool)
    .await?;
    Ok(books)
}

/// The fields an import needs to decide whether a file changed and which
/// cover it already owns. Deliberately excludes description and every other
/// payload column: a stat-only re-import must not read whole library rows.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BookFileSnapshot {
    pub path: String,
    pub available: bool,
    pub file_size: i64,
    pub file_mtime: i64,
    pub cover_path: Option<String>,
}

pub async fn list_file_snapshots(pool: &SqlitePool) -> Result<Vec<BookFileSnapshot>, AppError> {
    let snapshots = sqlx::query_as::<_, BookFileSnapshot>(
        "SELECT path, available, file_size, file_mtime, cover_path FROM books",
    )
    .fetch_all(pool)
    .await?;
    Ok(snapshots)
}

/// The file snapshot for one path, used by the watcher's change check.
pub async fn file_snapshot_by_path(
    pool: &SqlitePool,
    path: &str,
) -> Result<Option<BookFileSnapshot>, AppError> {
    let snapshot = sqlx::query_as::<_, BookFileSnapshot>(
        "SELECT path, available, file_size, file_mtime, cover_path FROM books WHERE path = ?1",
    )
    .bind(path)
    .fetch_optional(pool)
    .await?;
    Ok(snapshot)
}

/// Every referenced cover path — the live set for artwork-cache sweeps.
pub async fn list_cover_paths(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let paths: Vec<String> =
        sqlx::query_scalar("SELECT cover_path FROM books WHERE cover_path IS NOT NULL")
            .fetch_all(pool)
            .await?;
    Ok(paths)
}

pub async fn get_book(pool: &SqlitePool, id: i64) -> Result<Option<Book>, AppError> {
    let book = sqlx::query_as::<_, Book>(&format!(
        "SELECT {BOOK_COLUMNS}{BOOK_FROM} WHERE br.id = ?1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(book)
}

/// Read a durable book through one of its file rows (internal callers that
/// still hold a file-row id).
pub async fn get_book_by_file_id(
    pool: &SqlitePool,
    file_id: i64,
) -> Result<Option<Book>, AppError> {
    match durable_id_for_file(pool, file_id).await? {
        Some(id) => get_book(pool, id).await,
        None => Ok(None),
    }
}

/// End a book's library membership: delete every file row that points at it.
/// The durable book record, its reading progress, and its annotations stay.
pub async fn delete_book(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query(
        "DELETE FROM books WHERE book_uid = (SELECT uid FROM book_records WHERE id = ?1)",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Delete one file row (one copy inside a folder being unwatched).
pub async fn delete_file_row(pool: &SqlitePool, file_id: i64) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM books WHERE id = ?1")
        .bind(file_id)
        .execute(pool)
        .await?;
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

pub async fn mark_opened(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE books SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = (SELECT b.id FROM books b JOIN book_records br ON br.uid = b.book_uid \
                     WHERE br.id = ?1 ORDER BY b.available DESC, b.id LIMIT 1)",
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
    sqlx::query("UPDATE books SET rehash_pending = 1, hash_state = 'pending' WHERE id = ?1")
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
        "UPDATE books SET file_size = ?2, file_mtime = ?3, hash_state = 'pending' WHERE id = ?1",
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
        // Another row already owns `new_path` (books.path is UNIQUE).
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
    // Re-read through the active-file rule so a disappeared duplicate does not
    // make the book look unavailable when another copy is still on disk.
    let mut books = Vec::with_capacity(affected.len());
    for id in affected.drain(..) {
        if let Some(book) = get_book(pool, id).await? {
            books.push(book);
        }
    }
    Ok(books)
}

/// File rows whose path is `prefix` itself or lies under `prefix/`. One row
/// per file copy: startup reconciliation and unwatch need the locations, not
/// the collapsed library entry. `file_id` names the row.
pub async fn list_books_in_prefix(pool: &SqlitePool, prefix: &str) -> Result<Vec<Book>, AppError> {
    let books = sqlx::query_as::<_, Book>(&format!(
        r#"
        SELECT {FILE_ROW_COLUMNS}{FILE_ROW_FROM}
        WHERE b.path = ?1 OR substr(b.path, 1, length(?1) + 1) = ?1 || '/'
        ORDER BY b.path
        "#
    ))
    .bind(prefix)
    .fetch_all(pool)
    .await?;
    Ok(books)
}

/// All file rows this location owns, under the one membership rule the library
/// uses. Books a deeper watched folder claims are left out, which is exactly
/// what `storage_stats` counts under this location, so a caller that showed
/// a book count and then acts on it acts on the same set.
pub async fn books_owned_by(pool: &SqlitePool, location: &str) -> Result<Vec<Book>, AppError> {
    let mut books = list_books_in_prefix(pool, location).await?;
    let locations = list_locations(pool).await?;
    let index = location_index(&locations);
    books.retain(|book| {
        owning_location(&book.path, &index).is_some_and(|owner| locations[owner] == location)
    });
    Ok(books)
}

/// All file rows with the given file size — move-recovery candidates for the
/// watcher (a book whose file vanished plus a new file with the same name
/// and size is almost certainly the same book that moved).
pub async fn find_books_with_size(
    pool: &SqlitePool,
    file_size: i64,
) -> Result<Vec<Book>, AppError> {
    let books = sqlx::query_as::<_, Book>(&format!(
        "SELECT {FILE_ROW_COLUMNS}{FILE_ROW_FROM} WHERE b.file_size = ?1"
    ))
    .bind(file_size)
    .fetch_all(pool)
    .await?;
    Ok(books)
}

/// FTS5 MATCH search over `books_fts`, joined back to the durable book for
/// identity. `match_query` must already be valid FTS5 MATCH syntax — the
/// search service sanitizes user input into it. Snippets come from whichever
/// indexed column matched best (column index -1 = automatic).
pub async fn search_fts(pool: &SqlitePool, match_query: &str) -> Result<Vec<SearchHit>, AppError> {
    let hits = sqlx::query_as::<_, SearchHit>(
        r#"
        SELECT br.id AS book_id, b.title, b.author,
               snippet(books_fts, -1, '<em>', '</em>', '…', 12) AS snippet
        FROM books_fts
        JOIN books b ON b.id = books_fts.rowid
        JOIN book_records br ON br.uid = b.book_uid
        WHERE books_fts MATCH ?1
        ORDER BY rank
        LIMIT 50
        "#,
    )
    .bind(match_query)
    .fetch_all(pool)
    .await?;
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(path: &str, title: &str) -> NewBook {
        NewBook {
            path: path.into(),
            title: title.into(),
            subtitle: Some("A Subtitle".into()),
            author: Some("Author".into()),
            authors: vec!["Author".into()],
            subjects: Vec::new(),
            publisher: None,
            language: Some("en".into()),
            isbn: None,
            description: None,
            cover_path: None,
            publication_date: None,
            series: None,
            series_index: None,
            file_size: 100,
            file_mtime: 1_700_000_000,
        }
    }

    #[tokio::test]
    async fn insert_and_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
            .await
            .unwrap();
        let book = get_book(&pool, id).await.unwrap().unwrap();
        assert_eq!(book.title, "Alpha");
        assert_eq!(book.subtitle.as_deref(), Some("A Subtitle"));
        assert_eq!(book.path, "/a.epub");
        assert_eq!(book.id, id);
        assert!(book.file_id.is_some());
    }

    #[tokio::test]
    async fn duplicate_path_violates_unique_constraint() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        insert_book(&pool, &sample("/a.epub", "Alpha"))
            .await
            .unwrap();
        let err = insert_book(&pool, &sample("/a.epub", "Again"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn upsert_inserts_then_updates() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let (id1, inserted) = upsert_book(&pool, &sample("/a.epub", "Alpha"))
            .await
            .unwrap();
        assert!(inserted);

        let (id2, inserted) = upsert_book(&pool, &sample("/a.epub", "Alpha v2"))
            .await
            .unwrap();
        assert!(!inserted);
        assert_eq!(id1, id2);

        let book = get_book(&pool, id1).await.unwrap().unwrap();
        assert_eq!(book.title, "Alpha v2");
        assert_eq!(count_books(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn empty_title_is_rejected_by_check_constraint() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let err = insert_book(&pool, &sample("/a.epub", "   "))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn removing_the_last_file_keeps_reading_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
            .await
            .unwrap();
        crate::repository::reading_progress::upsert_progress(
            &pool,
            id,
            &crate::domain::ProgressUpdate {
                chapter_href: Some("c1.xhtml".into()),
                cfi: None,
                character_offset: Some(120),
                page_number: None,
                scroll_offset: None,
                progress_percent: Some(12.5),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(delete_book(&pool, id).await.unwrap());

        let progress = crate::repository::reading_progress::get_progress(&pool, id)
            .await
            .unwrap();
        let progress = progress.expect("reading progress must survive the last file");
        assert_eq!(progress.progress_percent, Some(12.5));
        assert!(get_book(&pool, id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_books_orders_by_title_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        upsert_book(&pool, &sample("/b.epub", "beta"))
            .await
            .unwrap();
        upsert_book(&pool, &sample("/a.epub", "Alpha"))
            .await
            .unwrap();
        upsert_book(&pool, &sample("/c.epub", "Charlie"))
            .await
            .unwrap();

        let titles: Vec<String> = list_books(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.title)
            .collect();
        assert_eq!(titles, vec!["Alpha", "beta", "Charlie"]);
    }

    /// The retired flag must not appear in any read's serialization.
    fn assert_no_loose_flag(book: &Book) {
        let json = serde_json::to_value(book).unwrap();
        assert!(
            json.get("loose").is_none(),
            "the loose flag must not appear in a book payload: {json}"
        );
        assert!(
            json.get("fileId").is_none(),
            "the internal file row must never cross the IPC boundary: {json}"
        );
    }

    #[tokio::test]
    async fn book_reads_carry_no_loose_field() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        crate::repository::library_locations::add_location(&pool, "/lib")
            .await
            .unwrap();
        let (inside_id, _) = upsert_book(&pool, &sample("/lib/inside.epub", "Inside"))
            .await
            .unwrap();
        // A sibling prefix and a book outside every watched location
        // serialize the same way as a watched one: no flag at all.
        let (sibling_id, _) = upsert_book(&pool, &sample("/libx/sibling.epub", "Sibling"))
            .await
            .unwrap();
        let (outside_id, _) = upsert_book(&pool, &sample("/outside.epub", "Outside"))
            .await
            .unwrap();

        // The listing, `get_book` (library-changed and import-progress
        // payloads), and `get_book_by_path` (rename payloads) all serialize
        // the same struct, so all three reads must offer no loose field.
        let books = list_books(&pool).await.unwrap();
        for book in &books {
            assert_no_loose_flag(book);
        }
        let titles: Vec<&str> = books.iter().map(|book| book.title.as_str()).collect();
        assert_eq!(titles, vec!["Inside", "Outside", "Sibling"]);

        for id in [inside_id, sibling_id, outside_id] {
            assert_no_loose_flag(&get_book(&pool, id).await.unwrap().unwrap());
        }
        assert_no_loose_flag(
            &get_book_by_path(&pool, "/outside.epub")
                .await
                .unwrap()
                .unwrap(),
        );
    }

    #[tokio::test]
    async fn inserted_books_start_available_with_file_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
            .await
            .unwrap();
        let book = get_book(&pool, id).await.unwrap().unwrap();
        assert!(book.available);
        assert_eq!(book.file_size, 100);
        assert_eq!(book.file_mtime, 1_700_000_000);
    }

    #[tokio::test]
    async fn set_availability_prefix_hits_exact_and_children_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        upsert_book(&pool, &sample("/lib/a.epub", "A"))
            .await
            .unwrap();
        upsert_book(&pool, &sample("/lib/b.epub", "B"))
            .await
            .unwrap();
        upsert_book(&pool, &sample("/libx/c.epub", "C"))
            .await
            .unwrap();
        upsert_book(&pool, &sample("/lib_sub/under_score.epub", "D"))
            .await
            .unwrap();

        // A trailing-separator-free prefix must not match the sibling
        // directory `/libx`, and literal `_` must never act as a wildcard.
        let affected = set_availability_prefix(&pool, "/lib", false).await.unwrap();
        let mut paths: Vec<String> = affected.iter().map(|b| b.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, vec!["/lib/a.epub", "/lib/b.epub"]);
        // Rows are reported with their fresh (post-change) availability.
        assert!(affected.iter().all(|b| !b.available));

        // Sibling directories and underscore-containing paths stay available.
        assert_eq!(
            stayed_available_sorted(&pool).await,
            vec!["/lib_sub/under_score.epub", "/libx/c.epub"]
        );

        // Only changed rows are reported; a second pass is a no-op.
        let again = set_availability_prefix(&pool, "/lib", false).await.unwrap();
        assert!(again.is_empty());

        // And the reverse transition restores availability.
        let restored = set_availability_prefix(&pool, "/lib", true).await.unwrap();
        assert_eq!(restored.len(), 2);
        assert!(restored.iter().all(|b| b.available));
    }

    async fn stayed_available_sorted(pool: &SqlitePool) -> Vec<String> {
        let mut paths: Vec<String> = list_books(pool)
            .await
            .unwrap()
            .into_iter()
            .filter(|b| b.available)
            .map(|b| b.path)
            .collect();
        paths.sort();
        paths
    }

    #[tokio::test]
    async fn relink_updates_path_and_keeps_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let id = insert_book(&pool, &sample("/old/a.epub", "Alpha"))
            .await
            .unwrap();
        let file_id = active_file_id(&pool, id).await.unwrap().unwrap();
        crate::repository::reading_progress::upsert_progress(
            &pool,
            id,
            &crate::domain::ProgressUpdate {
                chapter_href: Some("c1.xhtml".into()),
                cfi: None,
                character_offset: Some(42),
                page_number: None,
                scroll_offset: None,
                progress_percent: Some(40.0),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let outcome = relink_book(&pool, file_id, "/new/renamed.epub", 200, 1_800_000_000)
            .await
            .unwrap();
        assert_eq!(outcome, RelinkOutcome::Relinked);

        let book = get_book(&pool, id).await.unwrap().unwrap();
        assert_eq!(book.path, "/new/renamed.epub");
        assert!(book.available);
        assert_eq!(book.file_size, 200);
        assert_eq!(book.file_mtime, 1_800_000_000);

        let progress = crate::repository::reading_progress::get_progress(&pool, id)
            .await
            .unwrap();
        assert!(progress.is_some(), "relink must preserve reading progress");
    }

    #[tokio::test]
    async fn relink_conflicts_with_existing_path() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
            .await
            .unwrap();
        let file_id = active_file_id(&pool, id).await.unwrap().unwrap();
        insert_book(&pool, &sample("/b.epub", "Beta"))
            .await
            .unwrap();

        let outcome = relink_book(&pool, file_id, "/b.epub", 200, 1_800_000_000)
            .await
            .unwrap();
        assert_eq!(outcome, RelinkOutcome::PathConflict);
        // The conflicting row is untouched and the relinked row keeps its path.
        let book = get_book(&pool, id).await.unwrap().unwrap();
        assert_eq!(book.path, "/a.epub");
        assert_eq!(count_books(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn list_books_in_prefix_matches_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        upsert_book(&pool, &sample("/lib/a.epub", "A"))
            .await
            .unwrap();
        upsert_book(&pool, &sample("/lib/sub/b.epub", "B"))
            .await
            .unwrap();
        upsert_book(&pool, &sample("/elsewhere/c.epub", "C"))
            .await
            .unwrap();

        let mut paths: Vec<String> = list_books_in_prefix(&pool, "/lib")
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.path)
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["/lib/a.epub", "/lib/sub/b.epub"]);
    }
}
