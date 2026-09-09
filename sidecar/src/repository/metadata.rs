use sqlx::SqlitePool;

use crate::domain::NewBook;
use crate::error::AppError;

/// The importer's view of the source file, stored verbatim in
/// `book_source_metadata`. `authors`/`subjects` are JSON arrays (empty list =
/// the file names none; NULL = pre-normalization backfill, treated as empty).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct SourceMetadataRow {
    pub title: String,
    pub subtitle: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub publication_date: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub cover_path: Option<String>,
    pub authors: Option<String>,
    pub subjects: Option<String>,
}

/// The user's curation layer, stored verbatim in `book_metadata_overrides`.
/// `None` means "inherit the source value"; an empty string means "explicitly
/// cleared". List customization is a boolean gate on re-import replacement.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Default)]
pub struct OverrideRow {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub publication_date: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub cover_path: Option<String>,
    pub authors_customized: bool,
    pub subjects_customized: bool,
}

/// Write the source-file truth for a book (the importer calls this on every
/// import/reconcile). The snapshot never touches `books` — that is the
/// effective view the metadata service recomputes.
pub async fn upsert_source_metadata(
    pool: &SqlitePool,
    book_id: i64,
    source: &NewBook,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO book_source_metadata (
            book_id, title, subtitle, publisher, language, isbn, description,
            publication_date, series, series_index, cover_path, authors, subjects
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(book_id) DO UPDATE SET
            title = excluded.title,
            subtitle = excluded.subtitle,
            publisher = excluded.publisher,
            language = excluded.language,
            isbn = excluded.isbn,
            description = excluded.description,
            publication_date = excluded.publication_date,
            series = excluded.series,
            series_index = excluded.series_index,
            cover_path = excluded.cover_path,
            authors = excluded.authors,
            subjects = excluded.subjects
        "#,
    )
    .bind(book_id)
    .bind(&source.title)
    .bind(&source.subtitle)
    .bind(&source.publisher)
    .bind(&source.language)
    .bind(&source.isbn)
    .bind(&source.description)
    .bind(&source.publication_date)
    .bind(&source.series)
    .bind(source.series_index)
    .bind(&source.cover_path)
    .bind(json_list(Some(&source.author_list())))
    .bind(json_list(Some(&source.subjects)))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_source_metadata(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<SourceMetadataRow>, AppError> {
    let row = sqlx::query_as::<_, SourceMetadataRow>(
        r#"
        SELECT title, subtitle, publisher, language, isbn, description,
               publication_date, series, series_index, cover_path, authors, subjects
        FROM book_source_metadata WHERE book_id = ?1
        "#,
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_overrides(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<OverrideRow>, AppError> {
    let row = sqlx::query_as::<_, OverrideRow>(
        r#"
        SELECT title, subtitle, publisher, language, isbn, description,
               publication_date, series, series_index, cover_path,
               authors_customized, subjects_customized
        FROM book_metadata_overrides WHERE book_id = ?1
        "#,
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Replace the whole override row for a book (the edit service computes all
/// cells; minimal-override rules keep untouched fields at NULL).
pub async fn upsert_overrides(
    pool: &SqlitePool,
    book_id: i64,
    overrides: &OverrideRow,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO book_metadata_overrides (
            book_id, title, subtitle, publisher, language, isbn, description,
            publication_date, series, series_index, cover_path,
            authors_customized, subjects_customized
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(book_id) DO UPDATE SET
            title = excluded.title,
            subtitle = excluded.subtitle,
            publisher = excluded.publisher,
            language = excluded.language,
            isbn = excluded.isbn,
            description = excluded.description,
            publication_date = excluded.publication_date,
            series = excluded.series,
            series_index = excluded.series_index,
            cover_path = excluded.cover_path,
            authors_customized = excluded.authors_customized,
            subjects_customized = excluded.subjects_customized
        "#,
    )
    .bind(book_id)
    .bind(&overrides.title)
    .bind(&overrides.subtitle)
    .bind(&overrides.publisher)
    .bind(&overrides.language)
    .bind(&overrides.isbn)
    .bind(&overrides.description)
    .bind(&overrides.publication_date)
    .bind(&overrides.series)
    .bind(overrides.series_index)
    .bind(&overrides.cover_path)
    .bind(overrides.authors_customized)
    .bind(overrides.subjects_customized)
    .execute(pool)
    .await?;
    Ok(())
}

/// Drop every override for a book (reset to source); the list gates reopen
/// so the next re-import follows the file again.
pub async fn clear_overrides(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM book_metadata_overrides WHERE book_id = ?1")
        .bind(book_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Replace a book's normalized author list. Names are shared vocabulary:
/// existing `authors` rows are reused, new names insert. `position` keeps
/// the display order stable.
pub async fn replace_book_authors(
    pool: &SqlitePool,
    book_id: i64,
    names: &[String],
) -> Result<(), AppError> {
    for name in names {
        sqlx::query("INSERT OR IGNORE INTO authors (name) VALUES (?1)")
            .bind(name)
            .execute(pool)
            .await?;
    }
    sqlx::query("DELETE FROM book_authors WHERE book_id = ?1")
        .bind(book_id)
        .execute(pool)
        .await?;
    for (position, name) in names.iter().enumerate() {
        sqlx::query(
            r#"
            INSERT INTO book_authors (book_id, author_id, position)
            VALUES (?1, (SELECT id FROM authors WHERE name = ?2), ?3)
            "#,
        )
        .bind(book_id)
        .bind(name)
        .bind(position as i64)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn list_book_authors(pool: &SqlitePool, book_id: i64) -> Result<Vec<String>, AppError> {
    let names: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT a.name FROM book_authors ba
        JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = ?1
        ORDER BY ba.position, a.name
        "#,
    )
    .bind(book_id)
    .fetch_all(pool)
    .await?;
    Ok(names)
}

/// Replace a book's normalized subject list (same shared-vocabulary rules).
pub async fn replace_book_subjects(
    pool: &SqlitePool,
    book_id: i64,
    names: &[String],
) -> Result<(), AppError> {
    for name in names {
        sqlx::query("INSERT OR IGNORE INTO subjects (name) VALUES (?1)")
            .bind(name)
            .execute(pool)
            .await?;
    }
    sqlx::query("DELETE FROM book_subjects WHERE book_id = ?1")
        .bind(book_id)
        .execute(pool)
        .await?;
    for name in names {
        sqlx::query(
            "INSERT INTO book_subjects (book_id, subject_id) VALUES (?1, (SELECT id FROM subjects WHERE name = ?2))",
        )
        .bind(book_id)
        .bind(name)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn list_book_subjects(pool: &SqlitePool, book_id: i64) -> Result<Vec<String>, AppError> {
    let names: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT s.name FROM book_subjects bs
        JOIN subjects s ON s.id = bs.subject_id
        WHERE bs.book_id = ?1
        ORDER BY s.name
        "#,
    )
    .bind(book_id)
    .fetch_all(pool)
    .await?;
    Ok(names)
}

/// Resolve a series name to its normalized row id, creating the row when the
/// name is new. `None` clears membership.
pub async fn ensure_series(pool: &SqlitePool, name: &str) -> Result<i64, AppError> {
    sqlx::query("INSERT OR IGNORE INTO series (name) VALUES (?1)")
        .bind(name)
        .execute(pool)
        .await?;
    let id: i64 = sqlx::query_scalar("SELECT id FROM series WHERE name = ?1")
        .bind(name)
        .fetch_one(pool)
        .await?;
    Ok(id)
}

/// Values the metadata service has merged (override over source), written
/// back into the effective `books` columns every reader path consumes.
/// `author` is the display projection of the normalized author list, which
/// keeps the FTS index and list views working without schema changes.
pub struct EffectiveValues {
    pub title: String,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub publication_date: Option<String>,
    pub series_id: Option<i64>,
    pub series_index: Option<f64>,
    pub cover_path: Option<String>,
}

pub async fn apply_effective(
    pool: &SqlitePool,
    book_id: i64,
    values: &EffectiveValues,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE books SET
            title = ?2, subtitle = ?3, author = ?4, publisher = ?5, language = ?6,
            isbn = ?7, description = ?8, publication_date = ?9, series_id = ?10,
            series_index = ?11, cover_path = ?12,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        "#,
    )
    .bind(book_id)
    .bind(&values.title)
    .bind(&values.subtitle)
    .bind(&values.author)
    .bind(&values.publisher)
    .bind(&values.language)
    .bind(&values.isbn)
    .bind(&values.description)
    .bind(&values.publication_date)
    .bind(values.series_id)
    .bind(values.series_index)
    .bind(&values.cover_path)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete authors/subjects/series rows no book references anymore (after
/// list replacement, resets, or book removal). Series rows are referenced
/// only through `books.series_id`; author/subject rows only through their
/// join tables.
pub async fn sweep_orphans(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query("DELETE FROM authors WHERE NOT EXISTS (SELECT 1 FROM book_authors WHERE author_id = authors.id)")
        .execute(pool)
        .await?;
    sqlx::query(
        "DELETE FROM subjects WHERE NOT EXISTS (SELECT 1 FROM book_subjects WHERE subject_id = subjects.id)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM books WHERE series_id = series.id)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Serialize an optional list as a JSON array text (`null` stays null).
fn json_list(names: Option<&[String]>) -> Option<String> {
    names.map(|list| serde_json::to_string(list).expect("list JSON serializes"))
}
