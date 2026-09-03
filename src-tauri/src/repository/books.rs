use sqlx::SqlitePool;

use crate::domain::Book;
use crate::domain::NewBook;
use crate::error::AppError;

const BOOK_COLUMNS: &str = "id, path, title, subtitle, author, publisher, language, isbn, \
     description, cover_path, added_at, modified_at, last_opened_at, available, file_size, \
     file_mtime";

/// Insert a new book. Errors if `path` already exists — use [`upsert_book`] for
/// scan imports.
pub async fn insert_book(pool: &SqlitePool, book: &NewBook) -> Result<i64, AppError> {
    let id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO books (path, title, subtitle, author, publisher, language, isbn, description, cover_path, file_size, file_mtime)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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

/// Update an existing book (matched by path). Returns false if no row matched.
/// The file was just seen on disk, so the row also becomes available again.
pub async fn update_book_by_path(pool: &SqlitePool, book: &NewBook) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE books
        SET title = ?2, subtitle = ?3, author = ?4, publisher = ?5, language = ?6,
            isbn = ?7, description = ?8, cover_path = ?9,
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

/// Insert the book or update it if `path` is already present.
/// Returns the row id and whether it was newly inserted.
pub async fn upsert_book(pool: &SqlitePool, book: &NewBook) -> Result<(i64, bool), AppError> {
    if let Some(id) = find_id_by_path(pool, &book.path).await? {
        update_book_by_path(pool, book).await?;
        Ok((id, false))
    } else {
        let id = insert_book(pool, book).await?;
        Ok((id, true))
    }
}

pub async fn find_id_by_path(pool: &SqlitePool, path: &str) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM books WHERE path = ?1")
        .bind(path)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

pub async fn get_book_by_path(pool: &SqlitePool, path: &str) -> Result<Option<Book>, AppError> {
    let book =
        sqlx::query_as::<_, Book>(&format!("SELECT {BOOK_COLUMNS} FROM books WHERE path = ?1"))
            .bind(path)
            .fetch_optional(pool)
            .await?;
    Ok(book)
}

pub async fn count_books(pool: &SqlitePool) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
        .fetch_one(pool)
        .await?;
    Ok(count)
}

pub async fn list_books(pool: &SqlitePool) -> Result<Vec<Book>, AppError> {
    let books = sqlx::query_as::<_, Book>(&format!(
        "SELECT {BOOK_COLUMNS} FROM books ORDER BY title COLLATE NOCASE, id"
    ))
    .fetch_all(pool)
    .await?;
    Ok(books)
}

pub async fn get_book(pool: &SqlitePool, id: i64) -> Result<Option<Book>, AppError> {
    let book =
        sqlx::query_as::<_, Book>(&format!("SELECT {BOOK_COLUMNS} FROM books WHERE id = ?1"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(book)
}

pub async fn delete_book(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM books WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn mark_opened(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE books SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
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

/// Replace a book's row content by id (used for explicit reconnection): new
/// path, fresh parsed metadata, file snapshot, and availability. The row id
/// is unchanged, so reading progress and collections survive.
pub async fn update_book_by_id(
    pool: &SqlitePool,
    id: i64,
    book: &NewBook,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE books
        SET path = ?2, title = ?3, subtitle = ?4, author = ?5, publisher = ?6,
            language = ?7, isbn = ?8, description = ?9, cover_path = ?10,
            file_size = ?11, file_mtime = ?12, available = 1,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        "#,
    )
    .bind(id)
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

/// Point an existing book row at a new filesystem path (rename/move within a
/// watched location, or explicit reconnection), updating its file snapshot.
/// The row id is unchanged, so reading progress and collections survive.
pub async fn relink_book(
    pool: &SqlitePool,
    id: i64,
    new_path: &str,
    file_size: i64,
    file_mtime: i64,
) -> Result<RelinkOutcome, AppError> {
    let result = match sqlx::query(
        r#"
        UPDATE books
        SET path = ?2, file_size = ?3, file_mtime = ?4, available = 1,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        "#,
    )
    .bind(id)
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

/// Mark books unavailable/available for an exact path or every book under a
/// directory prefix (`path` itself or `path/...`). Returns the affected rows
/// with their fresh availability so callers can notify the UI. Only rows whose
/// availability actually changes are returned.
pub async fn set_availability_prefix(
    pool: &SqlitePool,
    path_prefix: &str,
    available: bool,
) -> Result<Vec<Book>, AppError> {
    let mut affected: Vec<Book> = sqlx::query_as::<_, Book>(&format!(
        r#"
        SELECT {BOOK_COLUMNS} FROM books
        WHERE available != ?2
          AND (path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/')
        "#
    ))
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
    // Reflect the new state so callers can emit accurate change events.
    for book in &mut affected {
        book.available = available;
    }
    Ok(affected)
}

/// All books whose path is `prefix` itself or lies under `prefix/`, used by
/// startup reconciliation to diff one watched location against the database.
pub async fn list_books_in_prefix(pool: &SqlitePool, prefix: &str) -> Result<Vec<Book>, AppError> {
    let books = sqlx::query_as::<_, Book>(&format!(
        r#"
        SELECT {BOOK_COLUMNS} FROM books
        WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/'
        ORDER BY path
        "#
    ))
    .bind(prefix)
    .fetch_all(pool)
    .await?;
    Ok(books)
}

/// All books with the given file size — move-recovery candidates for the
/// watcher (a book whose file vanished plus a new file with the same name
/// and size is almost certainly the same book that moved).
pub async fn find_books_with_size(
    pool: &SqlitePool,
    file_size: i64,
) -> Result<Vec<Book>, AppError> {
    let books = sqlx::query_as::<_, Book>(&format!(
        "SELECT {BOOK_COLUMNS} FROM books WHERE file_size = ?1"
    ))
    .bind(file_size)
    .fetch_all(pool)
    .await?;
    Ok(books)
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
            publisher: None,
            language: Some("en".into()),
            isbn: None,
            description: None,
            cover_path: None,
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
    async fn delete_cascades_to_reading_progress() {
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
            },
        )
        .await
        .unwrap();

        assert!(delete_book(&pool, id).await.unwrap());

        let progress = crate::repository::reading_progress::get_progress(&pool, id)
            .await
            .unwrap();
        assert!(
            progress.is_none(),
            "reading_progress row must be cascaded away"
        );
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
            },
        )
        .await
        .unwrap();

        let outcome = relink_book(&pool, id, "/new/renamed.epub", 200, 1_800_000_000)
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
        insert_book(&pool, &sample("/b.epub", "Beta"))
            .await
            .unwrap();

        let outcome = relink_book(&pool, id, "/b.epub", 200, 1_800_000_000)
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
