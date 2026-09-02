use sqlx::SqlitePool;

use crate::domain::{ProgressUpdate, ReadingProgress};
use crate::error::AppError;

pub async fn upsert_progress(
    pool: &SqlitePool,
    book_id: i64,
    update: &ProgressUpdate,
) -> Result<(), AppError> {
    if let Some(percent) = update.progress_percent {
        if !(0.0..=100.0).contains(&percent) {
            return Err(AppError::InvalidInput(format!(
                "progress_percent {percent} outside 0..=100"
            )));
        }
    }
    sqlx::query(
        r#"
        INSERT INTO reading_progress (book_id, chapter_href, cfi, character_offset, page_number, scroll_offset, progress_percent)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(book_id) DO UPDATE SET
            chapter_href = excluded.chapter_href,
            cfi = excluded.cfi,
            character_offset = excluded.character_offset,
            page_number = excluded.page_number,
            scroll_offset = excluded.scroll_offset,
            progress_percent = excluded.progress_percent,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(book_id)
    .bind(&update.chapter_href)
    .bind(&update.cfi)
    .bind(update.character_offset)
    .bind(update.page_number)
    .bind(update.scroll_offset)
    .bind(update.progress_percent)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_progress(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<ReadingProgress>, AppError> {
    let progress = sqlx::query_as::<_, ReadingProgress>(
        "SELECT book_id, chapter_href, cfi, character_offset, page_number, scroll_offset, progress_percent, updated_at \
         FROM reading_progress WHERE book_id = ?1",
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::books;

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
            },
        )
        .await
        .unwrap()
        .0;
        (tmp, pool, id)
    }

    #[tokio::test]
    async fn upsert_then_get_roundtrips() {
        let (_tmp, pool, book_id) = pool_with_book().await;

        upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                chapter_href: Some("chapter2.xhtml".into()),
                cfi: Some("epubcfi(/6/4!/4/2,/1:0,/1:42)".into()),
                character_offset: Some(1024),
                page_number: Some(87),
                scroll_offset: Some(412.5),
                progress_percent: Some(42.5),
            },
        )
        .await
        .unwrap();

        let progress = get_progress(&pool, book_id).await.unwrap().unwrap();
        assert_eq!(progress.book_id, book_id);
        assert_eq!(progress.chapter_href.as_deref(), Some("chapter2.xhtml"));
        assert_eq!(
            progress.cfi.as_deref(),
            Some("epubcfi(/6/4!/4/2,/1:0,/1:42)")
        );
        assert_eq!(progress.character_offset, Some(1024));
        assert_eq!(progress.page_number, Some(87));
        assert_eq!(progress.scroll_offset, Some(412.5));
        assert_eq!(progress.progress_percent, Some(42.5));
    }

    #[tokio::test]
    async fn second_upsert_overwrites_without_duplicating() {
        let (_tmp, pool, book_id) = pool_with_book().await;

        upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                chapter_href: Some("c1.xhtml".into()),
                cfi: Some("epubcfi(/6/2!/4/2,/1:0,/1:10)".into()),
                character_offset: None,
                page_number: None,
                scroll_offset: None,
                progress_percent: Some(10.0),
            },
        )
        .await
        .unwrap();
        upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                chapter_href: Some("c2.xhtml".into()),
                cfi: Some("epubcfi(/6/4!/4/2,/1:0,/1:20)".into()),
                character_offset: Some(9),
                page_number: Some(3),
                scroll_offset: None,
                progress_percent: Some(90.0),
            },
        )
        .await
        .unwrap();

        let progress = get_progress(&pool, book_id).await.unwrap().unwrap();
        assert_eq!(progress.chapter_href.as_deref(), Some("c2.xhtml"));
        assert_eq!(
            progress.cfi.as_deref(),
            Some("epubcfi(/6/4!/4/2,/1:0,/1:20)")
        );
        assert_eq!(progress.progress_percent, Some(90.0));
    }

    #[tokio::test]
    async fn out_of_range_percent_is_invalid_input() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let err = upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                chapter_href: None,
                cfi: None,
                character_offset: None,
                page_number: None,
                scroll_offset: None,
                progress_percent: Some(150.0),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn missing_book_violates_foreign_key() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let err = upsert_progress(&pool, 999, &ProgressUpdate::default())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "got: {err:?}");
    }
}
