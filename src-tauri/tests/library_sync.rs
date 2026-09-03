//! Filesystem watcher + reconciliation integration tests (ROADMAP milestone
//! 3). Every scenario runs against a real `notify` watcher and a real SQLite
//! database in an isolated tempdir: creation, deletion, rename, move,
//! modification, duplicate events, and rapid event sequences.
//!
//! The tokio runtime must be multi-threaded: watcher threads drive database
//! work through `Handle::block_on`, which requires spawned sqlx tasks to
//! progress on worker threads while the test thread waits on the change
//! channel.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::{Book, ProgressUpdate};
use tuxbooks_lib::repository::{books as book_repo, library_locations, reading_progress};
use tuxbooks_lib::services::library_reconciler::{LibraryChange, Reconciler};
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};

const DEBOUNCE: Duration = Duration::from_millis(50);
const WAIT: Duration = Duration::from_secs(15);

struct TestEnv {
    _tmp: TempDir,
    library: PathBuf,
    pool: SqlitePool,
    reconciler: Arc<Reconciler>,
    _watcher: LibraryWatcher,
    changes: mpsc::Receiver<LibraryChange>,
}

fn write_epub(path: &Path, title: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let opf = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:{title}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest/>
  <spine/>
</package>"#
    );
    let container = r#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#;

    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    for (name, data) in [
        ("mimetype", "application/epub+zip".as_bytes()),
        ("META-INF/container.xml", container.as_bytes()),
        ("content.opf", opf.as_bytes()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
}

async fn setup() -> TestEnv {
    let tmp = tempfile::tempdir().unwrap();
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library).unwrap();
    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();

    let (change_tx, change_rx) = mpsc::channel();
    let reconciler = Arc::new(Reconciler::new(
        pool.clone(),
        tmp.path().join("covers"),
        vec![],
        tokio::runtime::Handle::current(),
        Box::new(move |change| {
            let _ = change_tx.send(change.clone());
        }),
    ));
    let watcher = LibraryWatcher::start(WatcherConfig {
        reconciler: reconciler.clone(),
        debounce: DEBOUNCE,
    })
    .unwrap();
    // Production registers every watched root in the database (scan_library
    // does it); the recovery sweep reconciles exactly those locations.
    library_locations::add_location(&pool, &library.to_string_lossy())
        .await
        .unwrap();
    watcher.watch(&library);

    TestEnv {
        _tmp: tmp,
        library,
        pool,
        reconciler,
        _watcher: watcher,
        changes: change_rx,
    }
}

impl TestEnv {
    fn path(&self, name: &str) -> PathBuf {
        self.library.join(name)
    }

    fn write_book(&self, name: &str, title: &str) -> PathBuf {
        let path = self.path(name);
        write_epub(&path, title);
        path
    }

    /// Wait for the next change matching `predicate`.
    fn wait_for(&self, predicate: impl Fn(&LibraryChange) -> bool) -> LibraryChange {
        let deadline = Instant::now() + WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for the expected library change"
            );
            match self.changes.recv_timeout(remaining) {
                Ok(change) if predicate(&change) => return change,
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for the expected library change")
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("reconciler dropped before the expected change arrived")
                }
            }
        }
    }

    async fn books(&self) -> Vec<Book> {
        book_repo::list_books(&self.pool).await.unwrap()
    }

    async fn count(&self) -> i64 {
        book_repo::count_books(&self.pool).await.unwrap()
    }
}

async fn add_progress(pool: &SqlitePool, book_id: i64, offset: i64) {
    reading_progress::upsert_progress(
        pool,
        book_id,
        &ProgressUpdate {
            chapter_href: Some("chapter1.xhtml".into()),
            cfi: None,
            character_offset: Some(offset),
            page_number: None,
            scroll_offset: None,
            progress_percent: Some(25.0),
        },
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn created_file_is_imported_with_file_snapshot() {
    let env = setup().await;

    env.write_book("created.epub", "Created Book");
    let change = env.wait_for(|change| match change {
        LibraryChange::Changed { book } => book.title == "Created Book",
        _ => false,
    });

    let LibraryChange::Changed { book } = change else {
        unreachable!()
    };
    assert!(book.available);
    assert_eq!(
        book.file_size,
        std::fs::metadata(book.path.as_str()).unwrap().len() as i64
    );
    assert!(book.file_mtime > 0);
    assert_eq!(env.count().await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn deleted_file_marks_book_unavailable_and_preserves_progress() {
    let env = setup().await;
    let path = env.write_book("vanishing.epub", "Vanishing Book");
    let book = match env.wait_for(
        |c| matches!(c, LibraryChange::Changed { book } if book.title == "Vanishing Book"),
    ) {
        LibraryChange::Changed { book } => book,
        _ => unreachable!(),
    };
    add_progress(&env.pool, book.id, 77).await;

    std::fs::remove_file(&path).unwrap();
    let change = env.wait_for(|c| match c {
        LibraryChange::Changed { book } => book.title == "Vanishing Book" && !book.available,
        _ => false,
    });
    let LibraryChange::Changed { book } = change else {
        unreachable!()
    };

    // The row survives with identity, metadata, and reading progress.
    let stored = book_repo::get_book(&env.pool, book.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!stored.available);
    assert_eq!(stored.title, "Vanishing Book");
    let progress = reading_progress::get_progress(&env.pool, book.id)
        .await
        .unwrap();
    assert!(
        progress.is_some(),
        "removal must not discard reading progress"
    );
    assert_eq!(env.count().await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn recreated_file_restores_the_same_book_identity() {
    let env = setup().await;
    let path = env.write_book("returning.epub", "Returning Book");
    let first = match env.wait_for(
        |c| matches!(c, LibraryChange::Changed { book } if book.title == "Returning Book"),
    ) {
        LibraryChange::Changed { book } => book,
        _ => unreachable!(),
    };
    add_progress(&env.pool, first.id, 11).await;

    std::fs::remove_file(&path).unwrap();
    env.wait_for(|c| match c {
        LibraryChange::Changed { book } => book.title == "Returning Book" && !book.available,
        _ => false,
    });

    write_epub(&path, "Returning Book");
    let restored = match env.wait_for(|c| match c {
        LibraryChange::Changed { book } => book.title == "Returning Book" && book.available,
        _ => false,
    }) {
        LibraryChange::Changed { book } => book,
        _ => unreachable!(),
    };
    assert_eq!(restored.id, first.id, "reappearance must reuse the row id");
    assert!(
        reading_progress::get_progress(&env.pool, first.id)
            .await
            .unwrap()
            .is_some(),
        "reappearance must not lose reading progress"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn renamed_file_relinks_the_book_in_place() {
    let env = setup().await;
    let old = env.write_book("old-name.epub", "Renamed Book");
    let book = match env
        .wait_for(|c| matches!(c, LibraryChange::Changed { book } if book.title == "Renamed Book"))
    {
        LibraryChange::Changed { book } => book,
        _ => unreachable!(),
    };
    add_progress(&env.pool, book.id, 33).await;

    let new = env.path("new-name.epub");
    std::fs::rename(&old, &new).unwrap();

    let change = env.wait_for(|c| match c {
        LibraryChange::Changed { book } => book.path.ends_with("new-name.epub"),
        _ => false,
    });
    let LibraryChange::Changed { book } = change else {
        unreachable!()
    };
    assert_eq!(book.id, book_id_stored(&env, "Renamed Book").await);
    assert!(book.available);

    let progress = reading_progress::get_progress(&env.pool, book.id)
        .await
        .unwrap();
    assert!(progress.is_some(), "rename must preserve reading progress");
    assert_eq!(env.count().await, 1);
}

/// Consume change events until every title in `titles` has been seen (in
/// any order). Returns everything that was drained in between.
fn wait_for_titles<const N: usize>(env: &TestEnv, titles: [&str; N]) -> Vec<LibraryChange> {
    let mut wanted: Vec<&str> = titles.into_iter().collect();
    let mut drained: Vec<LibraryChange> = Vec::new();
    while !wanted.is_empty() {
        let change = env.wait_for(|_| true);
        if let LibraryChange::Changed { book } = &change {
            if let Some(index) = wanted.iter().position(|title| *title == book.title) {
                wanted.remove(index);
                continue;
            }
        }
        drained.push(change);
    }
    drained
}

async fn book_id_stored(env: &TestEnv, title: &str) -> i64 {
    env.books()
        .await
        .into_iter()
        .find(|b| b.title == title)
        .unwrap()
        .id
}

#[tokio::test(flavor = "multi_thread")]
async fn moved_file_within_the_library_keeps_identity() {
    let env = setup().await;
    let old = env.write_book("nomad.epub", "Nomad Book");
    match env
        .wait_for(|c| matches!(c, LibraryChange::Changed { book } if book.title == "Nomad Book"))
    {
        LibraryChange::Changed { .. } => {}
        _ => unreachable!(),
    };

    let subdir = env.library.join("moved-here");
    std::fs::create_dir_all(&subdir).unwrap();
    let new = subdir.join("nomad.epub");
    std::fs::rename(&old, &new).unwrap();

    let change = env.wait_for(|c| match c {
        LibraryChange::Changed { book } => book.path.ends_with("moved-here/nomad.epub"),
        _ => false,
    });
    let LibraryChange::Changed { book } = change else {
        unreachable!()
    };
    assert_eq!(book.id, book_id_stored(&env, "Nomad Book").await);
    assert!(book.available);
}

#[tokio::test(flavor = "multi_thread")]
async fn modified_file_updates_metadata() {
    let env = setup().await;
    let path = env.write_book("mutable.epub", "Before Edit");
    match env
        .wait_for(|c| matches!(c, LibraryChange::Changed { book } if book.title == "Before Edit"))
    {
        LibraryChange::Changed { book } => book,
        _ => unreachable!(),
    };

    // Rewrite the same path with genuinely different content (different
    // size and mtime), as an external tool would.
    write_epub(&path, "After Edit");
    let change = env.wait_for(|c| match c {
        LibraryChange::Changed { book } => book.title == "After Edit",
        _ => false,
    });
    let LibraryChange::Changed { book } = change else {
        unreachable!()
    };
    assert_eq!(book.title, "After Edit");
    assert!(book.available);
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_and_rapid_events_reconcile_to_a_stable_state() {
    let env = setup().await;

    // Rapid sequence: many creates in quick succession — one debounce
    // window must import them all without duplicates.
    for i in 0..10 {
        env.write_book(&format!("rapid-{i}.epub"), &format!("Rapid {i}"));
    }
    let deadline = Instant::now() + WAIT;
    while env.count().await < 10 {
        assert!(
            Instant::now() < deadline,
            "rapid creates were not fully imported"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(env.count().await, 10);

    // Duplicate churn on one file: repeated writes must leave exactly one
    // consistent, available row (no duplicates, no availability churn).
    let path = env.path("rapid-0.epub");
    let before = book_repo::get_book_by_path(&env.pool, &path.to_string_lossy())
        .await
        .unwrap()
        .unwrap();
    for _ in 0..5 {
        write_epub(&path, "Rapid 0");
    }
    let deadline = Instant::now() + WAIT;
    loop {
        let after = book_repo::get_book_by_path(&env.pool, &path.to_string_lossy())
            .await
            .unwrap()
            .unwrap();
        if after.file_mtime >= before.file_mtime && after.available {
            assert_eq!(
                after.id, before.id,
                "duplicate events must not re-create rows"
            );
            assert_eq!(after.title, "Rapid 0");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "duplicate writes never reconciled"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(env.count().await, 10);
}

#[tokio::test(flavor = "multi_thread")]
async fn directory_rename_relinks_all_contained_books() {
    let env = setup().await;
    let dir = env.library.join("shelf");
    env.write_book("shelf/one.epub", "Shelf One");
    env.write_book("shelf/two.epub", "Shelf Two");
    // Batch order is not guaranteed, so collect until both books arrived.
    wait_for_titles(&env, ["Shelf One", "Shelf Two"]);
    let one_id = book_id_stored(&env, "Shelf One").await;
    let two_id = book_id_stored(&env, "Shelf Two").await;

    let renamed = env.library.join("renamed-shelf");
    std::fs::rename(&dir, &renamed).unwrap();

    for title in ["Shelf One", "Shelf Two"] {
        let change = env.wait_for(|c| match c {
            LibraryChange::Changed { book } => {
                book.title == title && book.path.contains("renamed-shelf")
            }
            _ => false,
        });
        let LibraryChange::Changed { book } = change else {
            unreachable!()
        };
        let expected = if title == "Shelf One" { one_id } else { two_id };
        assert_eq!(book.id, expected, "directory move must preserve book ids");
        assert!(book.available);
    }
    assert_eq!(env.count().await, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn non_book_files_never_produce_changes() {
    let env = setup().await;
    std::fs::write(env.path("notes.txt"), b"not a book").unwrap();
    std::fs::write(env.path("data.json"), b"{}").unwrap();

    let deadline = Instant::now() + Duration::from_millis(1000);
    while Instant::now() < deadline {
        match env.changes.recv_timeout(Duration::from_millis(200)) {
            Ok(change) => panic!("unexpected change for a non-book file: {change:?}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("reconciler died"),
        }
    }
    assert_eq!(env.count().await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn corrupt_file_is_skipped_and_imports_once_fixed() {
    let env = setup().await;
    let path = env.path("broken.epub");
    std::fs::write(&path, b"this is not a zip").unwrap();

    // Give the watcher time to see (and reject) the broken file.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(env.count().await, 0, "a corrupt file must not be imported");

    write_epub(&path, "Recovered Book");
    let change = env.wait_for(|c| match c {
        LibraryChange::Changed { book } => book.title == "Recovered Book",
        _ => false,
    });
    let LibraryChange::Changed { book } = change else {
        unreachable!()
    };
    assert!(book.available);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_reconciliation_diffs_the_location_incrementally() {
    let env = setup().await;

    // Two files land before reconciliation knows about them.
    env.write_book("a.epub", "Startup A");
    env.write_book("b.epub", "Startup B");
    let changes = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(changes, 2);
    assert_eq!(env.count().await, 2);

    // A file deleted while the app was "off" becomes unavailable; the
    // survivor is untouched (no re-import, no availability churn).
    std::fs::remove_file(env.path("a.epub")).unwrap();
    let changes = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(changes, 1);
    let survivor = book_repo::get_book_by_path(&env.pool, &env.path("b.epub").to_string_lossy())
        .await
        .unwrap()
        .unwrap();
    assert!(survivor.available);

    // A file added while the app was "off" is imported on the next pass.
    env.write_book("c.epub", "Startup C");
    let changes = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(changes, 1);
    assert_eq!(env.count().await, 3);

    // Reconciliation is idempotent: an unchanged library makes no changes.
    let changes = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(changes, 0);
}
