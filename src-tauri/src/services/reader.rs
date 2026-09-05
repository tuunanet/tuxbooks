//! Reading-session services: controlled access to stored book files for the
//! frontend reader engines.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repository::books;

/// Load the raw bytes of a stored book's source file.
///
/// Byte access is controlled through the database: callers only ever name a
/// library book id, and the on-disk path never crosses the IPC boundary.
pub async fn load_book_file(pool: &SqlitePool, book_id: i64) -> Result<Vec<u8>, AppError> {
    let book = books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let bytes = tokio::fs::read(&book.path).await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::domain::NewBook;

    async fn stored_book(pool: &SqlitePool, path: &str) -> i64 {
        let new_book = NewBook {
            path: path.to_string(),
            title: "A Minimal Manual".to_string(),
            subtitle: None,
            author: None,
            authors: Vec::new(),
            subjects: Vec::new(),
            publisher: None,
            language: None,
            isbn: None,
            description: None,
            cover_path: None,
            publication_date: None,
            series: None,
            series_index: None,
            file_size: 0,
            file_mtime: 0,
        };
        books::insert_book(pool, &new_book).await.unwrap()
    }

    #[tokio::test]
    async fn loads_the_stored_file_bytes_for_a_book_id() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("manual.pdf");
        std::fs::write(&file, b"%PDF-1.4 fake bytes").unwrap();

        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
        let id = stored_book(&pool, &file.to_string_lossy()).await;

        let bytes = load_book_file(&pool, id).await.unwrap();
        assert_eq!(bytes, b"%PDF-1.4 fake bytes");
    }

    #[tokio::test]
    async fn unknown_book_id_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();

        let err = load_book_file(&pool, 12345).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound), "got: {err:?}");
    }

    #[tokio::test]
    async fn missing_file_surfaces_as_an_io_error() {
        let tmp = tempfile::tempdir().unwrap();
        let vanished = tmp.path().join("gone.pdf");

        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
        let id = stored_book(&pool, &vanished.to_string_lossy()).await;

        let err = load_book_file(&pool, id).await.unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "got: {err:?}");
    }
}
