use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::error::AppError;

/// Open (creating if needed) the SQLite database at `db_path`, run all embedded
/// migrations, and return a connection pool. Deterministic: calling it twice on
/// the same path yields the same schema.
pub async fn init_pool(db_path: &Path) -> Result<SqlitePool, AppError> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;

    run_migrations(&pool).await?;
    Ok(pool)
}

async fn run_migrations(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::migrate!().run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn init_pool_is_deterministic_and_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("nested").join("tuxbooks.db");

        let pool = init_pool(&db_path).await.unwrap();
        assert!(db_path.exists());

        // Re-opening the same database must succeed (migrations are idempotent).
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn schema_contains_all_core_tables() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();

        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();

        for expected in [
            "books",
            "collections",
            "book_collections",
            "reading_progress",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }
}
