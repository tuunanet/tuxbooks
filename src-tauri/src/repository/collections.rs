use sqlx::SqlitePool;

use crate::domain::Collection;
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

pub async fn add_book_to_collection(
    pool: &SqlitePool,
    book_id: i64,
    collection_id: i64,
) -> Result<(), AppError> {
    sqlx::query("INSERT INTO book_collections (book_id, collection_id) VALUES (?1, ?2)")
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
}
