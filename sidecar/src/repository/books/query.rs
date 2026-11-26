//! Library and reading-history reads, plus the shared SELECT column sets.

use std::collections::HashMap;

use sqlx::SqlitePool;

use super::durable_id_for_file;
use crate::domain::{Book, BookFile, ProviderLink, ReadingHistoryBook, SearchHit, UserState};
use crate::error::AppError;
use crate::repository::library_locations::{list_locations, location_index, owning_location};

/// Effective book columns for SELECT queries. The public `id` is the durable
/// book record; `file_id` names the active file row internally (never
/// serialized). The bibliographic fields come from the durable record, while
/// `path`, availability, and the file snapshot come from the active file.
/// `series_name` resolves the normalized `series` table, and the
/// `reading_progress` join exposes the coarse reading position that backs the
/// "In Progress" / "Finished" library sections (milestone 10).
const BOOK_COLUMNS: &str = "br.id, br.uid AS book_uid, bf.id AS file_id, bf.path, br.title, \
     br.subtitle, br.author, br.publisher, br.language, br.isbn, br.description, \
     br.cover_path, bf.added_at, bf.modified_at, br.last_opened_at, bf.available, \
     bf.file_size, bf.file_mtime, \
     CASE \
         WHEN EXISTS (SELECT 1 FROM books bh WHERE bh.book_uid = br.uid AND bh.hash_state = 'failed') THEN 'failed' \
         WHEN EXISTS (SELECT 1 FROM books bh WHERE bh.book_uid = br.uid AND bh.hash_state = 'pending') THEN 'pending' \
         ELSE 'hashed' \
     END AS hash_state, \
     br.publication_date, br.series_id, br.series_index, \
     s.name AS series_name, rp.progress_percent AS progress_percent, \
     rp.updated_at AS progress_updated_at";
/// Per-file-row variant of [`BOOK_COLUMNS`] for callers that need every
/// location (reconciliation, unwatch, move recovery), not the collapsed
/// library entry. `id` is still the durable book and the bibliographic fields
/// are still the book's effective metadata.
const FILE_ROW_COLUMNS: &str = "br.id, br.uid AS book_uid, b.id AS file_id, b.path, br.title, \
     br.subtitle, br.author, br.publisher, br.language, br.isbn, br.description, \
     br.cover_path, b.added_at, b.modified_at, br.last_opened_at, b.available, \
     b.file_size, b.file_mtime, b.hash_state, br.publication_date, br.series_id, \
     br.series_index, s.name AS series_name, rp.progress_percent AS progress_percent, \
     rp.updated_at AS progress_updated_at";
const FILE_ROW_FROM: &str = " FROM books b \
     JOIN book_records br ON br.uid = b.book_uid \
     LEFT JOIN series s ON s.id = br.series_id \
     LEFT JOIN reading_progress rp ON rp.book_uid = br.uid";
/// The active file of a book is the available copy with the lowest row id, so
/// a duplicate copy that disappeared never hides the one that is still there.
/// Path order is the final tiebreak; row ids are unique, so it only documents
/// the rule for callers that read the same ordering without an id.
const BOOK_FROM: &str = " FROM book_records br \
     JOIN books bf ON bf.id = ( \
         SELECT b2.id FROM books b2 WHERE b2.book_uid = br.uid \
         ORDER BY b2.available DESC, b2.id, b2.path LIMIT 1 \
     ) \
     LEFT JOIN series s ON s.id = br.series_id \
     LEFT JOIN reading_progress rp ON rp.book_uid = br.uid";

/// Count the six kinds of user state one durable book holds, keyed by uid
/// (ADR 0019 D2). Locate File and Restore share this one definition of
/// "has state", so both ask the same question before replacing or merging.
pub async fn user_state(pool: &SqlitePool, book_uid: &str) -> Result<UserState, AppError> {
    let annotations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let has_progress: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM reading_progress WHERE book_uid = ?1)")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let progress_percent: Option<f64> =
        sqlx::query_scalar("SELECT progress_percent FROM reading_progress WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_optional(pool)
            .await?
            .flatten();
    let collections: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let has_metadata_overrides: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM book_metadata_overrides WHERE book_uid = ?1)",
    )
    .bind(book_uid)
    .fetch_one(pool)
    .await?;
    let provider_links: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM book_provider_links WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(pool)
            .await?;
    let edition_links: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM book_edition_links WHERE book_uid_a = ?1 OR book_uid_b = ?1",
    )
    .bind(book_uid)
    .fetch_one(pool)
    .await?;
    Ok(UserState {
        annotations,
        has_progress,
        progress_percent,
        collections,
        has_metadata_overrides,
        provider_links,
        edition_links,
    })
}

/// Every file location of a durable book, in active-file order. `active`
/// marks the copy the reader, metadata edits, and reconnect resolve to, so
/// the details cannot disagree with the library about which file is current.
pub async fn list_files_for_book(
    pool: &SqlitePool,
    durable_id: i64,
) -> Result<Vec<BookFile>, AppError> {
    let mut files = sqlx::query_as::<_, BookFile>(
        "SELECT b.id, b.path, b.available, b.file_size, b.file_mtime, b.added_at \
         FROM books b \
         JOIN book_records br ON br.uid = b.book_uid \
         WHERE br.id = ?1 \
         ORDER BY b.available DESC, b.id, b.path",
    )
    .bind(durable_id)
    .fetch_all(pool)
    .await?;
    if let Some(active) = files.first_mut() {
        active.active = true;
    }
    Ok(files)
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
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(DISTINCT COALESCE(book_uid, 'row:' || id)) FROM books")
            .fetch_one(pool)
            .await?;
    Ok(count)
}

pub async fn list_books(pool: &SqlitePool) -> Result<Vec<Book>, AppError> {
    let mut books = sqlx::query_as::<_, Book>(&format!(
        "SELECT {BOOK_COLUMNS}{BOOK_FROM} ORDER BY bf.title COLLATE NOCASE, br.id"
    ))
    .fetch_all(pool)
    .await?;
    let mut links = group_provider_links(crate::repository::providers::list_all_links(pool).await?);
    for book in &mut books {
        if let Some(uid) = &book.book_uid {
            book.provider_links = links.remove(uid).unwrap_or_default();
        }
    }
    Ok(books)
}

/// Bucket links by durable book so one query decorates a whole payload.
fn group_provider_links(links: Vec<ProviderLink>) -> HashMap<String, Vec<ProviderLink>> {
    let mut grouped: HashMap<String, Vec<ProviderLink>> = HashMap::new();
    for link in links {
        grouped.entry(link.book_uid.clone()).or_default().push(link);
    }
    grouped
}

/// Reading history: durable books with no file rows (ADR 0014 D6). Progress
/// and annotation count are read from the state tables, not the migration
/// snapshot, so they stay current while the file is absent. `match_query` is
/// already-sanitized FTS5 MATCH syntax; `None` lists every history book.
pub async fn list_reading_history(
    pool: &SqlitePool,
    match_query: Option<&str>,
) -> Result<Vec<ReadingHistoryBook>, AppError> {
    let mut books = sqlx::query_as::<_, ReadingHistoryBook>(
        r#"
        SELECT br.id, br.uid AS book_uid, br.title, br.author, br.cover_path,
               rp.progress_percent,
               (SELECT COUNT(*) FROM annotations a WHERE a.book_uid = br.uid)
                   AS annotation_count,
               br.last_opened_at, br.metadata_state, br.last_known_path
        FROM book_records br
        LEFT JOIN reading_progress rp ON rp.book_uid = br.uid
        WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.book_uid = br.uid)
          AND (?1 IS NULL OR br.id IN (
              SELECT rowid FROM books_fts WHERE books_fts MATCH ?1
          ))
        ORDER BY COALESCE(br.last_opened_at, br.created_at) DESC, br.id
        "#,
    )
    .bind(match_query)
    .fetch_all(pool)
    .await?;
    let mut links = group_provider_links(crate::repository::providers::list_all_links(pool).await?);
    for book in &mut books {
        book.provider_links = links.remove(&book.book_uid).unwrap_or_default();
    }
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

/// Every referenced cover path (effective override and per-file source) — the
/// live set for artwork-cache sweeps.
pub async fn list_cover_paths(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let paths: Vec<String> = sqlx::query_scalar(
        "SELECT cover_path FROM book_records WHERE cover_path IS NOT NULL \
         UNION SELECT cover_path FROM books WHERE cover_path IS NOT NULL",
    )
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
    let Some(mut book) = book else {
        return Ok(None);
    };
    if let Some(uid) = &book.book_uid {
        book.provider_links = crate::repository::providers::list_links(pool, uid).await?;
    }
    Ok(Some(book))
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
/// identity and to its active file so Reading-history books stay out of
/// library search. `match_query` must already be valid FTS5 MATCH syntax — the
/// search service sanitizes user input into it. Snippets come from whichever
/// indexed column matched best (column index -1 = automatic).
pub async fn search_fts(pool: &SqlitePool, match_query: &str) -> Result<Vec<SearchHit>, AppError> {
    let hits = sqlx::query_as::<_, SearchHit>(
        r#"
        SELECT br.id AS book_id, br.title, br.author,
               snippet(books_fts, -1, '<em>', '</em>', '…', 12) AS snippet
        FROM books_fts
        JOIN book_records br ON br.id = books_fts.rowid
        JOIN books b ON b.id = (
            SELECT b2.id FROM books b2 WHERE b2.book_uid = br.uid
            ORDER BY b2.available DESC, b2.id, b2.path LIMIT 1
        )
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
