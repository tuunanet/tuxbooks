use sqlx::SqlitePool;

use crate::domain::SearchHit;
use crate::error::AppError;
use crate::repository::books;

/// Turns a raw user query into FTS5 MATCH syntax: whitespace-separated
/// tokens become quoted prefix phrases ANDed together (`wind river` →
/// `"wind"* "river"*`). Quotation marks are stripped so user input can
/// never inject or break MATCH syntax; a query with no remaining tokens
/// yields `None`.
pub fn build_fts_query(user_query: &str) -> Option<String> {
    let terms: Vec<String> = user_query
        .split_whitespace()
        .map(|token| token.chars().filter(|c| *c != '"').collect::<String>())
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{token}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// Search the library using the FTS5 index over title, subtitle, author,
/// publisher, ISBN, description, and file path. The query is plain user
/// text; it is sanitized into MATCH syntax before hitting the index.
pub async fn search_books(pool: &SqlitePool, query: &str) -> Result<Vec<SearchHit>, AppError> {
    let match_query = build_fts_query(query)
        .ok_or_else(|| AppError::InvalidInput("search query is empty".into()))?;
    books::search_fts(pool, &match_query).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::domain::NewBook;

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
                authors: vec!["Kenneth Grahame".into()],
                subjects: Vec::new(),
                publisher: Some("Riverbank Press".into()),
                language: Some("en".into()),
                isbn: Some("978-0-14-036122-2".into()),
                description: Some("Mole and Rat adventure on the river.".into()),
                cover_path: None,
                publication_date: None,
                series: None,
                series_index: None,
                file_size: 0,
                file_mtime: 0,
            },
        )
        .await
        .unwrap();
        (tmp, pool)
    }

    #[test]
    fn fts_query_quotes_each_token_as_a_prefix_phrase() {
        assert_eq!(
            build_fts_query("wind river").as_deref(),
            Some("\"wind\"* \"river\"*")
        );
    }

    #[test]
    fn fts_query_strips_quotes_and_ignores_empty_tokens() {
        assert_eq!(build_fts_query("wi\"nd").as_deref(), Some("\"wind\"*"));
        assert_eq!(build_fts_query("\"  \"").as_deref(), None);
    }

    #[test]
    fn fts_query_none_for_blank_input() {
        assert_eq!(build_fts_query(""), None);
        assert_eq!(build_fts_query("   "), None);
    }

    #[tokio::test]
    async fn finds_books_by_title() {
        let (_tmp, pool) = pool_with_one_book().await;
        let hits = search_books(&pool, "willows").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "The Wind in the Willows");
        assert_eq!(hits[0].author.as_deref(), Some("Kenneth Grahame"));
    }

    #[tokio::test]
    async fn finds_books_by_description() {
        let (_tmp, pool) = pool_with_one_book().await;
        // "adventure" only occurs in the description (publisher is
        // "Riverbank Press", so "river" would match there too).
        let hits = search_books(&pool, "adventure").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("adventure"));
    }

    #[tokio::test]
    async fn finds_books_by_publisher() {
        let (_tmp, pool) = pool_with_one_book().await;
        let hits = search_books(&pool, "riverbank").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "The Wind in the Willows");
    }

    #[tokio::test]
    async fn finds_books_by_isbn_and_by_file_name() {
        let (_tmp, pool) = pool_with_one_book().await;
        assert_eq!(
            search_books(&pool, "978-0-14-036122-2")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(search_books(&pool, "willows.epub").await.unwrap().len(), 1);
        assert_eq!(search_books(&pool, "willows.e").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn multi_term_query_requires_every_term() {
        let (_tmp, pool) = pool_with_one_book().await;
        assert_eq!(search_books(&pool, "wind river").await.unwrap().len(), 1);
        assert!(search_books(&pool, "wind potato").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn prefix_matches_partial_words() {
        let (_tmp, pool) = pool_with_one_book().await;
        assert_eq!(search_books(&pool, "gra").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn match_syntax_is_never_injected_through_user_input() {
        let (_tmp, pool) = pool_with_one_book().await;
        // Raw FTS5 boolean syntax would error or change semantics; the
        // sanitizer quotes it away instead.
        assert!(search_books(&pool, "\" OR 1").await.is_ok());
        assert!(search_books(&pool, "NOT").await.is_ok());
        assert!(search_books(&pool, "wi*nd").await.is_ok());
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
        .unwrap();

        // "wind" only occurs in the old title — "willows" would still match
        // the indexed path /tmp/willows.epub.
        let old = search_books(&pool, "wind").await.unwrap();
        assert!(old.is_empty(), "old title must no longer match");
        let new = search_books(&pool, "different").await.unwrap();
        assert_eq!(new.len(), 1);
        drop(tmp);
    }
}
