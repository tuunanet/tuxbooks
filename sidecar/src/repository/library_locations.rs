use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::error::AppError;

/// Index watched location paths for the ancestry walk. The value is an opaque
/// row index the caller chooses (registration order for storage stats).
pub fn location_index(paths: &[String]) -> HashMap<&str, usize> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.as_str(), index))
        .collect()
}

/// The watched location that owns `book_path`: the deepest watched directory
/// that is the path itself or one of its ancestors. A sibling directory with
/// a shared string prefix does not match, since the split is always on a path
/// separator. This is the one membership definition for the library.
pub fn owning_location(book_path: &str, locations: &HashMap<&str, usize>) -> Option<usize> {
    let mut candidate = book_path;
    loop {
        if let Some(&index) = locations.get(candidate) {
            return Some(index);
        }
        match candidate.rsplit_once('/') {
            Some((parent, _)) if !parent.is_empty() => candidate = parent,
            _ => return None,
        }
    }
}

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

    #[test]
    fn owning_location_matches_the_deepest_ancestor_and_never_a_sibling() {
        let paths = vec!["/lib".to_string(), "/lib/sub".to_string()];
        let index = location_index(&paths);

        // Exact match and a child both resolve; the deepest wins.
        assert_eq!(owning_location("/lib", &index), Some(0));
        assert_eq!(owning_location("/lib/a.epub", &index), Some(0));
        assert_eq!(owning_location("/lib/sub/b.epub", &index), Some(1));

        // A shared string prefix is not an ancestor: the split is on a
        // separator, so `/libx` and `/lib_sub` stay outside.
        assert_eq!(owning_location("/libx/c.epub", &index), None);
        assert_eq!(owning_location("/lib_sub/d.epub", &index), None);

        // A path outside every watched location is loose.
        assert_eq!(owning_location("/loose.epub", &index), None);
    }
}
