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

/// True when `book_path` is `root` or lies under it. The split is on a path
/// separator, so a sibling directory with a shared string prefix (`/libx`
/// against `/lib`) is never under the root. This is the separator rule
/// [`owning_location`] walks, spelled as a predicate.
pub fn is_under(path: &str, root: &str) -> bool {
    path == root
        || (path.len() > root.len()
            && path.starts_with(root)
            && path.as_bytes().get(root.len()) == Some(&b'/'))
}

/// Registered folders strictly under `root`, in registration order. The root
/// itself is not a descendant of itself, and an unrelated folder never is.
pub async fn descendants(pool: &SqlitePool, root: &str) -> Result<Vec<String>, AppError> {
    let paths = list_locations(pool).await?;
    Ok(paths
        .into_iter()
        .filter(|path| is_under(path, root) && path != root)
        .collect())
}

/// Drop a watched filesystem root from the watch list. Returns true when a
/// row went away; unwatching something that was never listed changes nothing.
pub async fn remove_location(pool: &SqlitePool, path: &str) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM library_locations WHERE path = ?1")
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

    #[test]
    fn is_under_splits_on_separators_only() {
        assert!(is_under("/lib", "/lib"));
        assert!(is_under("/lib/a.epub", "/lib"));
        assert!(is_under("/lib/sub/deep.epub", "/lib"));

        // The sibling-prefix guard, same rule as `owning_location`: a shared
        // string prefix is not an ancestor.
        assert!(!is_under("/libx/c.epub", "/lib"));
        assert!(!is_under("/lib_sub/d.epub", "/lib"));
        assert!(!is_under("/other.epub", "/lib"));
    }

    #[tokio::test]
    async fn descendants_lists_registered_folders_strictly_under_a_root() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        add_location(&pool, "/lib").await.unwrap();
        add_location(&pool, "/lib/a").await.unwrap();
        add_location(&pool, "/other").await.unwrap();
        add_location(&pool, "/lib/a/deep").await.unwrap();

        // Strictly under: the root itself and unrelated folders stay out.
        assert_eq!(
            descendants(&pool, "/lib").await.unwrap(),
            vec!["/lib/a".to_string(), "/lib/a/deep".to_string()]
        );
        assert!(descendants(&pool, "/lib/a/deep").await.unwrap().is_empty());
        assert!(descendants(&pool, "/never-listed")
            .await
            .unwrap()
            .is_empty());
    }

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

    #[tokio::test]
    async fn remove_location_drops_one_row_and_reports_whether_it_was_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        add_location(&pool, "/books").await.unwrap();
        add_location(&pool, "/more").await.unwrap();

        assert!(remove_location(&pool, "/books").await.unwrap());
        assert_eq!(list_locations(&pool).await.unwrap(), vec!["/more"]);

        // A second attempt and a path never listed both change nothing.
        assert!(!remove_location(&pool, "/books").await.unwrap());
        assert!(!remove_location(&pool, "/never-listed").await.unwrap());
        assert_eq!(list_locations(&pool).await.unwrap(), vec!["/more"]);
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

        // A path outside every watched location belongs to no location.
        assert_eq!(owning_location("/outside.epub", &index), None);
    }
}
