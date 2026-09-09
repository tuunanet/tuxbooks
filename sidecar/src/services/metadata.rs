use sqlx::SqlitePool;

use crate::domain::{Book, BookMetadata, MetadataFields, MetadataOverridden, NewBook};
use crate::error::AppError;
use crate::repository::{books, metadata as repo};

/// The source-file truth of a book (milestone 7): what the last import read
/// from the file, kept verbatim so curation never loses the original values
/// and so re-imports can re-merge without clobbering user overrides.
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

/// Record a fresh parse as the book's source truth and re-merge the
/// effective view. The importer calls this after every (re)import and the
/// reconnect flow after relinking a row; overrides win over the new file
/// values, so a user's curation survives a changed or replaced file.
pub async fn apply_source_metadata(
    pool: &SqlitePool,
    book_id: i64,
    source: &NewBook,
) -> Result<(), AppError> {
    repo::upsert_source_metadata(pool, book_id, source).await?;
    recompute_and_apply(pool, book_id).await
}

/// The full curation view of a book: effective metadata, source metadata,
/// and which fields carry overrides. `None` for unknown ids.
pub async fn get_book_metadata(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<BookMetadata>, AppError> {
    let Some(book) = books::get_book(pool, book_id).await? else {
        return Ok(None);
    };
    let source = load_source(pool, book_id).await?;
    let overrides = repo::get_overrides(pool, book_id)
        .await?
        .unwrap_or_default();
    let authors = repo::list_book_authors(pool, book_id).await?;
    let subjects = repo::list_book_subjects(pool, book_id).await?;

    let source_authors = source.authors.clone();
    let source_subjects = source.subjects.clone();

    let effective = MetadataFields {
        title: book.title.clone(),
        subtitle: book.subtitle.clone(),
        publisher: book.publisher.clone(),
        language: book.language.clone(),
        isbn: book.isbn.clone(),
        description: book.description.clone(),
        publication_date: book.publication_date.clone(),
        series: book.series_name.clone(),
        series_index: book.series_index,
        authors,
        subjects,
    };
    let source_fields = MetadataFields {
        title: source.title.clone(),
        subtitle: source.subtitle.clone(),
        publisher: source.publisher.clone(),
        language: source.language.clone(),
        isbn: source.isbn.clone(),
        description: source.description.clone(),
        publication_date: source.publication_date.clone(),
        series: source.series.clone(),
        series_index: source.series_index,
        authors: source_authors,
        subjects: source_subjects,
    };
    let overridden = MetadataOverridden {
        title: overrides.title.is_some(),
        subtitle: overrides.subtitle.is_some(),
        publisher: overrides.publisher.is_some(),
        language: overrides.language.is_some(),
        isbn: overrides.isbn.is_some(),
        description: overrides.description.is_some(),
        publication_date: overrides.publication_date.is_some(),
        series: overrides.series.is_some(),
        cover: overrides.cover_path.is_some(),
        authors: overrides.authors_customized,
        subjects: overrides.subjects_customized,
    };
    Ok(Some(BookMetadata {
        book_id,
        effective,
        source: source_fields,
        overridden,
        cover_path: book.cover_path,
    }))
}

/// Save the edit form (milestone 7). Every field is written through the
/// minimal-override rule: a value that equals the source clears its
/// override, a differing value stores one, an emptied field explicitly
/// clears. Saving a list identical to the source keeps the file authoritative
/// for that list; a changed list becomes user-owned. Returns the refreshed
/// curation view; the caller emits the library-change event.
pub async fn update_book_metadata(
    pool: &SqlitePool,
    book_id: i64,
    form: &MetadataFields,
) -> Result<BookMetadata, AppError> {
    let source = load_source(pool, book_id).await?;

    let title = clean_required(&form.title, "title")?;
    let subtitle = clean_optional(&form.subtitle);
    let publisher = clean_optional(&form.publisher);
    let language = clean_optional(&form.language);
    let isbn = clean_optional(&form.isbn);
    let description = clean_optional(&form.description);
    let publication_date = clean_optional(&form.publication_date);
    let series_name = clean_optional(&form.series);
    let authors = clean_list(&form.authors);
    let subjects = clean_list(&form.subjects);
    let series_index = match form.series_index {
        Some(value) if value.is_finite() => Some(value),
        Some(_) => {
            return Err(AppError::InvalidInput(
                "series_index must be a finite number".into(),
            ))
        }
        None => None,
    };

    // Minimal overrides: only fields that differ from the source are stored.
    let series_unit = series_override(
        series_name,
        series_index,
        source.series.as_deref(),
        source.series_index,
    );
    let overrides = repo::OverrideRow {
        title: text_override(Some(title.clone()), Some(&source.title)),
        subtitle: text_override(subtitle, source.subtitle.as_deref()),
        publisher: text_override(publisher, source.publisher.as_deref()),
        language: text_override(language, source.language.as_deref()),
        isbn: text_override(isbn, source.isbn.as_deref()),
        description: text_override(description, source.description.as_deref()),
        publication_date: text_override(publication_date, source.publication_date.as_deref()),
        series: series_unit.clone(),
        // The index is only meaningful inside an overridden series unit.
        series_index: if series_unit.is_some() {
            series_index
        } else {
            None
        },
        cover_path: repo::get_overrides(pool, book_id)
            .await?
            .unwrap_or_default()
            .cover_path,
        authors_customized: authors != source.authors,
        subjects_customized: subjects != source.subjects,
    };

    if overrides.authors_customized {
        repo::replace_book_authors(pool, book_id, &authors).await?;
    }
    if overrides.subjects_customized {
        repo::replace_book_subjects(pool, book_id, &subjects).await?;
    }
    repo::upsert_overrides(pool, book_id, &overrides).await?;
    recompute_and_apply(pool, book_id).await?;
    repo::sweep_orphans(pool).await?;

    get_book_metadata(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// Drop every override: the book returns to exactly its source-file metadata
/// (including the normalized lists and the extracted cover). The source file
/// is never touched.
pub async fn reset_book_metadata(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<BookMetadata, AppError> {
    repo::clear_overrides(pool, book_id).await?;
    recompute_and_apply(pool, book_id).await?;
    repo::sweep_orphans(pool).await?;

    get_book_metadata(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// Replace the cover with a user-picked image file (curation, milestone 7).
/// The bytes are copied into the artwork cache under a content-derived name;
/// the source file is never modified. The override survives re-imports.
pub async fn set_book_cover(
    pool: &SqlitePool,
    book_id: i64,
    image_path: &str,
    covers_dir: &std::path::Path,
) -> Result<Book, AppError> {
    if books::get_book(pool, book_id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    let data = std::fs::read(image_path)?;
    let media_type = detect_image_media_type(&data).ok_or_else(|| {
        AppError::InvalidInput("that file is not a PNG, JPEG, GIF, or WebP image".into())
    })?;
    let stored = crate::services::book_importer::write_cover_bytes(media_type, &data, covers_dir)?
        .ok_or_else(|| AppError::InvalidInput("cover image was empty".into()))?;

    let mut overrides = repo::get_overrides(pool, book_id)
        .await?
        .unwrap_or_default();
    overrides.cover_path = Some(stored);
    repo::upsert_overrides(pool, book_id, &overrides).await?;
    recompute_and_apply(pool, book_id).await?;

    books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// Remove a cover override; the extracted (source) cover returns.
pub async fn clear_book_cover_override(pool: &SqlitePool, book_id: i64) -> Result<Book, AppError> {
    let mut overrides = repo::get_overrides(pool, book_id)
        .await?
        .unwrap_or_default();
    overrides.cover_path = None;
    repo::upsert_overrides(pool, book_id, &overrides).await?;
    recompute_and_apply(pool, book_id).await?;

    books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// Recompute the effective view from (source, overrides) and write it into
/// the `books` columns. One function for imports, edits, resets, and cover
/// changes, so the merge rules exist exactly once.
async fn recompute_and_apply(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    let source = load_source(pool, book_id).await?;
    let overrides = repo::get_overrides(pool, book_id)
        .await?
        .unwrap_or_default();

    // Normalized lists: user-owned once customized, otherwise the file's.
    let authors = if overrides.authors_customized {
        repo::list_book_authors(pool, book_id).await?
    } else {
        let list = source.authors.clone();
        repo::replace_book_authors(pool, book_id, &list).await?;
        list
    };
    if !overrides.subjects_customized {
        repo::replace_book_subjects(pool, book_id, &source.subjects).await?;
    }

    // Scalar fields: override (empty string = explicitly cleared) else source.
    let title = clean_required(
        scalar_value(&overrides.title, Some(&source.title))
            .as_deref()
            .unwrap_or_default(),
        "title",
    )?;
    // The series name and index travel as one unit: an overridden unit
    // (`Some(name)`) owns both values, an empty name is an explicit clear,
    // and `None` inherits both from the source.
    let (series, series_index) = match overrides.series.as_deref() {
        None => (source.series.clone(), source.series_index),
        Some("") => (None, None),
        Some(name) => (Some(name.to_owned()), overrides.series_index),
    };
    let series_id = match series.as_deref() {
        Some(name) => Some(repo::ensure_series(pool, name).await?),
        None => None,
    };

    repo::apply_effective(
        pool,
        book_id,
        &repo::EffectiveValues {
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
            cover_path: overrides.cover_path.or(source.cover_path.clone()),
        },
    )
    .await
    .map(|_| ())
}

/// The stored source snapshot; books imported before the snapshot existed
/// fall back to their current row values (they *are* the last file truth).
async fn load_source(pool: &SqlitePool, book_id: i64) -> Result<SourceMetadata, AppError> {
    if let Some(row) = repo::get_source_metadata(pool, book_id).await? {
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
    let book = books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(SourceMetadata {
        title: book.title.clone(),
        subtitle: book.subtitle.clone(),
        publisher: book.publisher.clone(),
        language: book.language.clone(),
        isbn: book.isbn.clone(),
        description: book.description.clone(),
        publication_date: book.publication_date.clone(),
        series: book.series_name.clone(),
        series_index: book.series_index,
        cover_path: book.cover_path.clone(),
        authors: book.author.iter().cloned().collect(),
        subjects: Vec::new(),
    })
}

/// Merge one scalar: `None` inherits the source, `Some("")` clears,
/// `Some(value)` overrides.
fn scalar_value(override_value: &Option<String>, source_value: Option<&str>) -> Option<String> {
    match override_value {
        None => source_value.filter(|v| !v.is_empty()).map(str::to_owned),
        Some(value) if value.is_empty() => None,
        Some(value) => Some(value.clone()),
    }
}

/// Minimal-override rule for a form value against the source: equal → clear
/// the override (inherit), differing → store it, empty on a non-empty source
/// → explicit clear.
fn text_override(form: Option<String>, source: Option<&str>) -> Option<String> {
    let form = clean_optional(&form);
    match (form, source) {
        (None, None) => None,
        (None, Some("")) => None,
        (None, Some(_)) => Some(String::new()),
        (Some(value), Some(source_value)) if value == source_value => None,
        (Some(value), _) => Some(value.to_string()),
    }
}

/// The series name and its index form one override unit: whenever either
/// differs from the source, the name is promoted to an explicit override so
/// the pair stays representable (an overridden unit with no index means the
/// user cleared the index). `Some("")` clears the whole unit.
fn series_override(
    form_name: Option<String>,
    form_index: Option<f64>,
    source_name: Option<&str>,
    source_index: Option<f64>,
) -> Option<String> {
    let name = clean_optional(&form_name);
    let name_overridden = text_override(form_name, source_name);
    let index_overridden = form_index != source_index;
    match (name_overridden, index_overridden) {
        // Unit inherited: no override.
        (None, false) => None,
        // Name changed (or cleared) → its override is the unit.
        (Some(value), _) => Some(value),
        // Only the index changed → promote the source name explicitly so
        // the cleared/changed index is stored with it.
        (None, true) => name.or_else(|| {
            source_name
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        }),
    }
}

/// The `books.author` display projection of the normalized list, which keeps
/// FTS and every existing read path working unchanged.
fn display_authors(authors: &[String]) -> Option<String> {
    if authors.is_empty() {
        None
    } else {
        Some(authors.join(", "))
    }
}

fn parse_json_list(json: Option<&str>) -> Vec<String> {
    json.and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
}

fn clean_required(value: &str, field: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(format!("{field} must not be empty")));
    }
    Ok(trimmed.to_string())
}

fn clean_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_owned)
}

/// Trim, drop empties, and deduplicate a list while preserving order.
fn clean_list(values: &[String]) -> Vec<String> {
    let mut cleaned: Vec<String> = Vec::with_capacity(values.len());
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !cleaned.iter().any(|existing| existing == trimmed) {
            cleaned.push(trimmed.to_string());
        }
    }
    cleaned
}

/// Magic-byte sniffing for user-picked cover images (the EPUB path carries
/// its media type in the package; an image file only has its bytes).
fn detect_image_media_type(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;

    async fn setup() -> (tempfile::TempDir, sqlx::SqlitePool, i64) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
        let id = books::upsert_book(&pool, &source_book("/lib/mess.epub", "File Garbled Title"))
            .await
            .unwrap()
            .0;
        apply_source_metadata(
            &pool,
            id,
            &source_book("/lib/mess.epub", "File Garbled Title"),
        )
        .await
        .unwrap();
        (tmp, pool, id)
    }

    /// A realistically messy import: multi-creator, subjects, calibre series.
    fn source_book(path: &str, title: &str) -> NewBook {
        NewBook {
            path: path.into(),
            title: title.into(),
            subtitle: Some("Original Subtitle".into()),
            author: Some("Ada Lovelace".into()),
            authors: vec!["Ada Lovelace".into(), "Charles Babbage".into()],
            subjects: vec!["Computing".into()],
            publisher: Some("Old Press".into()),
            language: Some("en".into()),
            isbn: None,
            description: Some("Original description.".into()),
            publication_date: Some("1843".into()),
            series: Some("Analytical Engines".into()),
            series_index: Some(2.0),
            cover_path: None,
            file_size: 100,
            file_mtime: 1_700_000_000,
        }
    }

    /// The edit dialog opens prefilled with the current effective values; a
    /// realistic form save sends everything back. Tests flip the fields they
    /// exercise on top of this.
    fn form(book_id: i64, title: &str) -> MetadataFields {
        let _ = book_id;
        MetadataFields {
            title: title.into(),
            subtitle: Some("Original Subtitle".into()),
            publisher: Some("Old Press".into()),
            language: Some("en".into()),
            isbn: None,
            description: Some("Original description.".into()),
            publication_date: Some("1843".into()),
            series: Some("Analytical Engines".into()),
            series_index: Some(2.0),
            authors: vec!["Ada Lovelace".into(), "Charles Babbage".into()],
            subjects: vec!["Computing".into()],
        }
    }

    async fn effective(pool: &sqlx::SqlitePool, book_id: i64) -> Book {
        books::get_book(pool, book_id).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn source_metadata_is_recorded_and_readable() {
        let (_tmp, pool, id) = setup().await;
        let view = get_book_metadata(&pool, id).await.unwrap().unwrap();
        assert_eq!(view.source.title, "File Garbled Title");
        assert_eq!(
            view.source.authors,
            vec!["Ada Lovelace".to_string(), "Charles Babbage".to_string()]
        );
        assert_eq!(view.source.series.as_deref(), Some("Analytical Engines"));
        // Nothing is overridden yet.
        assert!(!view.overridden.title);
        assert!(!view.overridden.authors);
    }

    #[tokio::test]
    async fn import_populates_effective_columns_from_the_file() {
        let (_tmp, pool, id) = setup().await;
        let book = effective(&pool, id).await;
        assert_eq!(book.title, "File Garbled Title");
        assert_eq!(
            book.author.as_deref(),
            Some("Ada Lovelace, Charles Babbage")
        );
        assert_eq!(book.series_name.as_deref(), Some("Analytical Engines"));
        assert_eq!(book.series_index, Some(2.0));
        assert_eq!(book.publication_date.as_deref(), Some("1843"));
        assert_eq!(
            book.series_id,
            effective_series_id(&pool, "Analytical Engines").await
        );
    }

    async fn effective_series_id(pool: &sqlx::SqlitePool, name: &str) -> Option<i64> {
        sqlx::query_scalar("SELECT id FROM series WHERE name = ?1")
            .bind(name)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn edit_overrides_changed_fields_only() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "Curated Title");
        f.authors = vec!["Ada Lovelace".into()];
        update_book_metadata(&pool, id, &f).await.unwrap();

        let view = get_book_metadata(&pool, id).await.unwrap().unwrap();
        assert!(view.overridden.title);
        assert!(view.overridden.authors);
        assert!(!view.overridden.subtitle, "untouched field stays inherited");
        assert_eq!(view.effective.title, "Curated Title");
        assert_eq!(
            view.effective.subtitle.as_deref(),
            Some("Original Subtitle")
        );
        assert_eq!(view.effective.authors, vec!["Ada Lovelace".to_string()]);

        // The display column carries the list so search keeps working.
        let book = effective(&pool, id).await;
        assert_eq!(book.author.as_deref(), Some("Ada Lovelace"));
    }

    #[tokio::test]
    async fn saving_the_source_value_clears_the_override() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "Curated Title");
        update_book_metadata(&pool, id, &f).await.unwrap();
        assert!(
            get_book_metadata(&pool, id)
                .await
                .unwrap()
                .unwrap()
                .overridden
                .title
        );

        // Typing the original title back removes the override again.
        f.title = "File Garbled Title".into();
        update_book_metadata(&pool, id, &f).await.unwrap();
        assert!(
            !get_book_metadata(&pool, id)
                .await
                .unwrap()
                .unwrap()
                .overridden
                .title
        );
    }

    #[tokio::test]
    async fn clearing_a_field_explicitly_overrides_it_to_empty() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "File Garbled Title");
        f.subtitle = Some(String::new());
        update_book_metadata(&pool, id, &f).await.unwrap();

        let view = get_book_metadata(&pool, id).await.unwrap().unwrap();
        assert!(view.overridden.subtitle);
        assert_eq!(view.effective.subtitle, None, "cleared, not inherited");
        // The source value survives for the reset path.
        assert_eq!(view.source.subtitle.as_deref(), Some("Original Subtitle"));
    }

    #[tokio::test]
    async fn reimport_keeps_overrides_and_refreshes_source() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "Curated Title");
        f.publisher = Some("Curated Press".into());
        update_book_metadata(&pool, id, &f).await.unwrap();

        // The file changes on disk: new title/publisher, author list changes.
        let changed = NewBook {
            title: "Second Edition".into(),
            subtitle: Some("New Subtitle".into()),
            publisher: Some("New Press".into()),
            authors: vec!["Grace Hopper".into()],
            author: Some("Grace Hopper".into()),
            series: None,
            series_index: None,
            subjects: vec!["Compilers".into()],
            file_size: 200,
            file_mtime: 1_800_000_000,
            ..source_book("/lib/mess.epub", "Second Edition")
        };
        apply_source_metadata(&pool, id, &changed).await.unwrap();

        let view = get_book_metadata(&pool, id).await.unwrap().unwrap();
        assert_eq!(view.source.title, "Second Edition", "snapshot refreshed");
        assert_eq!(view.effective.title, "Curated Title", "override wins");
        assert_eq!(view.effective.publisher.as_deref(), Some("Curated Press"));
        // Non-overridden fields follow the new file values.
        assert_eq!(view.effective.subtitle.as_deref(), Some("New Subtitle"));
        assert_eq!(view.effective.series, None, "series change propagates");
        assert_eq!(view.effective.series_index, None);
    }

    #[tokio::test]
    async fn customized_author_list_survives_reimport_until_reset() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "File Garbled Title");
        f.authors = vec!["Ada Lovelace".into(), "Grace Hopper".into()];
        update_book_metadata(&pool, id, &f).await.unwrap();

        let changed = NewBook {
            authors: vec!["Someone Else".into()],
            author: Some("Someone Else".into()),
            ..source_book("/lib/mess.epub", "File Garbled Title")
        };
        apply_source_metadata(&pool, id, &changed).await.unwrap();
        let view = get_book_metadata(&pool, id).await.unwrap().unwrap();
        assert_eq!(
            view.effective.authors,
            vec!["Ada Lovelace".to_string(), "Grace Hopper".to_string()],
            "user-owned list beats the file"
        );

        reset_book_metadata(&pool, id).await.unwrap();
        let view = get_book_metadata(&pool, id).await.unwrap().unwrap();
        assert_eq!(view.effective.authors, vec!["Someone Else".to_string()]);
        assert!(!view.overridden.authors);
    }

    #[tokio::test]
    async fn list_identical_to_source_stays_file_authoritative() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "File Garbled Title");
        f.authors = vec!["Ada Lovelace".into(), "Charles Babbage".into()];
        f.subjects = vec!["Computing".into()];
        update_book_metadata(&pool, id, &f).await.unwrap();
        assert!(
            !get_book_metadata(&pool, id)
                .await
                .unwrap()
                .unwrap()
                .overridden
                .authors,
            "unchanged list must not become user-owned"
        );
    }

    #[tokio::test]
    async fn series_edits_resolve_through_the_normalized_table() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "File Garbled Title");
        f.series = Some("Engines".into());
        f.series_index = Some(7.0);
        update_book_metadata(&pool, id, &f).await.unwrap();

        let book = effective(&pool, id).await;
        assert_eq!(book.series_name.as_deref(), Some("Engines"));
        assert_eq!(book.series_index, Some(7.0));
        assert_eq!(
            book.series_id,
            effective_series_id(&pool, "Engines").await,
            "series names resolve to shared rows"
        );

        // Clearing the series drops membership and the index.
        let mut f = form(id, "File Garbled Title");
        f.series = Some(String::new());
        update_book_metadata(&pool, id, &f).await.unwrap();
        let book = effective(&pool, id).await;
        assert_eq!(book.series_id, None);
        assert_eq!(book.series_index, None, "index dies with the series");
        // The source series survives for resets.
        assert_eq!(
            get_book_metadata(&pool, id)
                .await
                .unwrap()
                .unwrap()
                .source
                .series
                .as_deref(),
            Some("Analytical Engines")
        );
    }

    #[tokio::test]
    async fn index_only_change_keeps_the_inherited_series_name() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "File Garbled Title");
        f.series = Some("Analytical Engines".into());
        f.series_index = Some(3.0);
        update_book_metadata(&pool, id, &f).await.unwrap();

        let book = effective(&pool, id).await;
        assert_eq!(book.series_name.as_deref(), Some("Analytical Engines"));
        assert_eq!(book.series_index, Some(3.0));
        assert!(
            get_book_metadata(&pool, id)
                .await
                .unwrap()
                .unwrap()
                .overridden
                .series
        );
    }

    #[tokio::test]
    async fn reset_restores_every_field_from_the_source() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "Totally Different");
        f.subtitle = Some(String::new());
        f.authors = vec!["X".into()];
        f.series = Some(String::new());
        update_book_metadata(&pool, id, &f).await.unwrap();

        let view = reset_book_metadata(&pool, id).await.unwrap();
        assert_eq!(view.effective.title, "File Garbled Title");
        assert_eq!(
            view.effective.subtitle.as_deref(),
            Some("Original Subtitle")
        );
        assert_eq!(view.effective.authors.len(), 2);
        assert_eq!(view.effective.series.as_deref(), Some("Analytical Engines"));
        assert!(!view.overridden.title);
        assert!(!view.overridden.authors);
        assert!(!view.overridden.series);

        // Orphaned curation rows (X, Eng…) are swept with the reset.
        let orphans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM authors WHERE name = 'X'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(orphans, 0, "orphaned author rows are collected");
    }

    #[tokio::test]
    async fn blank_title_is_rejected() {
        let (_tmp, pool, id) = setup().await;
        let f = form(id, "   ");
        let err = update_book_metadata(&pool, id, &f).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn form_whitespace_and_duplicate_list_entries_are_normalized() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "  Spaced Title  ");
        f.authors = vec!["  Ada Lovelace  ".into(), "Ada Lovelace".into(), "".into()];
        f.subjects = vec![" Computing ".into()];
        update_book_metadata(&pool, id, &f).await.unwrap();

        let view = get_book_metadata(&pool, id).await.unwrap().unwrap();
        assert_eq!(view.effective.title, "Spaced Title");
        assert_eq!(view.effective.authors, vec!["Ada Lovelace".to_string()]);
        assert_eq!(view.effective.subjects, vec!["Computing".to_string()]);
    }

    #[tokio::test]
    async fn non_finite_series_index_is_rejected() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "T");
        f.series_index = Some(f64::NAN);
        let err = update_book_metadata(&pool, id, &f).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn editing_metadata_updates_the_fts_index() {
        let (_tmp, pool, id) = setup().await;
        let mut f = form(id, "Zombie Physics");
        f.authors = vec!["New Name".into()];
        update_book_metadata(&pool, id, &f).await.unwrap();

        let hits = crate::services::search::search_books(&pool, "zombie physics")
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].book_id, id);
        assert_eq!(hits[0].author.as_deref(), Some("New Name"));

        // The old values leave the index with the edit.
        let hits = crate::services::search::search_books(&pool, "garbled")
            .await
            .unwrap();
        assert!(hits.is_empty());
    }

    #[tokio::test]
    async fn cover_override_wins_and_survives_reimport() {
        let tmp_dir = tempfile::tempdir().unwrap();
        let covers = tmp_dir.path().join("covers");
        std::fs::create_dir_all(&covers).unwrap();

        let (_tmp, pool, id) = setup().await;
        // A source cover exists after the "import".
        let source_png = covers.join("source.png");
        std::fs::write(&source_png, b"\x89PNG\r\n\x1a\n source").unwrap();
        let with_cover = NewBook {
            cover_path: Some(source_png.to_string_lossy().into_owned()),
            ..source_book("/lib/mess.epub", "File Garbled Title")
        };
        repo::upsert_source_metadata(&pool, id, &with_cover)
            .await
            .unwrap();
        recompute_and_apply(&pool, id).await.unwrap();
        assert_eq!(
            effective(&pool, id).await.cover_path,
            Some(source_png.to_string_lossy().into_owned())
        );

        // The user picks a custom image.
        let custom = tmp_dir.path().join("custom.png");
        std::fs::write(&custom, b"\x89PNG\r\n\x1a\n custom-bytes").unwrap();
        let book = set_book_cover(&pool, id, custom.to_str().unwrap(), &covers)
            .await
            .unwrap();
        let custom_path = book.cover_path.clone().unwrap();
        assert_ne!(custom_path, source_png.to_string_lossy().into_owned());
        assert_eq!(
            std::fs::read(&custom_path).unwrap(),
            b"\x89PNG\r\n\x1a\n custom-bytes"
        );

        // A re-import with a new extracted cover cannot take it away.
        let new_png = covers.join("new.png");
        std::fs::write(&new_png, b"\x89PNG\r\n\x1a\n new").unwrap();
        let changed = NewBook {
            cover_path: Some(new_png.to_string_lossy().into_owned()),
            ..source_book("/lib/mess.epub", "File Garbled Title")
        };
        apply_source_metadata(&pool, id, &changed).await.unwrap();
        assert_eq!(effective(&pool, id).await.cover_path, Some(custom_path));

        // Clearing the override returns the extracted cover.
        let book = clear_book_cover_override(&pool, id).await.unwrap();
        assert_eq!(
            book.cover_path,
            Some(new_png.to_string_lossy().into_owned())
        );
    }

    #[tokio::test]
    async fn set_book_cover_rejects_unknown_books_and_bad_images() {
        let tmp_dir = tempfile::tempdir().unwrap();
        let covers = tmp_dir.path().join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        let (_tmp, pool, id) = setup().await;

        let err = set_book_cover(&pool, 999, "whatever.png", &covers)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound));

        let not_image = tmp_dir.path().join("not.png");
        std::fs::write(&not_image, b"plain text").unwrap();
        let err = set_book_cover(&pool, id, not_image.to_str().unwrap(), &covers)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn get_book_metadata_is_none_for_unknown_ids() {
        let (_tmp, pool, _id) = setup().await;
        assert!(get_book_metadata(&pool, 999).await.unwrap().is_none());
    }

    #[test]
    fn image_sniffing_recognizes_the_supported_formats() {
        assert_eq!(
            detect_image_media_type(b"\x89PNG\r\n\x1a\n rest"),
            Some("image/png")
        );
        assert_eq!(
            detect_image_media_type(b"\xff\xd8\xff rest"),
            Some("image/jpeg")
        );
        assert_eq!(detect_image_media_type(b"GIF89a...."), Some("image/gif"));
        assert_eq!(detect_image_media_type(b"GIF87a...."), Some("image/gif"));
        assert_eq!(
            detect_image_media_type(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(detect_image_media_type(b"text"), None);
    }
}
