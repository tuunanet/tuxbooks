use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppError;

/// One full-text search hit against the `books_fts` index.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub book_id: i64,
    pub title: String,
    pub snippet: String,
}

/// Search the library using the FTS5 index. The query syntax is FTS5 MATCH
/// syntax; malformed queries surface as [`AppError::Database`].
pub async fn search_books(pool: &SqlitePool, query: &str) -> Result<Vec<SearchHit>, AppError> {
    if query.trim().is_empty() {
        return Err(AppError::InvalidInput("search query is empty".into()));
    }

    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT b.id, b.title, snippet(books_fts, 3, '<em>', '</em>', '…', 12) AS snippet
        FROM books_fts
        JOIN books b ON b.id = books_fts.rowid
        WHERE books_fts MATCH ?1
        ORDER BY rank
        LIMIT 50
        "#,
    )
    .bind(query)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(book_id, title, snippet)| SearchHit {
            book_id,
            title,
            snippet,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::domain::NewBook;
    use crate::repository::books;

    async fn pool_with_one_book() -> (tempfile::TempDir, SqlitePool) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
        books::upsert_book(
            &pool,
            &NewBook {
                path: "/tmp/willows.epub".into(),
                title: "The Wind in the Willows".into(),
                subtitle: None,
                author: Some("Kenneth Grahame".into()),
                publisher: None,
                language: Some("en".into()),
                isbn: None,
                description: Some("Mole and Rat adventure on the river.".into()),
                cover_path: None,
            },
        )
        .await
        .unwrap();
        (tmp, pool)
    }

    #[tokio::test]
    async fn finds_books_by_title() {
        let (_tmp, pool) = pool_with_one_book().await;
        let hits = search_books(&pool, "willows").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "The Wind in the Willows");
    }

    #[tokio::test]
    async fn finds_books_by_description() {
        let (_tmp, pool) = pool_with_one_book().await;
        let hits = search_books(&pool, "river").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("river"));
    }

    #[tokio::test]
    async fn empty_query_is_invalid_input() {
        let (_tmp, pool) = pool_with_one_book().await;
        let err = search_books(&pool, "   ").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn no_match_returns_empty_list() {
        let (_tmp, pool) = pool_with_one_book().await;
        let hits = search_books(&pool, "potato").await.unwrap();
        assert!(hits.is_empty());
    }

    #[tokio::test]
    async fn updating_book_keeps_fts_index_in_sync() {
        let (tmp, pool) = pool_with_one_book().await;
        books::upsert_book(
            &pool,
            &NewBook {
                path: "/tmp/willows.epub".into(),
                title: "Completely Different Title".into(),
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
        .unwrap();

        let old = search_books(&pool, "willows").await.unwrap();
        assert!(old.is_empty(), "old title must no longer match");
        let new = search_books(&pool, "different").await.unwrap();
        assert_eq!(new.len(), 1);
        drop(tmp);
    }
}
