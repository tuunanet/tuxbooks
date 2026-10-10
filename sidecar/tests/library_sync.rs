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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::{AnnotationKind, Book, NewAnnotation, NewBook, ProgressUpdate};
use tuxbooks_lib::repository::{
    annotations, books as book_repo, collections, library_locations, reading_progress,
};
use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
use tuxbooks_lib::services::library_reconciler::{LibraryChange, Reconciler};
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::AppState;

const DEBOUNCE: Duration = Duration::from_millis(50);
const WAIT: Duration = Duration::from_secs(15);

/// Everything one test captured from the emitter: `(event name, payload)`.
type FiredEvents = Vec<(&'static str, Value)>;

struct TestEnv {
    tmp: TempDir,
    db_path: PathBuf,
    library: PathBuf,
    pool: SqlitePool,
    reconciler: Arc<Reconciler>,
    watcher: Arc<LibraryWatcher>,
    emitter: EventEmitter,
    fired: Arc<Mutex<FiredEvents>>,
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
    let db_path = tmp.path().join("t.db");
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library).unwrap();
    let pool = init_pool(&db_path).await.unwrap();

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
    let watcher = Arc::new(
        LibraryWatcher::start(WatcherConfig {
            reconciler: reconciler.clone(),
            debounce: DEBOUNCE,
        })
        .unwrap(),
    );
    // Production registers every watched root in the database (scan_library
    // does it); the recovery sweep reconciles exactly those locations.
    library_locations::add_location(&pool, &library.to_string_lossy())
        .await
        .unwrap();
    watcher.watch(&library);

    // The emitter is the same handle request handlers use, so a test can
    // assert what the client would receive live.
    let fired: Arc<Mutex<FiredEvents>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&fired);
    let emitter = EventEmitter::new(move |name, payload| {
        sink.lock().unwrap().push((name, payload));
    });

    TestEnv {
        tmp,
        db_path,
        library,
        pool,
        reconciler,
        watcher,
        emitter,
        fired,
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

    /// The live service handle: the same `AppState` shape `init_state`
    /// builds, pointed at this test's database and watcher.
    fn state(&self) -> Arc<AppState> {
        Arc::new(AppState {
            db: self.pool.clone(),
            db_path: self.db_path.clone(),
            watcher: Arc::clone(&self.watcher),
            startup_recovery: None,
        })
    }

    /// Drive one method through the real JSON-RPC boundary and return its
    /// `result`. Panics on a JSON-RPC error so a failing call never reads as
    /// "nothing happened".
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let state = self.state();
        match handle_request_line(&state, &self.emitter, &request.to_string()).await {
            RequestLineOutcome::Response(line) => {
                let response: Value = serde_json::from_str(line.trim()).unwrap();
                assert!(
                    response.get("error").is_none(),
                    "{method} failed: {response}"
                );
                response["result"].clone()
            }
            RequestLineOutcome::Malformed(err) => panic!("request was rejected: {err}"),
        }
    }

    /// Drive `unwatch_locations` through the real JSON-RPC boundary and
    /// return its `result`. There is one path: the call carries paths and
    /// nothing else.
    async fn unwatch(&self, paths: &[&str]) -> Value {
        self.rpc("unwatch_locations", serde_json::json!({ "paths": paths }))
            .await
    }

    /// Drive `import_paths` through the real JSON-RPC boundary — the same
    /// call Import Files, drag-and-drop, and the folder picker issue.
    async fn import_paths(&self, paths: &[&Path]) -> Value {
        let paths: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        self.rpc("import_paths", serde_json::json!({ "paths": paths }))
            .await
    }

    /// Book ids the client was told to drop outright (`kind: removed`).
    fn removed_book_ids(&self) -> Vec<i64> {
        self.fired
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| *name == "library-changed")
            .filter_map(
                |(_, payload)| match payload.get("kind").and_then(Value::as_str) {
                    Some("removed") => payload.get("bookId").and_then(Value::as_i64),
                    _ => None,
                },
            )
            .collect()
    }

    /// A sibling directory outside `library`, used to keep a second watched
    /// root next to the first.
    fn sibling(&self, name: &str) -> PathBuf {
        self.tmp.path().join(name)
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
            ..Default::default()
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
    let report = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(report.changes, 2);
    assert_eq!(report.imported, 2);
    assert_eq!(report.failed, 0);
    assert_eq!(env.count().await, 2);

    // A file deleted while the app was "off" becomes unavailable; the
    // survivor is untouched (no re-import, no availability churn).
    std::fs::remove_file(env.path("a.epub")).unwrap();
    let report = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(report.changes, 1);
    assert_eq!(report.updated, 1);
    let survivor = book_repo::get_book_by_path(&env.pool, &env.path("b.epub").to_string_lossy())
        .await
        .unwrap()
        .unwrap();
    assert!(survivor.available);

    // A file added while the app was "off" is imported on the next pass.
    env.write_book("c.epub", "Startup C");
    let report = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(report.changes, 1);
    assert_eq!(report.imported, 1);
    assert_eq!(env.count().await, 3);

    // Reconciliation is idempotent: an unchanged library makes no changes.
    let report = env
        .reconciler
        .reconcile_location(&env.library)
        .await
        .unwrap();
    assert_eq!(report.changes, 0);
}

/// Unwatch is the mirror promise: the folder leaves the watch list, its
/// books leave the catalog through the delete cascade, and every file on
/// disk stays byte-for-byte what it was. The client hears about it without
/// a restart.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_folder_purges_the_catalog_and_leaves_files_byte_for_byte() {
    let env = setup().await;
    let kept = env.write_book("kept.epub", "Kept Book");
    wait_for_titles(&env, ["Kept Book"]);
    let before = std::fs::read(&kept).unwrap();
    let book_id = env.books().await[0].id;

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);

    // The watch list no longer carries the folder...
    assert!(library_locations::list_locations(&env.pool)
        .await
        .unwrap()
        .is_empty());

    // ...the catalog row is gone, not merely detached...
    let books = env.books().await;
    assert_eq!(books.len(), 0, "unwatching must purge the catalog rows");
    assert_eq!(
        env.removed_book_ids(),
        vec![book_id],
        "the library hears `removed`, so the row drops without a restart"
    );

    // ...and the file itself is untouched, byte for byte.
    assert_eq!(
        std::fs::read(&kept).unwrap(),
        before,
        "unwatching must never touch files on disk"
    );
}

/// A disk change inside the unwatched folder must not reach the catalog,
/// while a folder that is still watched keeps syncing — otherwise the
/// negative half of the test would pass with a dead watcher.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_folder_stops_its_disk_changes_from_reaching_the_catalog() {
    let env = setup().await;
    let other = env.sibling("other");
    std::fs::create_dir_all(&other).unwrap();
    library_locations::add_location(&env.pool, &other.to_string_lossy())
        .await
        .unwrap();
    env.watcher.watch(&other);

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);

    write_epub(&env.path("ignored.epub"), "Ignored Book");
    // Give a broken watcher time to deliver this before the live root speaks.
    tokio::time::sleep(Duration::from_millis(300)).await;
    write_epub(&other.join("live.epub"), "Live Book");
    wait_for_titles(&env, ["Live Book"]);

    assert_eq!(env.count().await, 1, "the unwatched folder must stay quiet");
    assert!(
        book_repo::get_book_by_path(&env.pool, &env.path("ignored.epub").to_string_lossy())
            .await
            .unwrap()
            .is_none()
    );
    assert!(env.path("ignored.epub").exists());
}

/// A subfolder listed as its own watched folder keeps syncing when its
/// parent leaves the watch list: notify's recursive unwatch takes the
/// child's watch down with it, so the survivor has to be registered again.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_parent_keeps_a_watched_subfolder_syncing() {
    let env = setup().await;
    let sub = env.library.join("shelf");
    std::fs::create_dir_all(&sub).unwrap();
    library_locations::add_location(&env.pool, &sub.to_string_lossy())
        .await
        .unwrap();
    env.watcher.watch(&sub);

    // Prove the subfolder syncs on its own first; this also drains the
    // pending "directory appeared" event so nothing is left in flight when
    // the parent goes away.
    write_epub(&sub.join("before.epub"), "Before Unwatch");
    wait_for_titles(&env, ["Before Unwatch"]);

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![sub.to_string_lossy().into_owned()],
        "the subfolder stays a watched folder of its own"
    );

    // The subfolder still syncs...
    write_epub(&sub.join("after.epub"), "After Unwatch");
    wait_for_titles(&env, ["After Unwatch"]);

    // ...and the parent's own directory does not.
    write_epub(&env.path("root-book.epub"), "Root Book");
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(env.count().await, 2, "only the still-watched root imported");
    assert!(env.path("root-book.epub").exists());
}

/// A folder that vanished from disk has no watch left to remove, but its row
/// must still be cleanable — dead entries are exactly what unwatch is for.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_folder_already_gone_from_disk_still_works() {
    let env = setup().await;
    let root = env.library.to_string_lossy().into_owned();

    std::fs::remove_dir_all(&env.library).unwrap();
    tokio::time::sleep(Duration::from_millis(700)).await;

    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);
    assert!(library_locations::list_locations(&env.pool)
        .await
        .unwrap()
        .is_empty());
}

/// What purge takes with it: the books leave through the same delete
/// cascade the library's own Remove uses, so reading progress and
/// annotations go with the row while every file stays where it was.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_cascades_progress_and_annotations_with_the_books() {
    let env = setup().await;
    let file = env.write_book("dropped.epub", "Dropped Book");
    wait_for_titles(&env, ["Dropped Book"]);
    let mut imported = env.books().await;
    let book = imported.remove(0);
    add_progress(&env.pool, book.id, 42).await;
    annotations::insert_annotation(
        &env.pool,
        book.id,
        &NewAnnotation {
            kind: AnnotationKind::Bookmark,
            cfi: Some("epubcfi(/6/4)".into()),
            chapter_href: None,
            page_number: None,
            page_fraction: None,
            text: None,
            color: None,
            geometry: None,
        },
    )
    .await
    .unwrap();
    assert!(reading_progress::get_progress(&env.pool, book.id)
        .await
        .unwrap()
        .is_some());

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);

    // The catalog rows are gone, not merely detached...
    assert_eq!(env.count().await, 0, "the book must leave the library");
    assert!(library_locations::list_locations(&env.pool)
        .await
        .unwrap()
        .is_empty());
    // ...the cascade took the reading progress and the annotations with it...
    assert!(
        reading_progress::get_progress(&env.pool, book.id)
            .await
            .unwrap()
            .is_none(),
        "removal must run the existing delete cascade"
    );
    assert!(
        annotations::list_annotations(&env.pool, book.id)
            .await
            .unwrap()
            .is_empty(),
        "annotations belong to the book row and must go with it"
    );
    // ...and the file itself is still there.
    assert!(
        file.exists(),
        "removing books from the catalog must never touch files on disk"
    );

    // The client hears `removed`, so the library drops the row without a
    // restart instead of showing a book that is gone.
    assert_eq!(env.removed_book_ids(), vec![book.id]);
}

/// The purge set is the books the unwatched folder owns, not "whatever sits
/// under the prefix": a child folder keeps owning its books until its row
/// goes, and a parent still watching the same tree does not make them the
/// parent's.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_child_folder_takes_its_books_while_the_parent_stays() {
    let env = setup().await;
    let sub = env.library.join("shelf");
    std::fs::create_dir_all(&sub).unwrap();
    library_locations::add_location(&env.pool, &sub.to_string_lossy())
        .await
        .unwrap();
    env.watcher.watch(&sub);

    let root_file = env.write_book("root.epub", "Root Book");
    let shelf_file = sub.join("shelf-book.epub");
    write_epub(&shelf_file, "Shelf Book");
    wait_for_titles(&env, ["Root Book", "Shelf Book"]);

    let shelf = sub.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[shelf.as_str()]).await, 1);

    // The child's book goes; the parent's book, which the child never
    // owned, stays.
    let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
    assert_eq!(titles, vec!["Root Book".to_string()]);
    assert_eq!(env.removed_book_ids().len(), 1);
    assert!(shelf_file.exists() && root_file.exists());
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![env.library.to_string_lossy().into_owned()]
    );
}

/// The mirror case: the parent's row goes, the subfolder's row survives, so
/// the subfolder's books survive with it even though they sit under the
/// prefix that was just removed.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_parent_leaves_a_surviving_subfolders_books_alone() {
    let env = setup().await;
    let sub = env.library.join("shelf");
    std::fs::create_dir_all(&sub).unwrap();
    library_locations::add_location(&env.pool, &sub.to_string_lossy())
        .await
        .unwrap();
    env.watcher.watch(&sub);

    let root_file = env.write_book("root.epub", "Root Book");
    let shelf_file = sub.join("shelf-book.epub");
    write_epub(&shelf_file, "Shelf Book");
    wait_for_titles(&env, ["Root Book", "Shelf Book"]);

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);

    let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
    assert_eq!(titles, vec!["Shelf Book".to_string()]);
    assert_eq!(env.removed_book_ids().len(), 1);
    assert!(shelf_file.exists() && root_file.exists());
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![sub.to_string_lossy().into_owned()]
    );

    // The subfolder is still a watched folder, so it still syncs (its own
    // watch, unchanged by the parent's purge).
    write_epub(&sub.join("second.epub"), "Second Shelf Book");
    wait_for_titles(&env, ["Second Shelf Book"]);
}

/// A catalog row an upgrade would find outside every watched folder, with the
/// file it points at already on disk.
fn stray_book(path: &Path, title: &str) -> NewBook {
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: title.into(),
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
        file_size: 10,
        file_mtime: 1_700_000_000,
    }
}

/// Apply the one-time outside-watched purge exactly as an upgrade does: the
/// purge's row leaves the migration journal (version 11 is
/// `0011_purge_outside_watched.sql`), so the embedded migrator runs that
/// migration again against the catalog as it now stands.
async fn run_the_upgrade_purge(pool: &SqlitePool) {
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 11")
        .execute(pool)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(pool).await.unwrap();
}

/// The upgrade purge is the mirror promise applied once to an old catalog:
/// every book outside all watched folders leaves through the delete cascade,
/// watched-folder books stay, and not one file on disk moves.
#[tokio::test(flavor = "multi_thread")]
async fn upgrade_purge_removes_books_outside_every_watched_folder() {
    let env = setup().await;

    // The watched folder keeps its book — a real reconciler import.
    let kept = env.write_book("kept.epub", "Kept Book");
    wait_for_titles(&env, ["Kept Book"]);
    let kept_id = env.books().await[0].id;

    // Two books an older version left outside the mirror: one in a folder
    // nothing watches, one whose path merely shares a string prefix with the
    // watched folder (`…/libraryx` next to `…/library`).
    let stray_file = env.sibling("outside").join("stray.epub");
    write_epub(&stray_file, "Stray Book");
    let stray_id = book_repo::insert_book(&env.pool, &stray_book(&stray_file, "Stray Book"))
        .await
        .unwrap();
    let sibling_file = env.tmp.path().join("libraryx").join("c.epub");
    write_epub(&sibling_file, "Prefix-mate Book");
    book_repo::insert_book(&env.pool, &stray_book(&sibling_file, "Prefix-mate Book"))
        .await
        .unwrap();

    // Purged metadata goes with the row: progress, an annotation, and a
    // collection shared with the surviving book.
    add_progress(&env.pool, stray_id, 42).await;
    annotations::insert_annotation(
        &env.pool,
        stray_id,
        &NewAnnotation {
            kind: AnnotationKind::Bookmark,
            cfi: Some("epubcfi(/6/4)".into()),
            chapter_href: None,
            page_number: None,
            page_fraction: None,
            text: None,
            color: None,
            geometry: None,
        },
    )
    .await
    .unwrap();
    let favorites = collections::create_collection(&env.pool, "Favorites")
        .await
        .unwrap();
    collections::add_book_to_collection(&env.pool, stray_id, favorites)
        .await
        .unwrap();
    collections::add_book_to_collection(&env.pool, kept_id, favorites)
        .await
        .unwrap();

    let before: Vec<(PathBuf, Vec<u8>)> = [kept.clone(), stray_file.clone(), sibling_file.clone()]
        .into_iter()
        .map(|path| (path.clone(), std::fs::read(&path).unwrap()))
        .collect();

    run_the_upgrade_purge(&env.pool).await;

    // Exactly the outside rows left the catalog; the watched book stayed.
    let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
    assert_eq!(titles, vec!["Kept Book".to_string()]);

    // The cascade took the purged books' metadata with them, while the
    // surviving book's collection membership is untouched.
    assert!(reading_progress::get_progress(&env.pool, stray_id)
        .await
        .unwrap()
        .is_none());
    assert!(annotations::list_annotations(&env.pool, stray_id)
        .await
        .unwrap()
        .is_empty());
    assert!(
        collections::list_collection_ids_for_book(&env.pool, stray_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        collections::list_collection_ids_for_book(&env.pool, kept_id)
            .await
            .unwrap(),
        vec![favorites]
    );

    // The watch list is not part of the purge: the mirror keeps its folders.
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![env.library.to_string_lossy().into_owned()]
    );

    // Every file is still on disk, byte for byte.
    for (path, bytes) in before {
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "the purge must never touch files on disk"
        );
    }
}

/// The purge is one-time work: applying it a second time deletes nothing
/// more, so a replayed journal or a repeat upgrade leaves the mirror
/// exactly as the first run shaped it.
#[tokio::test(flavor = "multi_thread")]
async fn upgrade_purge_is_idempotent() {
    let env = setup().await;
    let kept = env.write_book("kept.epub", "Kept Book");
    wait_for_titles(&env, ["Kept Book"]);
    let stray_file = env.sibling("outside").join("stray.epub");
    write_epub(&stray_file, "Stray Book");
    book_repo::insert_book(&env.pool, &stray_book(&stray_file, "Stray Book"))
        .await
        .unwrap();
    let before = std::fs::read(&kept).unwrap();

    run_the_upgrade_purge(&env.pool).await;
    run_the_upgrade_purge(&env.pool).await;

    let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
    assert_eq!(
        titles,
        vec!["Kept Book".to_string()],
        "a second purge run must delete nothing"
    );
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![env.library.to_string_lossy().into_owned()]
    );
    assert_eq!(std::fs::read(&kept).unwrap(), before);
    assert!(stray_file.exists());
}

/// The wire carries no loose flag. The retired mechanism leaves no field for
/// future code to build on, in a watched book or one outside the mirror.
#[tokio::test(flavor = "multi_thread")]
async fn list_books_payloads_carry_no_loose_field() {
    let env = setup().await;

    // A book the mirror owns, imported by the reconciler.
    env.write_book("watched.epub", "Watched Book");
    wait_for_titles(&env, ["Watched Book"]);

    // A row outside every watched folder — the case that used to arrive
    // flagged, since the purge only runs on upgrade.
    let stray_file = env.sibling("outside").join("stray.epub");
    write_epub(&stray_file, "Stray Book");
    book_repo::insert_book(&env.pool, &stray_book(&stray_file, "Stray Book"))
        .await
        .unwrap();

    let payload = env.rpc("list_books", serde_json::json!({})).await;
    let books = payload.as_array().expect("list_books returns an array");
    let titles: Vec<&str> = books
        .iter()
        .filter_map(|book| book.get("title").and_then(Value::as_str))
        .collect();
    assert_eq!(titles, vec!["Stray Book", "Watched Book"]);
    for book in books {
        assert!(
            book.get("loose").is_none(),
            "the loose flag must not appear on the wire: {book}"
        );
    }
}

/// A picked file adopts its folder (ADR 0009): the parent lands on the
/// watch list, the folder's other books arrive with the import, and a
/// sibling dropped on disk afterwards appears without a second import.
#[tokio::test(flavor = "multi_thread")]
async fn importing_a_single_file_watches_its_folder_and_syncs_siblings() {
    let env = setup().await;
    let shelf = env.sibling("shelf");
    std::fs::create_dir_all(&shelf).unwrap();
    write_epub(&shelf.join("first.epub"), "Shelf First");
    write_epub(&shelf.join("second.epub"), "Shelf Second");

    let report = env.import_paths(&[&shelf.join("first.epub")]).await;

    // The whole folder's book set arrived with the picked file...
    assert_eq!(
        report["imported"].as_u64(),
        Some(2),
        "the folder's books arrive with the file: {report}"
    );
    assert!(report["failed"].as_array().unwrap().is_empty(), "{report}");
    assert_eq!(env.count().await, 2);

    // ...the parent became a watched location...
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![
            env.library.to_string_lossy().into_owned(),
            shelf.to_string_lossy().into_owned()
        ]
    );

    // ...and the report disclosed the new watch instead of starting it
    // silently.
    assert_eq!(
        report["watched"],
        serde_json::json!([shelf.to_string_lossy()]),
        "the new watch must be disclosed on the report: {report}"
    );

    // A sibling dropped on disk afterwards appears without a second import.
    write_epub(&shelf.join("late.epub"), "Shelf Late");
    wait_for_titles(&env, ["Shelf Late"]);
    assert_eq!(env.count().await, 3);
}

/// Importing a file from a folder that is already watched neither
/// duplicates rows nor errors: the scan skips the unchanged files, the
/// registration is a no-op, and no second watch is disclosed.
#[tokio::test(flavor = "multi_thread")]
async fn importing_a_file_from_a_watched_folder_is_idempotent() {
    let env = setup().await;
    let path = env.write_book("resident.epub", "Resident Book");
    let first = match env
        .wait_for(|c| matches!(c, LibraryChange::Changed { book } if book.title == "Resident Book"))
    {
        LibraryChange::Changed { book } => book,
        _ => unreachable!(),
    };

    let report = env.import_paths(&[&path]).await;

    assert!(report["failed"].as_array().unwrap().is_empty(), "{report}");
    assert_eq!(
        env.count().await,
        1,
        "re-importing a watched file must not create a duplicate row"
    );
    let stored = book_repo::get_book_by_path(&env.pool, &path.to_string_lossy())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.id, first.id, "the existing row must keep its id");
    assert_eq!(
        report["watched"],
        serde_json::json!([]),
        "an already-watched parent is not a new watch: {report}"
    );
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![env.library.to_string_lossy().into_owned()],
        "the watch list must not grow a second row for the same folder"
    );
}

/// A file that is not a supported book fails as before and registers
/// nothing: a failed import turns no folder into a watched location.
#[tokio::test(flavor = "multi_thread")]
async fn importing_a_non_book_file_watches_nothing() {
    let env = setup().await;
    let shelf = env.sibling("stray");
    std::fs::create_dir_all(&shelf).unwrap();
    let notes = shelf.join("notes.txt");
    std::fs::write(&notes, b"not a book").unwrap();

    let report = env.import_paths(&[&notes]).await;

    assert_eq!(report["failed"].as_array().unwrap().len(), 1, "{report}");
    assert_eq!(report["watched"], serde_json::json!([]), "{report}");
    assert_eq!(env.count().await, 0);
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![env.library.to_string_lossy().into_owned()],
        "a failed import must not register its folder"
    );
}
