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
use tuxbooks_lib::services::library_reconciler::{LibraryChange, PathChange, Reconciler};
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::{AppState, ImportRegistry};

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
    importing: ImportRegistry,
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
        importing: ImportRegistry::default(),
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
            sync: None,
            importing: self.importing.clone(),
        })
    }

    /// Drive one method through the real JSON-RPC boundary and return its
    /// `result`. Panics on a JSON-RPC error so a failing call never reads as
    /// "nothing happened".
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let response = self.rpc_response(method, params).await;
        assert!(
            response.get("error").is_none(),
            "{method} failed: {response}"
        );
        response["result"].clone()
    }

    /// The raw response, error included. A refusal is the behavior under
    /// test for unwatch, so some calls must be allowed to fail.
    async fn rpc_response(&self, method: &str, params: Value) -> Value {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let state = self.state();
        match handle_request_line(&state, &self.emitter, &request.to_string()).await {
            RequestLineOutcome::Response(line) => serde_json::from_str(line.trim()).unwrap(),
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

    /// The refusal half of `unwatch`: the raw response of a call that is
    /// expected to be turned down.
    async fn unwatch_error(&self, paths: &[&str]) -> Value {
        self.rpc_response("unwatch_locations", serde_json::json!({ "paths": paths }))
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

    /// `(removed, total)` pairs from the progress events the dialog draws.
    fn unwatch_progress(&self) -> Vec<(u64, u64)> {
        self.fired
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| *name == "unwatch-progress")
            .map(|(_, payload)| {
                (
                    payload.get("removed").and_then(Value::as_u64).unwrap(),
                    payload.get("total").and_then(Value::as_u64).unwrap(),
                )
            })
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

fn plain_book(path: &Path, title: &str) -> NewBook {
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: title.into(),
        subtitle: None,
        author: None,
        authors: Vec::new(),
        subjects: Vec::new(),
        publisher: None,
        language: Some("en".into()),
        isbn: None,
        description: None,
        cover_path: None,
        publication_date: None,
        series: None,
        series_index: None,
        file_size: 10,
        file_mtime: 1,
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
/// Poll the catalog until a book with `title` is in it. For imports that
/// stream `import-progress` rather than `library-changed`, so there is no
/// event to wait on.
async fn wait_for_book_title(env: &TestEnv, title: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
        if titles.contains(&title.to_string()) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the catalog never gained {title}, has {titles:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

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
    std::fs::write(env.path("book.epub.bak"), b"pre-embed backup").unwrap();
    std::fs::write(env.path(".book.epub.tuxbooks-0.tmp"), b"in flight").unwrap();

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
    // The startup contract is files landing while the app is off: silence
    // the fs watcher so only the explicit reconcile runs. With the watcher
    // live its 50ms debounce races reconcile_location for the same files
    // and the report counts stop being deterministic (bd tuxbooks-6r2).
    env.watcher.unwatch(&env.library);

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
    assert_eq!(
        env.unwatch_progress().first(),
        Some(&(0, 1)),
        "the dialog hears the purge start at zero"
    );
    assert_eq!(
        env.unwatch_progress().last(),
        Some(&(1, 1)),
        "and finish on the promised count"
    );

    // ...and the file itself is untouched, byte for byte.
    assert_eq!(
        std::fs::read(&kept).unwrap(),
        before,
        "unwatching must never touch files on disk"
    );
}

/// Unwatch during a scan cancels the scan and then purges what it already
/// imported. Nothing may land after the purge, or the orphan state returns.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_folder_cancels_its_import_and_purges_what_landed() {
    let env = setup().await;
    let shelf = env.sibling("shelf");
    std::fs::create_dir_all(&shelf).unwrap();
    for index in 0..200 {
        write_epub(
            &shelf.join(format!("book-{index}.epub")),
            &format!("Shelf Book {index}"),
        );
    }
    let shelf_path = shelf.to_string_lossy().into_owned();

    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let emitter = EventEmitter::new(move |name, _| {
        if name == "import-progress" {
            let _ = progress_tx.send(());
        }
    });
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "import_paths",
        "params": { "paths": [shelf_path.clone()] },
    })
    .to_string();
    let state = env.state();
    let import = tokio::spawn(async move { handle_request_line(&state, &emitter, &request).await });
    progress_rx
        .recv()
        .await
        .expect("the import should report progress");

    let partial = env.count().await;
    assert!(
        partial > 0 && partial < 200,
        "unwatch must land mid-import, got {partial} rows"
    );
    assert_eq!(env.unwatch(&[shelf_path.as_str()]).await, 1);

    let outcome = import.await.expect("the import task must finish cleanly");
    let RequestLineOutcome::Response(line) = outcome else {
        panic!("the import response must not be malformed");
    };
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(
        response["result"]["cancelled"], true,
        "the import must report that it was cancelled: {response}"
    );

    assert_eq!(
        env.count().await,
        0,
        "the unwatch must purge the books the cancelled scan had imported"
    );
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![env.library.to_string_lossy().into_owned()],
        "the folder must leave the watch list"
    );
}

/// An unwatch blocks the folder under the same lock a scan uses to start,
/// so a scan that was already in flight cannot re-register the folder while
/// the purge runs.
#[tokio::test(flavor = "multi_thread")]
async fn an_import_cannot_start_while_its_folder_is_being_unwatched() {
    let env = setup().await;
    let shelf = env.sibling("shelf");
    std::fs::create_dir_all(&shelf).unwrap();
    write_epub(&shelf.join("book.epub"), "Shelf Book");
    let shelf_path = shelf.to_string_lossy().into_owned();

    let (_runs, blocked) = env.importing.block(&[shelf_path]);
    let report = env.import_paths(&[shelf.as_path()]).await;
    let failed = report["failed"].as_array().unwrap();
    assert_eq!(failed.len(), 1, "{report}");
    assert!(
        failed[0]["error"]
            .as_str()
            .unwrap()
            .contains("being unwatched"),
        "{report}"
    );
    assert_eq!(env.count().await, 0, "a blocked folder must import nothing");

    env.importing.clear_blocking(&blocked);
    let report = env.import_paths(&[shelf.as_path()]).await;
    assert_eq!(report["imported"], 1, "{report}");
}

/// A purge big enough to batch must show intermediate counts, not jump from
/// zero to done when the last row goes.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_reports_batched_progress_for_a_large_folder() {
    let env = setup().await;
    for index in 0..30 {
        let path = env.path(&format!("bulk-{index}.epub"));
        book_repo::insert_book(&env.pool, &plain_book(&path, &format!("Bulk {index}")))
            .await
            .unwrap();
    }

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);

    let progress = env.unwatch_progress();
    assert_eq!(progress.first(), Some(&(0, 30)));
    assert!(
        progress.len() > 2,
        "intermediate batches must reach the dialog: {progress:?}"
    );
    assert_eq!(progress.last(), Some(&(30, 30)));
    assert_eq!(env.count().await, 0);
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

/// What unwatch keeps: the file rows and their library membership go, while
/// reading progress and annotations stay with the durable book and the files
/// stay where they are (ADR 0014 D4).
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_keeps_progress_and_annotations_with_the_durable_book() {
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

    // The library membership is gone, not merely detached...
    assert_eq!(env.count().await, 0, "the book must leave the library");
    assert!(library_locations::list_locations(&env.pool)
        .await
        .unwrap()
        .is_empty());
    // ...but the durable book still owns its reading data...
    let progress = reading_progress::get_progress(&env.pool, book.id)
        .await
        .unwrap()
        .expect("progress survives the unwatch");
    assert_eq!(progress.character_offset, Some(42));
    assert_eq!(
        annotations::list_annotations(&env.pool, book.id)
            .await
            .unwrap()
            .len(),
        1,
        "annotations belong to the durable book and stay"
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

/// You cannot carve a hole in a watched folder from inside it (ADR 0010).
/// A child folder under a still-watched parent has no unwatch of its own to
/// offer: the parent's recursive watch covers the child's files, so the
/// books the unwatch purged would come straight back as parent-owned rows —
/// the ghost (bd tuxbooks-yof). The call is refused, naming the folder that
/// has to go instead, and the watch list is left exactly as it was.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_a_child_folder_is_refused_while_its_parent_stays_watched() {
    let env = setup().await;
    // Drive the import pipeline directly instead of through the fs watcher,
    // the way the predecessor test pinned the unwatch contract: the parent's
    // recursive watch covers the child too, so notify events queued before
    // the unwatch race the purge and re-import the child's books through the
    // parent's prefix (bd tuxbooks-crn). The refusal below is the new home of
    // that contract; the disk-silence test keeps the fs round-trip covered.
    env.watcher.unwatch(&env.library);
    let sub = env.library.join("shelf");
    let deep = sub.join("deep");
    std::fs::create_dir_all(&deep).unwrap();
    for folder in [&sub, &deep] {
        library_locations::add_location(&env.pool, &folder.to_string_lossy())
            .await
            .unwrap();
    }

    let root_file = env.write_book("root.epub", "Root Book");
    let shelf_file = sub.join("shelf-book.epub");
    write_epub(&shelf_file, "Shelf Book");
    env.reconciler
        .apply(vec![
            PathChange::Created(root_file.clone()),
            PathChange::Created(shelf_file.clone()),
        ])
        .await;
    wait_for_titles(&env, ["Root Book", "Shelf Book"]);

    let library = env.library.to_string_lossy().into_owned();
    let shelf = sub.to_string_lossy().into_owned();
    let deepest = deep.to_string_lossy().into_owned();
    let response = env.unwatch_error(&[deepest.as_str()]).await;

    // ...and it names the shallowest one as the folder to take, which is the
    // one that has to go for the books to stay gone. The folder directly
    // above would leave the hole in place, so it is never offered.
    let message = response["error"]["message"].as_str().unwrap();
    assert!(
        message.contains(&format!("unwatch {library} instead")),
        "the refusal must offer the shallowest watched folder, said: {message}"
    );

    // ...and nothing moved: every row stands, both books stand, files stand.
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![library, shelf, deepest]
    );
    let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
    assert_eq!(
        titles,
        vec!["Root Book".to_string(), "Shelf Book".to_string()]
    );
    assert!(shelf_file.exists() && root_file.exists());
}

/// The flat watch list (ADR 0010): a folder already inside a watched folder
/// gets no row of its own. The folder above watches the whole subtree
/// recursively, so a nested row would add nothing and could never be
/// unwatched on its own. The books still arrive, and the report says why
/// instead of naming a watch that was never started.
#[tokio::test(flavor = "multi_thread")]
async fn importing_a_folder_inside_a_watched_folder_registers_nothing() {
    let env = setup().await;
    let sub = env.library.join("shelf");
    std::fs::create_dir_all(&sub).unwrap();
    write_epub(&sub.join("shelf-book.epub"), "Shelf Book");

    let report = env.import_paths(&[sub.as_path()]).await;

    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![env.library.to_string_lossy().into_owned()],
        "a folder inside a watched folder must not gain a row"
    );
    assert_eq!(report["watched"], serde_json::json!([]));
    assert_eq!(
        report["covered"],
        serde_json::json!([sub.to_string_lossy().into_owned()]),
        "the report must say the folder is already covered"
    );
    wait_for_book_title(&env, "Shelf Book").await;
}

/// The other order gets the same treatment: a folder registered before the
/// folder above it loses its row the moment the parent is imported. No purge
/// runs, so the books stay, now owned by the folder that covers them.
#[tokio::test(flavor = "multi_thread")]
async fn importing_a_folder_collapses_the_folders_it_now_covers() {
    let env = setup().await;
    let outer = env.sibling("outer");
    let shelf = outer.join("shelf");
    std::fs::create_dir_all(&shelf).unwrap();
    library_locations::add_location(&env.pool, &shelf.to_string_lossy())
        .await
        .unwrap();
    env.watcher.watch(&shelf);
    write_epub(&shelf.join("shelf-book.epub"), "Shelf Book");
    wait_for_titles(&env, ["Shelf Book"]);

    let report = env.import_paths(&[outer.as_path()]).await;

    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![
            env.library.to_string_lossy().into_owned(),
            outer.to_string_lossy().into_owned()
        ],
        "the nested row must go the moment the folder above it is watched"
    );
    assert_eq!(
        report["watched"],
        serde_json::json!([outer.to_string_lossy().into_owned()])
    );
    let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
    assert!(
        titles.contains(&"Shelf Book".to_string()),
        "collapsing a row must never purge its books, got {titles:?}"
    );

    // The folder keeps syncing, under the watch of the folder above it.
    write_epub(&shelf.join("second.epub"), "Second Shelf Book");
    wait_for_titles(&env, ["Second Shelf Book"]);
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

/// The unwatch ghost, made deterministic: an event that was already queued
/// when the unwatch ran must not re-import the book the unwatch just
/// purged. Under load this race failed `titles == ["Root Book"]`
/// intermittently (bd tuxbooks-crn) — the event path never re-checked the
/// watch list, so the ghost came back. The fs watcher stays off here: the
/// test replays the reconciler's own input directly instead of racing
/// notify for it.
#[tokio::test(flavor = "multi_thread")]
async fn queued_events_for_an_unwatched_folder_never_resurrect_its_books() {
    let env = setup().await;
    env.watcher.unwatch(&env.library);

    // Positive control: a registered location imports through apply.
    write_epub(&env.path("live.epub"), "Live Book");
    env.reconciler
        .apply(vec![PathChange::Created(env.path("live.epub"))])
        .await;
    assert_eq!(env.count().await, 1, "registered locations keep importing");

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(env.unwatch(&[root.as_str()]).await, 1);
    assert_eq!(env.count().await, 0);

    // The ghost: an event queued before the unwatch, replayed after the
    // purge. The file is still on disk (unwatch never touches files) but
    // its location is gone from the watch list, so apply must drop it.
    write_epub(&env.path("ghost.epub"), "Ghost Book");
    env.reconciler
        .apply(vec![PathChange::Modified(env.path("ghost.epub"))])
        .await;

    assert_eq!(
        env.count().await,
        0,
        "a queued event must never resurrect a folder the user unwatched"
    );
    assert!(env.path("ghost.epub").exists());
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

/// Undo the collapse migration so it can be replayed against a watch list
/// that predates it.
async fn run_the_upgrade_collapse(pool: &SqlitePool) {
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 12")
        .execute(pool)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(pool).await.unwrap();
}

/// The upgrade flattens a watched folder nested inside another watched
/// folder (ADR 0010). The row goes and the books do not: they stay in the
/// catalog owned by the folder above, with reading progress and annotations
/// intact, because a collapse is not an unwatch.
#[tokio::test(flavor = "multi_thread")]
async fn upgrade_collapses_a_watched_folder_nested_inside_another() {
    let env = setup().await;

    // The shape older versions produced by importing a folder that already
    // sat under a watched one.
    let sub = env.library.join("shelf");
    std::fs::create_dir_all(&sub).unwrap();
    library_locations::add_location(&env.pool, &sub.to_string_lossy())
        .await
        .unwrap();
    env.watcher.watch(&sub);

    // A sibling whose path shares a string prefix with the watched folder.
    // It is not inside it, so the collapse must leave it alone.
    let prefix_mate = env.sibling("libraryx");
    std::fs::create_dir_all(&prefix_mate).unwrap();
    library_locations::add_location(&env.pool, &prefix_mate.to_string_lossy())
        .await
        .unwrap();

    let parent_file = env.write_book("parent-book.epub", "Parent Book");
    let sub_file = sub.join("sub-book.epub");
    write_epub(&sub_file, "Sub Book");
    env.reconciler
        .apply(vec![
            PathChange::Created(parent_file.clone()),
            PathChange::Created(sub_file.clone()),
        ])
        .await;
    wait_for_titles(&env, ["Parent Book", "Sub Book"]);

    // Metadata on the nested folder's book, so the test can prove the
    // collapse takes none of it along.
    let sub_id = book_repo::get_book_by_path(&env.pool, &sub_file.to_string_lossy())
        .await
        .unwrap()
        .expect("sub book")
        .id;
    add_progress(&env.pool, sub_id, 42).await;
    annotations::insert_annotation(
        &env.pool,
        sub_id,
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

    let bytes_before = std::fs::read(&sub_file).unwrap();
    run_the_upgrade_collapse(&env.pool).await;

    // Only the redundant row left the watch list: the prefix-sharing
    // sibling is not inside the watched folder.
    let mut locations = library_locations::list_locations(&env.pool).await.unwrap();
    locations.sort();
    let mut expected = vec![
        env.library.to_string_lossy().into_owned(),
        prefix_mate.to_string_lossy().into_owned(),
    ];
    expected.sort();
    assert_eq!(locations, expected);

    // Both books stay in the catalog with their metadata, owned now by the
    // folder above. Nothing was purged and no file moved.
    let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
    assert_eq!(
        titles,
        vec!["Parent Book".to_string(), "Sub Book".to_string()]
    );
    assert!(
        reading_progress::get_progress(&env.pool, sub_id)
            .await
            .unwrap()
            .is_some(),
        "a collapse must never take reading progress"
    );
    assert_eq!(
        annotations::list_annotations(&env.pool, sub_id)
            .await
            .unwrap()
            .len(),
        1,
        "a collapse must never take annotations"
    );
    assert_eq!(std::fs::read(&sub_file).unwrap(), bytes_before);

    // And the collapse holds: the parent's own watch covers the subfolder,
    // so a change there still reaches the catalog as the parent's book.
    write_epub(&sub_file, "Sub Book Edited");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let titles: Vec<String> = env.books().await.iter().map(|b| b.title.clone()).collect();
        if titles.contains(&"Sub Book Edited".to_string()) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the flattened folder stopped syncing"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The collapse is one-time work: replaying it deletes nothing more, so a
/// replayed journal or a repeat upgrade leaves the watch list as it was.
#[tokio::test(flavor = "multi_thread")]
async fn upgrade_collapse_is_idempotent() {
    let env = setup().await;
    let sub = env.library.join("shelf");
    std::fs::create_dir_all(&sub).unwrap();
    library_locations::add_location(&env.pool, &sub.to_string_lossy())
        .await
        .unwrap();

    run_the_upgrade_collapse(&env.pool).await;
    let first = library_locations::list_locations(&env.pool).await.unwrap();
    run_the_upgrade_collapse(&env.pool).await;

    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        first
    );
    assert_eq!(first, vec![env.library.to_string_lossy().into_owned()]);
}

/// The upgrade purge is the mirror promise applied once to an old catalog:
/// every book outside all watched folders loses its file rows and library
/// membership, watched-folder books stay, and not one file on disk moves.
/// Reading state stays with the durable record.
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

    // The purged books' durable state stays, including collection membership;
    // the surviving book's membership is untouched.
    let progress = reading_progress::get_progress(&env.pool, stray_id)
        .await
        .unwrap()
        .expect("purge keeps the durable reading progress");
    assert_eq!(progress.character_offset, Some(42));
    assert_eq!(
        annotations::list_annotations(&env.pool, stray_id)
            .await
            .unwrap()
            .len(),
        1,
        "purge keeps annotations"
    );
    assert_eq!(
        collections::list_collection_ids_for_book(&env.pool, stray_id)
            .await
            .unwrap(),
        vec![favorites],
        "purge keeps durable collection membership"
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

    assert!(
        env.fired
            .lock()
            .unwrap()
            .iter()
            .any(|(name, _)| *name == "watched-folders-changed"),
        "the settings view must hear that the folder was registered"
    );
}

/// Dropping several files from one folder scans that folder once. The broken
/// sibling is the observable: a second scan would report it a second time.
#[tokio::test(flavor = "multi_thread")]
async fn importing_several_files_from_one_folder_scans_it_once() {
    let env = setup().await;
    let shelf = env.sibling("shelf");
    std::fs::create_dir_all(&shelf).unwrap();
    write_epub(&shelf.join("first.epub"), "Shelf First");
    write_epub(&shelf.join("second.epub"), "Shelf Second");
    std::fs::write(shelf.join("broken.epub"), b"not an epub").unwrap();

    let report = env
        .import_paths(&[&shelf.join("first.epub"), &shelf.join("second.epub")])
        .await;

    assert_eq!(report["imported"].as_u64(), Some(2), "{report}");
    assert_eq!(report["updated"].as_u64(), Some(0), "{report}");
    assert_eq!(
        report["failed"].as_array().unwrap().len(),
        1,
        "one scan reports the broken sibling once: {report}"
    );
    assert_eq!(env.count().await, 2);
}

/// A quit during a folder import must not orphan the books it already
/// persisted. Registration happens before the scan, so an interrupted run
/// leaves a watched folder and startup catch-up finishes the import.
#[tokio::test(flavor = "multi_thread")]
async fn an_interrupted_folder_import_leaves_a_watched_folder_that_resumes_it() {
    let env = setup().await;
    let shelf = env.sibling("shelf");
    std::fs::create_dir_all(&shelf).unwrap();
    for index in 0..60 {
        write_epub(
            &shelf.join(format!("book-{index}.epub")),
            &format!("Shelf Book {index}"),
        );
    }

    // Drive the real JSON-RPC command in a task and abort it as soon as the
    // first progress batch lands, which is after at least one row committed.
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let emitter = EventEmitter::new(move |name, _| {
        if name == "import-progress" {
            let _ = progress_tx.send(());
        }
    });
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "import_paths",
        "params": { "paths": [shelf.to_string_lossy()] },
    })
    .to_string();
    let state = env.state();
    let import = tokio::spawn(async move { handle_request_line(&state, &emitter, &request).await });
    progress_rx
        .recv()
        .await
        .expect("the import should report progress");
    import.abort();
    let _ = import.await;

    let partial = env.count().await;
    assert!(
        partial > 0 && partial < 60,
        "the abort must land mid-import, got {partial} rows"
    );
    assert_eq!(
        library_locations::list_locations(&env.pool).await.unwrap(),
        vec![
            env.library.to_string_lossy().into_owned(),
            shelf.to_string_lossy().into_owned()
        ],
        "an interrupted import must leave its folder watched"
    );

    // The next launch reconciles watched locations. That is what resumes the
    // import the user never got to finish.
    env.reconciler.reconcile_location(&shelf).await.unwrap();
    assert_eq!(
        env.count().await,
        60,
        "startup catch-up must import the books the quit left behind"
    );
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
