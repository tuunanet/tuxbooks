use sqlx::SqlitePool;

use crate::domain::Book;
use crate::domain::NewBook;
use crate::error::AppError;

const BOOK_COLUMNS: &str = "id, path, title, subtitle, author, publisher, language, isbn, \
     description, cover_path, added_at, modified_at, last_opened_at";

/// Insert a new book. Errors if `path` already exists — use [`upsert_book`] for
/// scan imports.
pub async fn insert_book(pool: &SqlitePool, book: &NewBook) -> Result<i64, AppError> {
    let id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO books (path, title, subtitle, author, publisher, language, isbn, description, cover_path)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
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
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// Update an existing book (matched by path). Returns false if no row matched.
pub async fn update_book_by_path(pool: &SqlitePool, book: &NewBook) -> Result<bool, AppError> {
    let result = sqlx::query(
        r#"
        UPDATE books
        SET title = ?2, subtitle = ?3, author = ?4, publisher = ?5, language = ?6,
            isbn = ?7, description = ?8, cover_path = ?9,
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

async fn find_id_by_path(pool: &SqlitePool, path: &str) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM books WHERE path = ?1")
        .bind(path)
        .fetch_optional(pool)
        .await?;
    Ok(id)
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
}
