//! Artwork cache maintenance (ROADMAP milestone 4).
//!
//! Cover images live in a content-addressed cache directory next to the
//! database: identical cover bytes always map to the same file, so books
//! that move, get re-imported, or simply share artwork never duplicate
//! files. The flip side of content addressing is that source changes,
//! removals, and moves leave files behind that no book row references
//! anymore. A sweep deletes exactly those — the cache can grow only while
//! covers are actually referenced.

use std::collections::HashSet;
use std::path::Path;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repository::books;

/// Delete every file in `covers_dir` that no `books.cover_path` row
/// references. This is the invalidation step for a content-addressed cache:
/// when a source's cover changes, the old file simply stops being referenced
/// and is swept at startup (and after book removal). In-progress temp files
/// are unreferenced by construction and collected too. Returns the number of
/// files removed; a file that cannot be deleted is logged and left for the
/// next sweep.
pub async fn sweep_unreferenced_covers(
    pool: &SqlitePool,
    covers_dir: &Path,
) -> Result<u32, AppError> {
    let referenced: HashSet<String> = books::list_cover_paths(pool).await?.into_iter().collect();

    let mut removed = 0u32;
    for entry in std::fs::read_dir(covers_dir)?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let path_str = path.to_string_lossy().into_owned();
        if referenced.contains(&path_str) {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(err) => eprintln!("cover sweep: could not remove {}: {err}", path.display()),
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::domain::NewBook;
    use std::path::PathBuf;

    fn sample(path: &str, cover: Option<String>) -> NewBook {
        NewBook {
            path: path.into(),
            title: "T".into(),
            subtitle: None,
            author: None,
            authors: Vec::new(),
            subjects: Vec::new(),
            publisher: None,
            language: Some("en".into()),
            isbn: None,
            description: None,
            cover_path: cover,
            publication_date: None,
            series: None,
            series_index: None,
            file_size: 10,
            file_mtime: 1,
        }
    }

    async fn setup(dir: &Path) -> SqlitePool {
        std::fs::create_dir_all(dir).unwrap();
        init_pool(&dir.join("t.db")).await.unwrap()
    }

    fn make_covers_dir(dir: &Path) -> PathBuf {
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        covers
    }

    fn cover_files(covers_dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(covers_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn sweep_removes_only_unreferenced_files() {
        let tmp = tempfile::tempdir().unwrap();
        let covers = make_covers_dir(tmp.path());
        let pool = setup(tmp.path()).await;

        let kept = covers.join("kept.png");
        let orphan = covers.join("orphan.png");
        let temp = covers.join(".tmp-123-0");
        std::fs::write(&kept, b"a").unwrap();
        std::fs::write(&orphan, b"b").unwrap();
        std::fs::write(&temp, b"c").unwrap();

        books::insert_book(
            &pool,
            &sample("/a.epub", Some(kept.to_string_lossy().into_owned())),
        )
        .await
        .unwrap();

        let removed = sweep_unreferenced_covers(&pool, &covers).await.unwrap();

        assert_eq!(removed, 2);
        assert_eq!(cover_files(&covers), vec!["kept.png"]);
    }

    #[tokio::test]
    async fn sweep_keeps_covers_shared_by_two_books() {
        let tmp = tempfile::tempdir().unwrap();
        let covers = make_covers_dir(tmp.path());
        let pool = setup(tmp.path()).await;

        // Two rows legitimately share one content-addressed cover file.
        let shared = covers.join("shared.jpg");
        std::fs::write(&shared, b"a").unwrap();
        let shared_str = shared.to_string_lossy().into_owned();
        books::insert_book(&pool, &sample("/a.epub", Some(shared_str.clone())))
            .await
            .unwrap();
        books::insert_book(&pool, &sample("/b.epub", Some(shared_str.clone())))
            .await
            .unwrap();

        sweep_unreferenced_covers(&pool, &covers).await.unwrap();

        assert_eq!(cover_files(&covers), vec!["shared.jpg"]);
    }

    #[tokio::test]
    async fn sweep_on_missing_dir_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = setup(tmp.path()).await;
        let result = sweep_unreferenced_covers(&pool, &tmp.path().join("nope")).await;
        assert!(matches!(result, Err(AppError::Io(_))), "got: {result:?}");
    }
}
