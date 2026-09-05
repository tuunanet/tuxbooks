use sqlx::SqlitePool;

use crate::domain::{Annotation, AnnotationKind, AnnotationPatch, NewAnnotation};
use crate::error::AppError;

const COLUMNS: &str = "id, book_id, kind, cfi, chapter_href, page_number, page_fraction, \
                       text, color, geometry, note, created_at, modified_at";

/// Document order: PDF rows by page (all EPUB rows have `NULL` page numbers
/// and therefore sort together by spine href, then CFI). `id` breaks ties.
const ORDER: &str = "ORDER BY page_number, chapter_href, cfi, id";

fn kind_column(kind: AnnotationKind) -> &'static str {
    match kind {
        AnnotationKind::Bookmark => "bookmark",
        AnnotationKind::Highlight => "highlight",
    }
}

pub async fn insert_annotation(
    pool: &SqlitePool,
    book_id: i64,
    new: &NewAnnotation,
) -> Result<Annotation, AppError> {
    let annotation = sqlx::query_as::<_, Annotation>(
        r#"
        INSERT INTO annotations (book_id, kind, cfi, chapter_href, page_number, page_fraction, text, color, geometry)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        RETURNING id, book_id, kind, cfi, chapter_href, page_number, page_fraction,
                  text, color, geometry, note, created_at, modified_at
        "#,
    )
    .bind(book_id)
    .bind(kind_column(new.kind))
    .bind(&new.cfi)
    .bind(&new.chapter_href)
    .bind(new.page_number)
    .bind(new.page_fraction)
    .bind(&new.text)
    .bind(&new.color)
    .bind(&new.geometry)
    .fetch_one(pool)
    .await?;
    Ok(annotation)
}

pub async fn list_annotations(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Vec<Annotation>, AppError> {
    let annotations = sqlx::query_as::<_, Annotation>(&format!(
        "SELECT {COLUMNS} FROM annotations WHERE book_id = ?1 {ORDER}"
    ))
    .bind(book_id)
    .fetch_all(pool)
    .await?;
    Ok(annotations)
}

pub async fn get_annotation(pool: &SqlitePool, id: i64) -> Result<Option<Annotation>, AppError> {
    let annotation = sqlx::query_as::<_, Annotation>(&format!(
        "SELECT {COLUMNS} FROM annotations WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(annotation)
}

/// Applies the color/note patch; returns the updated row, or `None` when
/// the id does not exist.
pub async fn update_annotation(
    pool: &SqlitePool,
    id: i64,
    patch: &AnnotationPatch,
) -> Result<Option<Annotation>, AppError> {
    let annotation = sqlx::query_as::<_, Annotation>(
        r#"
        UPDATE annotations SET
            color = COALESCE(?2, color),
            note = ?3,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        RETURNING id, book_id, kind, cfi, chapter_href, page_number, page_fraction,
                  text, color, geometry, note, created_at, modified_at
        "#,
    )
    .bind(id)
    .bind(&patch.color)
    .bind(&patch.note)
    .fetch_optional(pool)
    .await?;
    Ok(annotation)
}

pub async fn delete_annotation(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM annotations WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::books;

    fn epub_bookmark(cfi: &str) -> NewAnnotation {
        NewAnnotation {
            kind: AnnotationKind::Bookmark,
            cfi: Some(cfi.into()),
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
            page_fraction: Some(0.5),
            text: None,
            color: None,
            geometry: None,
        }
    }

    fn epub_highlight(cfi: &str) -> NewAnnotation {
        NewAnnotation {
            kind: AnnotationKind::Highlight,
            cfi: Some(cfi.into()),
            chapter_href: None,
            page_number: None,
            page_fraction: None,
            text: Some("passage".into()),
            color: Some("yellow".into()),
            geometry: None,
        }
    }

    async fn pool_with_book() -> (tempfile::TempDir, SqlitePool, i64) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let id = books::upsert_book(
            &pool,
            &crate::domain::NewBook {
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

    #[tokio::test]
    async fn insert_returns_stored_row_with_timestamps() {
        let (_tmp, pool, book_id) = pool_with_book().await;

        let mut new = epub_highlight("epubcfi(/6/4!/4/2,/1:0,/1:42)");
        new.chapter_href = Some("chapter2.xhtml".into());
        new.text = Some("the quoted passage".into());
        let stored = insert_annotation(&pool, book_id, &new).await.unwrap();

        assert_eq!(stored.book_id, book_id);
        assert_eq!(stored.kind, AnnotationKind::Highlight);
        assert_eq!(stored.cfi.as_deref(), Some("epubcfi(/6/4!/4/2,/1:0,/1:42)"));
        assert_eq!(stored.text.as_deref(), Some("the quoted passage"));
        assert_eq!(stored.color.as_deref(), Some("yellow"));
        assert!(stored.note.is_none());
    }

    #[tokio::test]
    async fn list_orders_pdf_by_page_and_epub_by_spine() {
        let (_tmp, pool, book_id) = pool_with_book().await;

        for (cfi, href) in [
            ("/6/6", "c3.xhtml"),
            ("/6/4", "c1.xhtml"),
            ("/6/5", "c2.xhtml"),
        ] {
            let mut new = epub_bookmark(&format!("epubcfi({cfi})"));
            new.chapter_href = Some(href.into());
            insert_annotation(&pool, book_id, &new).await.unwrap();
        }
        for page in [7, 2] {
            insert_annotation(&pool, book_id, &pdf_bookmark(page))
                .await
                .unwrap();
        }

        let listed = list_annotations(&pool, book_id).await.unwrap();
        assert_eq!(listed.len(), 5);
        // SQLite ASC order puts NULL page numbers (the EPUB rows) first,
        // sorted by spine href; the PDF rows follow by page.
        let hrefs: Vec<_> = listed[..3]
            .iter()
            .map(|a| a.chapter_href.as_deref().unwrap())
            .collect();
        assert_eq!(hrefs, ["c1.xhtml", "c2.xhtml", "c3.xhtml"]);
        assert_eq!(listed[3].page_number, Some(2));
        assert_eq!(listed[4].page_number, Some(7));
    }

    #[tokio::test]
    async fn update_patches_color_and_note_without_touching_locator() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let stored = insert_annotation(&pool, book_id, &epub_highlight("epubcfi(/6/4)"))
            .await
            .unwrap();

        let updated = update_annotation(
            &pool,
            stored.id,
            &AnnotationPatch {
                color: Some("green".into()),
                note: Some("remember this".into()),
            },
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(updated.color.as_deref(), Some("green"));
        assert_eq!(updated.note.as_deref(), Some("remember this"));
        assert_eq!(updated.cfi.as_deref(), Some("epubcfi(/6/4)"));
        assert!(updated.modified_at >= stored.modified_at);
    }

    #[tokio::test]
    async fn update_of_missing_id_is_none() {
        let (_tmp, pool, _book_id) = pool_with_book().await;
        assert!(update_annotation(
            &pool,
            999,
            &AnnotationPatch {
                color: None,
                note: Some("x".into())
            }
        )
        .await
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn delete_removes_exactly_one_row() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let stored = insert_annotation(&pool, book_id, &epub_bookmark("epubcfi(/6/4)"))
            .await
            .unwrap();

        assert!(delete_annotation(&pool, stored.id).await.unwrap());
        assert!(!delete_annotation(&pool, stored.id).await.unwrap());
        assert!(get_annotation(&pool, stored.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn missing_book_violates_foreign_key() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let err = insert_annotation(&pool, 999, &epub_bookmark("epubcfi(/6/4)"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn removing_book_cascades_to_annotations() {
        let (tmp, pool, book_id) = pool_with_book().await;
        insert_annotation(&pool, book_id, &epub_bookmark("epubcfi(/6/4)"))
            .await
            .unwrap();

        crate::repository::books::delete_book(&pool, book_id)
            .await
            .unwrap();
        assert!(list_annotations(&pool, book_id).await.unwrap().is_empty());
        drop(tmp);
    }
}
