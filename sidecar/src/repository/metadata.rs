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

/// A book's source-file truth, parsed for the merge rules. Kept per file row
/// (`book_source_metadata`) because duplicate copies can carry different file
/// metadata; the effective view on the durable book follows the most recently
/// refreshed file.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SourceMetadata {
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
    pub authors: Vec<String>,
    pub subjects: Vec<String>,
}

/// The source columns on a file row, used when the structured source snapshot
/// predates the row.
#[derive(sqlx::FromRow)]
struct FileSourceRow {
    title: String,
    subtitle: Option<String>,
    author: Option<String>,
    publisher: Option<String>,
    language: Option<String>,
    isbn: Option<String>,
    description: Option<String>,
    publication_date: Option<String>,
    series_index: Option<f64>,
    cover_path: Option<String>,
    series: Option<String>,
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

/// Write the source-file truth for one file row (the importer calls this on
/// every import/reconcile). This is the per-file layer; `book_records` holds
/// the effective view that the metadata service recomputes from it.
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
    book_uid: &str,
) -> Result<Option<OverrideRow>, AppError> {
    let row = sqlx::query_as::<_, OverrideRow>(
        r#"
        SELECT title, subtitle, publisher, language, isbn, description,
               publication_date, series, series_index, cover_path,
               authors_customized, subjects_customized
        FROM book_metadata_overrides WHERE book_uid = ?1
        "#,
    )
    .bind(book_uid)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Replace the whole override row for a durable book (the edit service
/// computes all cells; minimal-override rules keep untouched fields at NULL).
pub async fn upsert_overrides(
    pool: &SqlitePool,
    book_uid: &str,
    overrides: &OverrideRow,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO book_metadata_overrides (
            book_uid, title, subtitle, publisher, language, isbn, description,
            publication_date, series, series_index, cover_path,
            authors_customized, subjects_customized
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(book_uid) DO UPDATE SET
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
    .bind(book_uid)
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

/// Drop every override for a durable book (reset to source); the list gates
/// reopen so the next re-import follows the file again.
pub async fn clear_overrides(pool: &SqlitePool, book_uid: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM book_metadata_overrides WHERE book_uid = ?1")
        .bind(book_uid)
        .execute(pool)
        .await?;
    Ok(())
}

/// Replace a book's normalized author list. Names are shared vocabulary:
/// existing `authors` rows are reused, new names insert. `position` keeps
/// the display order stable.
pub async fn replace_book_authors(
    pool: &SqlitePool,
    book_uid: &str,
    names: &[String],
) -> Result<(), AppError> {
    for name in names {
        sqlx::query("INSERT OR IGNORE INTO authors (name) VALUES (?1)")
            .bind(name)
            .execute(pool)
            .await?;
    }
    sqlx::query("DELETE FROM book_authors WHERE book_uid = ?1")
        .bind(book_uid)
        .execute(pool)
        .await?;
    for (position, name) in names.iter().enumerate() {
        sqlx::query(
            r#"
            INSERT INTO book_authors (book_uid, author_id, position)
            VALUES (?1, (SELECT id FROM authors WHERE name = ?2), ?3)
            "#,
        )
        .bind(book_uid)
        .bind(name)
        .bind(position as i64)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn list_book_authors(pool: &SqlitePool, book_uid: &str) -> Result<Vec<String>, AppError> {
    let names: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT a.name FROM book_authors ba
        JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_uid = ?1
        ORDER BY ba.position, a.name
        "#,
    )
    .bind(book_uid)
    .fetch_all(pool)
    .await?;
    Ok(names)
}

/// Replace a book's normalized subject list (same shared-vocabulary rules).
pub async fn replace_book_subjects(
    pool: &SqlitePool,
    book_uid: &str,
    names: &[String],
) -> Result<(), AppError> {
    for name in names {
        sqlx::query("INSERT OR IGNORE INTO subjects (name) VALUES (?1)")
            .bind(name)
            .execute(pool)
            .await?;
    }
    sqlx::query("DELETE FROM book_subjects WHERE book_uid = ?1")
        .bind(book_uid)
        .execute(pool)
        .await?;
    for name in names {
        sqlx::query(
            "INSERT INTO book_subjects (book_uid, subject_id) VALUES (?1, (SELECT id FROM subjects WHERE name = ?2))",
        )
        .bind(book_uid)
        .bind(name)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn list_book_subjects(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<Vec<String>, AppError> {
    let names: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT s.name FROM book_subjects bs
        JOIN subjects s ON s.id = bs.subject_id
        WHERE bs.book_uid = ?1
        ORDER BY s.name
        "#,
    )
    .bind(book_uid)
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
/// back into the effective `book_records` columns every reader path consumes.
/// `author` is the display projection of the normalized author list, which
/// keeps FTS and list views working.
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
    book_uid: &str,
    values: &EffectiveValues,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE book_records SET
            title = ?2, subtitle = ?3, author = ?4, publisher = ?5, language = ?6,
            isbn = ?7, description = ?8, publication_date = ?9, series_id = ?10,
            series_index = ?11, cover_path = ?12,
            series = (SELECT name FROM series WHERE id = ?10)
        WHERE uid = ?1
        "#,
    )
    .bind(book_uid)
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

/// The durable uid behind a file row.
pub async fn book_uid_for_file(
    pool: &SqlitePool,
    file_id: i64,
) -> Result<Option<String>, AppError> {
    let uid: Option<String> = sqlx::query_scalar("SELECT book_uid FROM books WHERE id = ?1")
        .bind(file_id)
        .fetch_optional(pool)
        .await?;
    Ok(uid)
}

/// The durable uid behind the public numeric book id.
pub async fn book_uid_for_id(pool: &SqlitePool, book_id: i64) -> Result<Option<String>, AppError> {
    let uid: Option<String> = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(pool)
        .await?;
    Ok(uid)
}

/// The file row whose source metadata currently drives the effective view:
/// the most recently refreshed copy of the book.
pub async fn primary_file_id(pool: &SqlitePool, book_uid: &str) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM books WHERE book_uid = ?1 \
         ORDER BY modified_at DESC, id DESC LIMIT 1",
    )
    .bind(book_uid)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

/// Read the source snapshot for one file row, falling back to that row's own
/// source columns when the structured snapshot predates the row.
pub async fn load_source(pool: &SqlitePool, file_id: i64) -> Result<SourceMetadata, AppError> {
    if let Some(row) = get_source_metadata(pool, file_id).await? {
        return Ok(SourceMetadata {
            title: row.title,
            subtitle: row.subtitle,
            publisher: row.publisher,
            language: row.language,
            isbn: row.isbn,
            description: row.description,
            publication_date: row.publication_date,
            series: row.series,
            series_index: row.series_index,
            cover_path: row.cover_path,
            authors: parse_json_list(row.authors.as_deref()),
            subjects: parse_json_list(row.subjects.as_deref()),
        });
    }
    let row = sqlx::query_as::<_, FileSourceRow>(
        "SELECT b.title, b.subtitle, b.author, b.publisher, b.language, b.isbn, \
                b.description, b.publication_date, b.series_index, b.cover_path, \
                (SELECT name FROM series WHERE id = b.series_id) AS series \
         FROM books b WHERE b.id = ?1",
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(SourceMetadata::default());
    };
    let authors: Vec<String> = row
        .author
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .into_iter()
        .collect();
    Ok(SourceMetadata {
        title: row.title,
        subtitle: row.subtitle,
        publisher: row.publisher,
        language: row.language,
        isbn: row.isbn,
        description: row.description,
        publication_date: row.publication_date,
        series: row.series,
        series_index: row.series_index,
        cover_path: row.cover_path,
        authors,
        subjects: Vec::new(),
    })
}

/// Record a fresh parse as the source truth for one file row, then recompute
/// the durable book's effective view. Overrides survive, so a re-import only
/// refreshes the source layer.
pub async fn record_imported_source(
    pool: &SqlitePool,
    file_id: i64,
    source: &NewBook,
) -> Result<(), AppError> {
    upsert_source_metadata(pool, file_id, source).await?;
    if let Some(uid) = book_uid_for_file(pool, file_id).await? {
        recompute_effective(pool, &uid, file_id).await?;
    }
    Ok(())
}

/// Recompute a durable book's effective metadata from one file's source
/// snapshot plus the book's overrides. The merge rules live here so imports,
/// edits, resets, covers, and sync projection all use exactly one copy.
pub async fn recompute_effective(
    pool: &SqlitePool,
    book_uid: &str,
    source_file_id: i64,
) -> Result<(), AppError> {
    let source = load_source(pool, source_file_id).await?;
    let overrides = get_overrides(pool, book_uid).await?.unwrap_or_default();

    let authors = if overrides.authors_customized {
        list_book_authors(pool, book_uid).await?
    } else {
        replace_book_authors(pool, book_uid, &source.authors).await?;
        source.authors.clone()
    };
    if !overrides.subjects_customized {
        replace_book_subjects(pool, book_uid, &source.subjects).await?;
    }
    let title = clean_required(
        scalar_value(&overrides.title, Some(&source.title))
            .as_deref()
            .unwrap_or_default(),
        "title",
    )?;
    let (series, series_index) = effective_series(&overrides, &source);
    let series_id = match series.as_deref() {
        Some(name) => Some(ensure_series(pool, name).await?),
        None => None,
    };

    apply_effective(
        pool,
        book_uid,
        &EffectiveValues {
            title,
            subtitle: scalar_value(&overrides.subtitle, source.subtitle.as_deref()),
            author: display_authors(&authors),
            publisher: scalar_value(&overrides.publisher, source.publisher.as_deref()),
            language: scalar_value(&overrides.language, source.language.as_deref()),
            isbn: scalar_value(&overrides.isbn, source.isbn.as_deref()),
            description: scalar_value(&overrides.description, source.description.as_deref()),
            publication_date: scalar_value(
                &overrides.publication_date,
                source.publication_date.as_deref(),
            ),
            series_id,
            series_index,
            cover_path: overrides
                .cover_path
                .clone()
                .or_else(|| source.cover_path.clone()),
        },
    )
    .await
}

/// Merge one scalar: `None` inherits the source, `Some("")` clears,
/// `Some(value)` overrides.
pub(crate) fn scalar_value(
    override_value: &Option<String>,
    source_value: Option<&str>,
) -> Option<String> {
    match override_value {
        None => source_value.filter(|v| !v.is_empty()).map(str::to_owned),
        Some(value) if value.is_empty() => None,
        Some(value) => Some(value.clone()),
    }
}

/// The effective series name/index (one unit): an overridden unit owns both,
/// an empty name is an explicit clear, and `None` inherits both.
pub(crate) fn effective_series(
    overrides: &OverrideRow,
    source: &SourceMetadata,
) -> (Option<String>, Option<f64>) {
    match overrides.series.as_deref() {
        None => (source.series.clone(), source.series_index),
        Some("") => (None, None),
        Some(name) => (Some(name.to_owned()), overrides.series_index),
    }
}

/// The `author` display projection of the normalized list, which keeps FTS
/// and every existing read path working unchanged.
pub(crate) fn display_authors(authors: &[String]) -> Option<String> {
    if authors.is_empty() {
        None
    } else {
        Some(authors.join(", "))
    }
}

pub(crate) fn parse_json_list(json: Option<&str>) -> Vec<String> {
    json.and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
}

pub(crate) fn clean_required(value: &str, field: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(format!("{field} must not be empty")));
    }
    Ok(trimmed.to_string())
}

/// Delete authors/subjects/series rows no book references anymore (after
/// list replacement, resets, or book removal). Series rows are referenced
/// through `book_records.series_id`; author/subject rows through their join
/// tables.
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
        "DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM book_records WHERE series_id = series.id)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Serialize an optional list as a JSON array text (`null` stays null).
fn json_list(names: Option<&[String]>) -> Option<String> {
    names.map(|list| serde_json::to_string(list).expect("list JSON serializes"))
}
