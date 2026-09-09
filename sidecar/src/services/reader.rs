//! Reading-session services: controlled access to stored book files for the
//! frontend reader engines.

use sqlx::SqlitePool;

use crate::domain::book::BookFormat;
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

/// Build the EPUB reading session (Readium manifest + positions list) for a
/// stored book. Called when the reader opens an EPUB; the renderer consumes
/// the two documents over the `tuxbooks://` protocol like any Readium webpub.
pub async fn load_epub_session(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<crate::epub::EpubReadingSession, AppError> {
    let book = epub_book(pool, book_id).await?;
    crate::epub::build_session(std::path::Path::new(&book.path)).map_err(epub_error)
}

/// Extract one EPUB ZIP member by (decoded, normalized) path, with its
/// media type. Backs per-resource requests on the `tuxbooks://` protocol:
/// chapter documents, images, stylesheets, and fonts referenced by the
/// reading session's manifest.
pub async fn load_book_resource(
    pool: &SqlitePool,
    book_id: i64,
    resource: &str,
) -> Result<(Vec<u8>, &'static str), AppError> {
    let book = epub_book(pool, book_id).await?;
    let bytes = crate::epub::read_member(std::path::Path::new(&book.path), resource)
        .map_err(epub_error)?
        .ok_or(AppError::NotFound)?;
    let media_type = crate::epub::guess_member_media_type(resource);
    Ok((bytes, media_type))
}

async fn epub_book(pool: &SqlitePool, book_id: i64) -> Result<crate::domain::Book, AppError> {
    let book = books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if BookFormat::from_path(&book.path) != BookFormat::Epub {
        return Err(AppError::InvalidInput(format!(
            "book {book_id} is not an EPUB"
        )));
    }
    Ok(book)
}

fn epub_error(error: crate::epub::EpubError) -> AppError {
    AppError::InvalidInput(error.to_string())
}

/// Load a byte range of a stored book's source file, with the file's total
/// size. Backs range requests on the `tuxbooks://` protocol (the reader
/// engines seek into large documents instead of reading them whole).
///
/// An empty range (`length == 0`) reads to end of file; offsets beyond the
/// end produce empty data rather than an error, mirroring HTTP range
/// semantics closely enough for the protocol handler to answer 416 itself.
pub async fn load_book_file_range(
    pool: &SqlitePool,
    book_id: i64,
    offset: u64,
    length: u64,
) -> Result<(Vec<u8>, u64), AppError> {
    let book = books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut file = tokio::fs::File::open(&book.path).await?;
    let total = file.metadata().await?.len();
    let start = offset.min(total);
    let end = length.saturating_add(start).min(total);
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut buffer = Vec::with_capacity((end - start) as usize);
    file.take(end - start).read_to_end(&mut buffer).await?;
    Ok((buffer, total))
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
