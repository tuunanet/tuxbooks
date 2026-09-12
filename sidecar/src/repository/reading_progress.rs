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
    if let Some(progression) = update.progression {
        if !(0.0..=1.0).contains(&progression) {
            return Err(AppError::InvalidInput(format!(
                "progression {progression} outside 0..=1"
            )));
        }
    }
    // The locator columns are preserved when a save does not carry them: a
    // PDF save must never clobber an EPUB locator, a Readium save must
    // never clobber the foliate-era `cfi`/`chapter_href` provenance
    // (docs/EPUB.md: original data is preserved until the adapter's
    // conversion is validated), and percent-only writes never touch any
    // locator. Each format writes the columns it owns on every save.
    sqlx::query(
        r#"
        INSERT INTO reading_progress
            (book_id, chapter_href, cfi, character_offset, page_number, scroll_offset,
             progress_percent, locator, progression, locations, engine, schema_version)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(book_id) DO UPDATE SET
            chapter_href = coalesce(excluded.chapter_href, reading_progress.chapter_href),
            cfi = coalesce(excluded.cfi, reading_progress.cfi),
            character_offset = coalesce(excluded.character_offset, reading_progress.character_offset),
            page_number = coalesce(excluded.page_number, reading_progress.page_number),
            scroll_offset = coalesce(excluded.scroll_offset, reading_progress.scroll_offset),
            progress_percent = excluded.progress_percent,
            locator = coalesce(excluded.locator, reading_progress.locator),
            progression = coalesce(excluded.progression, reading_progress.progression),
            locations = coalesce(excluded.locations, reading_progress.locations),
            engine = coalesce(excluded.engine, reading_progress.engine),
            schema_version = coalesce(excluded.schema_version, reading_progress.schema_version),
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
    .bind(&update.locator)
    .bind(update.progression)
    .bind(&update.locations)
    .bind(&update.engine)
    .bind(update.schema_version)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_progress(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<ReadingProgress>, AppError> {
    let progress = sqlx::query_as::<_, ReadingProgress>(
        "SELECT book_id, chapter_href, cfi, character_offset, page_number, scroll_offset, \
                progress_percent, locator, progression, locations, engine, schema_version, updated_at \
         FROM reading_progress WHERE book_id = ?1",
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    Ok(progress)
}

/// Flag a book as finished (milestone 10 "Finished" section and the
/// context-menu "Mark as Finished" action). Sets `progress_percent = 100`
/// without touching the stored reading position, so resuming the book still
/// lands where the user stopped; reading again saves a real percent and
/// naturally moves the book back to "In Progress".
pub async fn mark_finished(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO reading_progress (book_id, progress_percent)
        VALUES (?1, 100)
        ON CONFLICT(book_id) DO UPDATE SET
            progress_percent = 100,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(book_id)
    .execute(pool)
    .await?;
    Ok(())
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
                ..ProgressUpdate::default()
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
        assert_eq!(progress.locator, None);
        assert_eq!(progress.engine, None);
    }

    #[tokio::test]
    async fn engine_locator_columns_roundtrip() {
        let (_tmp, pool, book_id) = pool_with_book().await;

        upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                chapter_href: Some("chapter1.xhtml".into()),
                cfi: Some("epubcfi(/6/2!/4,/2,/6/1:89)".into()),
                progress_percent: Some(12.5),
                locator: Some(
                    r#"{"href":"chapter1.xhtml","locations":{"progression":0.4}}"#.into(),
                ),
                progression: Some(0.12),
                locations: Some(r#"{"progression":0.4}"#.into()),
                engine: Some("readium".into()),
                schema_version: Some(2),
                ..ProgressUpdate::default()
            },
        )
        .await
        .unwrap();

        let progress = get_progress(&pool, book_id).await.unwrap().unwrap();
        assert_eq!(progress.engine.as_deref(), Some("readium"));
        assert_eq!(progress.schema_version, Some(2));
        assert_eq!(progress.progression, Some(0.12));
        assert!(progress
            .locator
            .as_deref()
            .unwrap()
            .contains("chapter1.xhtml"));
        // The foliate-era locator stays as provenance beside the converted one.
        assert_eq!(progress.cfi.as_deref(), Some("epubcfi(/6/2!/4,/2,/6/1:89)"));
    }

    #[tokio::test]
    async fn saves_without_locator_columns_preserve_engine_locators() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                progress_percent: Some(10.0),
                locator: Some(r#"{"href":"c1.xhtml"}"#.into()),
                progression: Some(0.1),
                engine: Some("readium".into()),
                schema_version: Some(2),
                ..ProgressUpdate::default()
            },
        )
        .await
        .unwrap();

        // A later live save (or the coarse percent-only write) must not
        // clobber the engine locator — the marker is monotonic.
        upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                progress_percent: Some(35.0),
                ..ProgressUpdate::default()
            },
        )
        .await
        .unwrap();

        let progress = get_progress(&pool, book_id).await.unwrap().unwrap();
        assert_eq!(progress.progress_percent, Some(35.0));
        assert_eq!(progress.engine.as_deref(), Some("readium"));
        assert_eq!(progress.locator.as_deref(), Some(r#"{"href":"c1.xhtml"}"#));
        assert_eq!(progress.progression, Some(0.1));
    }

    #[tokio::test]
    async fn out_of_range_progression_is_invalid_input() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        let err = upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                progression: Some(1.5),
                ..ProgressUpdate::default()
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
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
                ..ProgressUpdate::default()
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
                ..ProgressUpdate::default()
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
                ..ProgressUpdate::default()
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

    #[tokio::test]
    async fn mark_finished_sets_100_and_preserves_position() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        upsert_progress(
            &pool,
            book_id,
            &ProgressUpdate {
                chapter_href: Some("c3.xhtml".into()),
                cfi: Some("epubcfi(/6/6!/4/2,/1:0,/1:30)".into()),
                character_offset: None,
                page_number: None,
                scroll_offset: None,
                progress_percent: Some(71.0),
                ..ProgressUpdate::default()
            },
        )
        .await
        .unwrap();

        mark_finished(&pool, book_id).await.unwrap();
        let progress = get_progress(&pool, book_id).await.unwrap().unwrap();
        assert_eq!(progress.progress_percent, Some(100.0));
        // The stored reading position survives the "finished" flag, so
        // reopening the book still resumes where reading stopped.
        assert_eq!(progress.chapter_href.as_deref(), Some("c3.xhtml"));
        assert_eq!(
            progress.cfi.as_deref(),
            Some("epubcfi(/6/6!/4/2,/1:0,/1:30)")
        );
    }

    #[tokio::test]
    async fn mark_finished_creates_row_for_unread_book() {
        let (_tmp, pool, book_id) = pool_with_book().await;
        assert!(get_progress(&pool, book_id).await.unwrap().is_none());

        mark_finished(&pool, book_id).await.unwrap();
        let progress = get_progress(&pool, book_id).await.unwrap().unwrap();
        assert_eq!(progress.progress_percent, Some(100.0));
        assert_eq!(progress.chapter_href, None);
    }
}
