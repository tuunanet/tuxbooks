use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::domain::{CatalogCounts, LibraryLocationStat, StorageStats};
use crate::error::AppError;

/// The Data tab's storage read model: one row per watched library location
/// with its book count and total file bytes, the library's total book bytes,
/// and the catalog row counts. Locations keep registration order.
///
/// A book belongs to the most specific (longest matching) location whose
/// path prefixes it, where a path matches when it equals the location or
/// starts with the location plus a separator. The matching runs in Rust over
/// the book's ancestors, one lookup per path segment, so the cost does not
/// grow with the number of watched locations. A single correlated SQL join
/// was linear in locations times books and took seconds at a thousand
/// locations (see tests/storage_bench.rs).
pub async fn storage_stats(pool: &SqlitePool) -> Result<StorageStats, AppError> {
    let locations: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT id, path, added_at FROM library_locations ORDER BY id")
            .fetch_all(pool)
            .await?;

    // Watched path to its row index; the borrow ends before `locations` moves.
    let (counts, bytes, book_total_bytes) = {
        let mut location_index: HashMap<&str, usize> = HashMap::with_capacity(locations.len());
        for (index, (_, path, _)) in locations.iter().enumerate() {
            location_index.insert(path.as_str(), index);
        }

        let mut counts = vec![0_i64; locations.len()];
        let mut bytes = vec![0_i64; locations.len()];
        let mut total_bytes = 0_i64;
        let books: Vec<(String, i64)> = sqlx::query_as("SELECT path, file_size FROM books")
            .fetch_all(pool)
            .await?;
        for (path, file_size) in &books {
            total_bytes += file_size;
            if let Some(index) = owning_location(path, &location_index) {
                counts[index] += 1;
                bytes[index] += file_size;
            }
        }
        (counts, bytes, total_bytes)
    };

    let catalog = sqlx::query_as::<_, CatalogCounts>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM books) AS books,
            (SELECT COUNT(*) FROM authors) AS authors,
            (SELECT COUNT(*) FROM collections) AS collections,
            (SELECT COUNT(*) FROM annotations) AS annotations,
            (SELECT COUNT(*) FROM reading_progress) AS reading_progress
        "#,
    )
    .fetch_one(pool)
    .await?;

    let locations = locations
        .into_iter()
        .enumerate()
        .map(|(index, (id, path, added_at))| LibraryLocationStat {
            id,
            path,
            added_at,
            book_count: counts[index],
            total_bytes: bytes[index],
        })
        .collect();

    Ok(StorageStats {
        locations,
        book_total_bytes,
        catalog,
    })
}

/// The watched location that owns `book_path`: the deepest watched directory
/// that is the path itself or one of its ancestors. A sibling directory with
/// a shared string prefix does not match, since the split is always on a path
/// separator.
fn owning_location(book_path: &str, locations: &HashMap<&str, usize>) -> Option<usize> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::NewBook;
    use crate::repository::{books, library_locations};

    fn sample(path: &str, file_size: i64) -> NewBook {
        NewBook {
            path: path.into(),
            title: "T".into(),
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
            file_size,
            file_mtime: 1,
        }
    }

    async fn pool(dir: &std::path::Path) -> SqlitePool {
        crate::db::connection::init_pool(&dir.join("t.db"))
            .await
            .unwrap()
    }

    async fn seed_book(pool: &SqlitePool, path: &str, file_size: i64) {
        books::upsert_book(pool, &sample(path, file_size))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn empty_library_reports_no_locations_and_zero_totals() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool(tmp.path()).await;

        let stats = storage_stats(&pool).await.unwrap();
        assert!(stats.locations.is_empty());
        assert_eq!(stats.book_total_bytes, 0);
        assert_eq!(
            stats.catalog,
            CatalogCounts {
                books: 0,
                authors: 0,
                collections: 0,
                annotations: 0,
                reading_progress: 0,
            }
        );
    }

    #[tokio::test]
    async fn groups_books_by_location_prefix_in_registration_order() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool(tmp.path()).await;

        library_locations::add_location(&pool, "/lib")
            .await
            .unwrap();
        library_locations::add_location(&pool, "/other")
            .await
            .unwrap();
        seed_book(&pool, "/lib/a.epub", 100).await;
        seed_book(&pool, "/lib/b.epub", 200).await;
        seed_book(&pool, "/other/c.epub", 50).await;
        // A sibling directory must not match `/lib`, and a file imported
        // outside every watched location stays out of the per-location sums.
        seed_book(&pool, "/libx/d.epub", 999).await;
        seed_book(&pool, "/loose.epub", 7).await;

        let stats = storage_stats(&pool).await.unwrap();
        let seen: Vec<(&str, i64, i64)> = stats
            .locations
            .iter()
            .map(|l| (l.path.as_str(), l.book_count, l.total_bytes))
            .collect();
        assert_eq!(seen, vec![("/lib", 2, 300), ("/other", 1, 50)]);
        // Total book bytes cover the whole catalog, not only watched roots.
        assert_eq!(stats.book_total_bytes, 100 + 200 + 50 + 999 + 7);
        assert_eq!(stats.catalog.books, 5);
    }

    #[tokio::test]
    async fn nested_locations_attribute_a_book_to_the_most_specific_one() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool(tmp.path()).await;

        library_locations::add_location(&pool, "/lib")
            .await
            .unwrap();
        library_locations::add_location(&pool, "/lib/sub")
            .await
            .unwrap();
        seed_book(&pool, "/lib/a.epub", 100).await;
        seed_book(&pool, "/lib/sub/b.epub", 200).await;

        let stats = storage_stats(&pool).await.unwrap();
        let seen: Vec<(&str, i64, i64)> = stats
            .locations
            .iter()
            .map(|l| (l.path.as_str(), l.book_count, l.total_bytes))
            .collect();
        // The nested book counts only toward the longer matching location;
        // the parent keeps its own book and must not double count.
        assert_eq!(seen, vec![("/lib", 1, 100), ("/lib/sub", 1, 200)]);
        assert_eq!(stats.book_total_bytes, 300);
    }

    #[tokio::test]
    async fn location_without_books_reports_zero_count_and_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool(tmp.path()).await;

        library_locations::add_location(&pool, "/empty")
            .await
            .unwrap();

        let stats = storage_stats(&pool).await.unwrap();
        assert_eq!(stats.locations.len(), 1);
        assert_eq!(stats.locations[0].path, "/empty");
        assert_eq!(stats.locations[0].book_count, 0);
        assert_eq!(stats.locations[0].total_bytes, 0);
    }
}
