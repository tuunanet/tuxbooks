use sqlx::SqlitePool;

use crate::domain::Collection;
use crate::domain::CollectionSummary;
use crate::error::AppError;

pub async fn count_collections(pool: &SqlitePool) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collections")
        .fetch_one(pool)
        .await?;
    Ok(count)
}

pub async fn create_collection(pool: &SqlitePool, name: &str) -> Result<i64, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("collection name is empty".into()));
    }
    let id: i64 = sqlx::query_scalar("INSERT INTO collections (name) VALUES (?1) RETURNING id")
        .bind(name)
        .fetch_one(pool)
        .await?;
    Ok(id)
}

pub async fn list_collections(pool: &SqlitePool) -> Result<Vec<Collection>, AppError> {
    let collections = sqlx::query_as::<_, Collection>(
        "SELECT id, name, created_at FROM collections ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(collections)
}

/// Every collection with its member book ids (milestone 10). Two plain
/// queries joined in Rust: collections keep name order, memberships come
/// back as one `(collection_id, book_id)` row each.
pub async fn list_collection_summaries(
    pool: &SqlitePool,
) -> Result<Vec<CollectionSummary>, AppError> {
    let collections = list_collections(pool).await?;
    let membership: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT collection_id, book_id FROM book_collections ORDER BY collection_id, book_id",
    )
    .fetch_all(pool)
    .await?;

    let mut summaries: Vec<CollectionSummary> = collections
        .into_iter()
        .map(|collection| CollectionSummary {
            id: collection.id,
            name: collection.name,
            created_at: collection.created_at,
            book_ids: Vec::new(),
        })
        .collect();
    for (collection_id, book_id) in membership {
        if let Some(summary) = summaries.iter_mut().find(|s| s.id == collection_id) {
            summary.book_ids.push(book_id);
        }
    }
    Ok(summaries)
}

/// One collection with its member book ids, or None for unknown ids.
pub async fn get_collection_summary(
    pool: &SqlitePool,
    id: i64,
) -> Result<Option<CollectionSummary>, AppError> {
    let summaries: Vec<CollectionSummary> = list_collection_summaries(pool).await?;
    Ok(summaries.into_iter().find(|summary| summary.id == id))
}

/// Delete a collection. Membership rows cascade (`book_collections` FK);
/// the books themselves are never touched. Returns false if no row matched.
pub async fn delete_collection(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM collections WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// The collections a book belongs to — the inverse lookup for context-menu
/// "Remove from Collection" entries.
pub async fn list_collection_ids_for_book(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Vec<i64>, AppError> {
    let ids: Vec<i64> =
        sqlx::query_scalar("SELECT collection_id FROM book_collections WHERE book_id = ?1")
            .bind(book_id)
            .fetch_all(pool)
            .await?;
    Ok(ids)
}

pub async fn add_book_to_collection(
    pool: &SqlitePool,
    book_id: i64,
    collection_id: i64,
) -> Result<(), AppError> {
    // Idempotent: the PK (book_id, collection_id) makes a repeated add a
    // no-op instead of a UNIQUE-constraint error.
    sqlx::query("INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?1, ?2)")
        .bind(book_id)
        .bind(collection_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn remove_book_from_collection(
    pool: &SqlitePool,
    book_id: i64,
    collection_id: i64,
) -> Result<bool, AppError> {
    let result =
        sqlx::query("DELETE FROM book_collections WHERE book_id = ?1 AND collection_id = ?2")
            .bind(book_id)
            .bind(collection_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_and_count() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        assert_eq!(count_collections(&pool).await.unwrap(), 0);
        create_collection(&pool, "Favorites").await.unwrap();
        create_collection(&pool, "To Read").await.unwrap();
        assert_eq!(count_collections(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn empty_name_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let err = create_collection(&pool, "  ").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn duplicate_names_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        create_collection(&pool, "Favorites").await.unwrap();
        let err = create_collection(&pool, "Favorites").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
    }

    #[tokio::test]
    async fn membership_is_many_to_many_and_deletes_cascade() {
        use crate::repository::books;
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        let book_id = books::upsert_book(
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
        let c1 = create_collection(&pool, "One").await.unwrap();
        let c2 = create_collection(&pool, "Two").await.unwrap();

        add_book_to_collection(&pool, book_id, c1).await.unwrap();
        add_book_to_collection(&pool, book_id, c2).await.unwrap();
        assert!(remove_book_from_collection(&pool, book_id, c1)
            .await
            .unwrap());

        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_collections WHERE book_id = ?1")
                .bind(book_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remaining, 1);
    }

    async fn pool_with_book(name: &str) -> (tempfile::TempDir, SqlitePool, i64) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let id = insert_book_named(&pool, name).await;
        (tmp, pool, id)
    }

    async fn insert_book_named(pool: &SqlitePool, name: &str) -> i64 {
        crate::repository::books::upsert_book(
            pool,
            &crate::domain::NewBook {
                path: format!("/{name}.epub"),
                title: name.into(),
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
        .0
    }

    #[tokio::test]
    async fn summaries_carry_member_book_ids() {
        let (_tmp, pool, book_id) = pool_with_book("A").await;
        let other_id = insert_book_named(&pool, "B").await;
        let c = create_collection(&pool, "Shelf").await.unwrap();

        add_book_to_collection(&pool, book_id, c).await.unwrap();
        // A repeated add is a no-op, not a UNIQUE-constraint error.
        add_book_to_collection(&pool, book_id, c).await.unwrap();
        add_book_to_collection(&pool, other_id, c).await.unwrap();

        let summaries = list_collection_summaries(&pool).await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, c);
        assert_eq!(summaries[0].name, "Shelf");
        assert_eq!(summaries[0].book_ids, vec![book_id, other_id]);

        let single = get_collection_summary(&pool, c).await.unwrap().unwrap();
        assert_eq!(single.book_ids.len(), 2);
        assert!(get_collection_summary(&pool, 999).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_collection_removes_grouping_but_not_books() {
        let (_tmp, pool, book_id) = pool_with_book("A").await;
        let c = create_collection(&pool, "Shelf").await.unwrap();
        add_book_to_collection(&pool, book_id, c).await.unwrap();

        assert!(delete_collection(&pool, c).await.unwrap());
        assert!(!delete_collection(&pool, c).await.unwrap());
        assert!(list_collection_summaries(&pool).await.unwrap().is_empty());
        // Membership rows cascade; the book row itself survives.
        let memberships: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_collections WHERE book_id = ?1")
                .bind(book_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(memberships, 0);
        assert!(crate::repository::books::get_book(&pool, book_id)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn list_collection_ids_for_book_roundtrips() {
        let (_tmp, pool, book_id) = pool_with_book("A").await;
        let (_c1, c2) = tokio::try_join!(
            create_collection(&pool, "One"),
            create_collection(&pool, "Two")
        )
        .unwrap();

        add_book_to_collection(&pool, book_id, c2).await.unwrap();
        let ids = list_collection_ids_for_book(&pool, book_id).await.unwrap();
        assert_eq!(ids, vec![c2]);
    }
}
