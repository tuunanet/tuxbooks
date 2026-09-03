use sqlx::SqlitePool;

use crate::error::AppError;

/// Register a filesystem root for watching and reconciliation. Re-registering
/// an existing location is a no-op. Returns true when the location is new.
pub async fn add_location(pool: &SqlitePool, path: &str) -> Result<bool, AppError> {
    let result = sqlx::query("INSERT OR IGNORE INTO library_locations (path) VALUES (?1)")
        .bind(path)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// All watched filesystem roots in registration order.
pub async fn list_locations(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM library_locations ORDER BY id")
        .fetch_all(pool)
        .await?;
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn add_location_is_idempotent_and_ordered() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        assert!(add_location(&pool, "/books").await.unwrap());
        assert!(!add_location(&pool, "/books").await.unwrap());
        assert!(add_location(&pool, "/more").await.unwrap());

        assert_eq!(
            list_locations(&pool).await.unwrap(),
            vec!["/books", "/more"]
        );
    }
}
