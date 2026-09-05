use sqlx::SqlitePool;

use crate::domain::{Annotation, AnnotationKind, AnnotationPatch, AnnotationRect, NewAnnotation};
use crate::error::AppError;
use crate::repository::annotations;

/// Decode and validate stored highlight geometry: a JSON array of rects
/// normalized to page space (0..1 on both axes).
pub fn parse_geometry(json: &str) -> Result<Vec<AnnotationRect>, AppError> {
    let rects: Vec<AnnotationRect> = serde_json::from_str(json)
        .map_err(|_| AppError::InvalidInput("bad geometry JSON".into()))?;
    for rect in &rects {
        let ok = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
        let finite_in_range = ok(rect.x)
            && ok(rect.y)
            && ok(rect.width)
            && ok(rect.height)
            && rect.x + rect.width <= 1.0
            && rect.y + rect.height <= 1.0;
        if !finite_in_range {
            return Err(AppError::InvalidInput(
                "geometry rect outside normalized page space".into(),
            ));
        }
    }
    Ok(rects)
}

fn clean_optional(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
}

/// A locator must name one stable document position: an EPUB CFI or a 1-based
/// PDF page. The optional page fraction stays inside the page.
fn validate_locator(new: &NewAnnotation) -> Result<(), AppError> {
    let has_cfi = clean_optional(&new.cfi).is_some();
    if let Some(page) = new.page_number {
        if page < 1 {
            return Err(AppError::InvalidInput(
                "annotation page_number must be >= 1".into(),
            ));
        }
    }
    let has_page = new.page_number.is_some();
    if !has_cfi && !has_page {
        return Err(AppError::InvalidInput(
            "annotation needs a CFI or a page number locator".into(),
        ));
    }
    if let Some(fraction) = new.page_fraction {
        if !(0.0..=1.0).contains(&fraction) {
            return Err(AppError::InvalidInput("page_fraction outside 0..=1".into()));
        }
    }
    Ok(())
}

/// Business rules for new annotations: every annotation names a document
/// position; highlights quote selected text (mandatory for EPUB, where the
/// CFI alone carries no visible text; optional for PDF, where a selection
/// may cover no extractable text) and may carry normalized geometry.
pub fn validate_new(new: &NewAnnotation) -> Result<(), AppError> {
    validate_locator(new)?;
    if new.kind == AnnotationKind::Highlight {
        if clean_optional(&new.cfi).is_some() && clean_optional(&new.text).is_none() {
            return Err(AppError::InvalidInput(
                "EPUB highlight needs the selected text".into(),
            ));
        }
        if let Some(geometry) = clean_optional(&new.geometry) {
            parse_geometry(geometry)?;
        }
    }
    Ok(())
}

pub async fn create_annotation(
    pool: &SqlitePool,
    book_id: i64,
    new: &NewAnnotation,
) -> Result<Annotation, AppError> {
    validate_new(new)?;
    annotations::insert_annotation(pool, book_id, new).await
}

pub async fn list_annotations(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Vec<Annotation>, AppError> {
    annotations::list_annotations(pool, book_id).await
}

/// Applies a color/note patch to an existing annotation; `None` when the id
/// does not exist.
pub async fn update_annotation(
    pool: &SqlitePool,
    id: i64,
    patch: &AnnotationPatch,
) -> Result<Option<Annotation>, AppError> {
    if let Some(color) = clean_optional(&patch.color) {
        if color.len() > 32 {
            return Err(AppError::InvalidInput("color name too long".into()));
        }
    }
    annotations::update_annotation(pool, id, patch).await
}

pub async fn delete_annotation(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    annotations::delete_annotation(pool, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::domain::NewBook;
    use crate::repository::books;

    async fn pool_with_book() -> (tempfile::TempDir, sqlx::SqlitePool, i64) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
        let id = books::upsert_book(
            &pool,
            &NewBook {
                path: "/a.epub".into(),
                title: "A".into(),
                subtitle: None,
                author: None,
                publisher: None,
                language: None,
                isbn: None,
                description: None,
                cover_path: None,
                file_size: 0,
                file_mtime: 0,
            },
        )
        .await
        .unwrap()
        .0;
        (tmp, pool, id)
    }

    fn epub_highlight() -> NewAnnotation {
        NewAnnotation {
            kind: AnnotationKind::Highlight,
            cfi: Some("epubcfi(/6/4!/4/2,/1:0,/1:10)".into()),
            chapter_href: None,
            page_number: None,
            page_fraction: None,
            text: Some("a passage".into()),
            color: Some("yellow".into()),
            geometry: None,
        }
    }

    fn epub_bookmark() -> NewAnnotation {
        NewAnnotation {
            kind: AnnotationKind::Bookmark,
            cfi: Some("epubcfi(/6/4)".into()),
            chapter_href: None,
            page_number: None,
            page_fraction: None,
            text: None,
            color: None,
            geometry: None,
        }
    }

    fn pdf_bookmark(page: i64) -> NewAnnotation {
        NewAnnotation {
            kind: AnnotationKind::Bookmark,
            cfi: None,
            chapter_href: None,
            page_number: Some(page),
            page_fraction: None,
            text: None,
            color: None,
            geometry: None,
        }
    }

    #[test]
    fn geometry_roundtrips_normalized_rects() {
        let json = r#"[{"x":0.1,"y":0.2,"width":0.3,"height":0.05}]"#;
        let rects = parse_geometry(json).unwrap();
        assert_eq!(rects.len(), 1);
        assert_eq!(
            rects[0],
            AnnotationRect {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.05
            }
        );
    }

    #[test]
    fn geometry_rejects_malformed_and_out_of_range_rects() {
        assert!(parse_geometry("not json").is_err());
        assert!(parse_geometry(r#"[{"x":1.5,"y":0,"width":0.1,"height":0.1}]"#).is_err());
        assert!(parse_geometry(r#"[{"x":0.9,"y":0,"width":0.5,"height":0.1}]"#).is_err());
        assert!(parse_geometry(r#"[{"x":0,"y":0,"width":-1,"height":0.1}]"#).is_err());
    }

    #[tokio::test]
    async fn creates_epub_bookmark_and_highlight() {
        let (_tmp, pool, book_id) = pool_with_book().await;

        let mut bookmark = epub_bookmark();
        bookmark.chapter_href = Some("c1.xhtml".into());
        let bookmark = create_annotation(&pool, book_id, &bookmark).await.unwrap();
        assert_eq!(bookmark.kind, AnnotationKind::Bookmark);

        let highlight = create_annotation(&pool, book_id, &epub_highlight())
            .await
            .unwrap();
        assert_eq!(highlight.kind, AnnotationKind::Highlight);
    }

    #[tokio::test]
    async fn creates_pdf_bookmark_with_page_fraction() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let mut new = pdf_bookmark(3);
        new.page_fraction = Some(0.25);
        let stored = create_annotation(&pool, book_id, &new).await.unwrap();
        assert_eq!(stored.page_number, Some(3));
        assert_eq!(stored.page_fraction, Some(0.25));
    }

    #[tokio::test]
    async fn locator_is_required() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let mut new = epub_bookmark();
        new.cfi = None;
        let err = create_annotation(&pool, book_id, &new).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn epub_highlight_requires_text() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let mut new = epub_highlight();
        new.text = None;
        let err = create_annotation(&pool, book_id, &new).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn pdf_highlight_allows_missing_text_but_validates_geometry() {
        let (_tmp, pool, book_id) = pool_with_book().await;

        let mut new = pdf_bookmark(2);
        new.kind = AnnotationKind::Highlight;
        new.color = Some("green".into());
        create_annotation(&pool, book_id, &new).await.unwrap();

        let mut bad = epub_highlight();
        bad.cfi = None;
        bad.text = None;
        bad.page_number = Some(2);
        bad.geometry = Some(r#"[{"x":0.9,"y":0,"width":0.5,"height":0.1}]"#.into());
        let err = create_annotation(&pool, book_id, &bad).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn page_number_must_be_positive() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let err = create_annotation(&pool, book_id, &pdf_bookmark(0))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn page_fraction_must_stay_inside_the_page() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let mut new = epub_highlight();
        new.cfi = None;
        new.page_number = Some(1);
        new.page_fraction = Some(1.5);
        let err = create_annotation(&pool, book_id, &new).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn update_rejects_overlong_colors_and_missing_ids() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let stored = create_annotation(&pool, book_id, &epub_highlight())
            .await
            .unwrap();

        let err = update_annotation(
            &pool,
            stored.id,
            &AnnotationPatch {
                color: Some("x".repeat(33)),
                note: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");

        assert!(update_annotation(
            &pool,
            999,
            &AnnotationPatch {
                color: Some("blue".into()),
                note: None
            }
        )
        .await
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn update_clears_note_with_empty_string() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let stored = create_annotation(&pool, book_id, &epub_highlight())
            .await
            .unwrap();
        update_annotation(
            &pool,
            stored.id,
            &AnnotationPatch {
                color: None,
                note: Some("first".into()),
            },
        )
        .await
        .unwrap()
        .unwrap();
        let cleared = update_annotation(
            &pool,
            stored.id,
            &AnnotationPatch {
                color: None,
                note: Some(String::new()),
            },
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(cleared.note.as_deref(), Some(""));
    }
}
