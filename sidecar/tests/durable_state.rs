//! Command-surface journeys for durable reading state (ADR 0014, ticket
//! tuxbooks-ip6.2): read and annotate a book, then move, unwatch, remove, and
//! re-import it, with the state coming back through the same JSON-RPC methods
//! the renderer calls.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::Book;
use tuxbooks_lib::repository::{books, library_locations, migration};
use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
use tuxbooks_lib::services::library_reconciler::{PathChange, Reconciler};
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::{AppState, ImportRegistry};

fn fixture_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
}

struct Env {
    _tmp: TempDir,
    db_path: PathBuf,
    library: PathBuf,
    pool: SqlitePool,
    reconciler: Arc<Reconciler>,
    watcher: Arc<LibraryWatcher>,
    emitter: EventEmitter,
    importing: ImportRegistry,
}

async fn setup() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library).unwrap();
    let pool = init_pool(&db_path).await.unwrap();
    let reconciler = Arc::new(Reconciler::new(
        pool.clone(),
        tmp.path().join("covers"),
        vec![],
        tokio::runtime::Handle::current(),
        Box::new(|_change| {}),
    ));
    let watcher = Arc::new(
        LibraryWatcher::start(WatcherConfig {
            reconciler: Arc::clone(&reconciler),
            debounce: std::time::Duration::from_millis(50),
        })
        .unwrap(),
    );
    let emitter = EventEmitter::new(|_name: &'static str, _payload: Value| {});
    Env {
        _tmp: tmp,
        db_path,
        library,
        pool,
        reconciler,
        watcher,
        emitter,
        importing: ImportRegistry::default(),
    }
}

impl Env {
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

    fn write_book(&self, name: &str) -> PathBuf {
        let path = self.library.join(name);
        std::fs::copy(fixture_epub(), &path).unwrap();
        path
    }

    async fn rpc(&self, method: &str, params: Value) -> Value {
        let request = json!({
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

    /// Import through the same RPC method the folder picker uses, then stop
    /// OS events so a test can drive the move itself.
    async fn scan(&self) {
        self.rpc(
            "scan_library",
            json!({ "path": self.library.to_string_lossy() }),
        )
        .await;
        self.watcher
            .unwatch_all(std::slice::from_ref(&self.library));
    }

    async fn books(&self) -> Vec<Book> {
        books::list_books(&self.pool).await.unwrap()
    }

    async fn book(&self) -> Book {
        let mut listed = self.books().await;
        assert_eq!(listed.len(), 1, "one library entry expected: {listed:?}");
        listed.remove(0)
    }

    async fn save_progress(&self, book_id: i64, percent: f64, chapter: &str) {
        self.rpc(
            "save_reading_progress",
            json!({
                "bookId": book_id,
                "progress": {
                    "chapterHref": chapter,
                    "characterOffset": 120,
                    "progressPercent": percent,
                },
            }),
        )
        .await;
    }

    async fn annotate(&self, book_id: i64, cfi: &str) -> i64 {
        let result = self
            .rpc(
                "create_annotation",
                json!({
                    "bookId": book_id,
                    "annotation": {
                        "kind": "highlight",
                        "cfi": cfi,
                        "chapterHref": "chapter1.xhtml",
                        "text": "a passage",
                        "color": "yellow",
                    },
                }),
            )
            .await;
        result["id"].as_i64().expect("annotation id")
    }

    async fn progress_percent(&self, book_id: i64) -> Option<f64> {
        let value = self
            .rpc("get_reading_progress", json!({ "bookId": book_id }))
            .await;
        value.get("progressPercent").and_then(Value::as_f64)
    }

    async fn annotation_count(&self, book_id: i64) -> usize {
        self.rpc("list_annotations", json!({ "bookId": book_id }))
            .await
            .as_array()
            .map(Vec::len)
            .unwrap_or_default()
    }
}

/// A reader reads and annotates, the folder is unwatched, then watched again:
/// the same book and the same state come back.
#[tokio::test(flavor = "multi_thread")]
async fn unwatch_then_rewatch_restores_progress_and_annotations() {
    let env = setup().await;
    env.write_book("book.epub");
    env.scan().await;

    let book = env.book().await;
    env.save_progress(book.id, 42.5, "chapter1.xhtml").await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(
        env.rpc("unwatch_locations", json!({ "paths": [root.clone()] }))
            .await,
        json!(1)
    );
    assert!(env.books().await.is_empty(), "membership ends");
    // Reading data is still there, addressed by the durable book id.
    assert_eq!(env.progress_percent(book.id).await, Some(42.5));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert!(!env.pool.is_closed());

    // Re-watch the same folder: the file is imported again and attaches to
    // the existing book by content hash.
    env.scan().await;
    let again = env.book().await;
    assert_eq!(again.id, book.id, "same durable book");
    assert_eq!(again.book_uid, book.book_uid, "same bookUid");
    assert_eq!(env.progress_percent(again.id).await, Some(42.5));
    assert_eq!(env.annotation_count(again.id).await, 1);
}

/// Remove ends the membership only; importing the same bytes restores the
/// state.
#[tokio::test(flavor = "multi_thread")]
async fn remove_then_reimport_restores_progress_and_annotations() {
    let env = setup().await;
    let path = env.write_book("book.epub");
    env.scan().await;

    let book = env.book().await;
    env.save_progress(book.id, 63.0, "chapter2.xhtml").await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": book.id })).await,
        json!(true)
    );
    assert!(env.books().await.is_empty());
    assert_eq!(env.progress_percent(book.id).await, Some(63.0));
    assert_eq!(env.annotation_count(book.id).await, 1);

    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;

    let again = env.book().await;
    assert_eq!(again.id, book.id, "the bytes reattach to the same book");
    assert_eq!(again.book_uid, book.book_uid);
    assert_eq!(env.progress_percent(again.id).await, Some(63.0));
    assert_eq!(env.annotation_count(again.id).await, 1);
}

/// A rename inside a watched folder is the same book, not a second one.
#[tokio::test(flavor = "multi_thread")]
async fn moving_a_file_keeps_the_book_and_its_state() {
    let env = setup().await;
    let original = env.write_book("book.epub");
    env.scan().await;

    let book = env.book().await;
    env.save_progress(book.id, 31.0, "chapter1.xhtml").await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    let moved_dir = env.library.join("moved");
    std::fs::create_dir_all(&moved_dir).unwrap();
    let moved = moved_dir.join("renamed.epub");
    std::fs::rename(&original, &moved).unwrap();
    env.reconciler
        .apply(vec![PathChange::Renamed {
            from: original,
            to: moved.clone(),
        }])
        .await;

    let again = env.book().await;
    assert_eq!(again.id, book.id);
    assert_eq!(again.book_uid, book.book_uid);
    assert_eq!(again.path, moved.to_string_lossy());
    assert_eq!(env.progress_percent(again.id).await, Some(31.0));
    assert_eq!(env.annotation_count(again.id).await, 1);
}

/// Remove waits for a pending hash, so the alias exists and a later import
/// finds the same book instead of starting a new identity.
#[tokio::test(flavor = "multi_thread")]
async fn remove_waits_for_a_pending_hash_before_dropping_the_file() {
    let env = setup().await;
    let path = env.write_book("book.epub");
    env.scan().await;
    let book = env.book().await;
    env.save_progress(book.id, 20.0, "chapter1.xhtml").await;

    // Pretend the background pass has not reached this row yet.
    sqlx::query("UPDATE books SET hash_state = 'pending' WHERE book_uid = ?1")
        .bind(book.book_uid.clone().unwrap())
        .execute(&env.pool)
        .await
        .unwrap();

    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": book.id })).await,
        json!(true)
    );

    // The destructive path settled the hash first: the alias points at the
    // durable book, so identical bytes reattach.
    let alias: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE book_uid = ?1 LIMIT 1")
            .bind(book.book_uid.clone().unwrap())
            .fetch_one(&env.pool)
            .await
            .expect("a hash alias exists after remove");
    assert_eq!(alias, book.book_uid.unwrap());

    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let again = env.book().await;
    assert_eq!(again.id, book.id);
    assert_eq!(env.progress_percent(again.id).await, Some(20.0));
}

/// An unreadable file cannot produce a hash. Remove proceeds, records a
/// visible relink issue, and keeps the durable state.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_hash_marks_a_relink_and_does_not_block_removal() {
    let env = setup().await;
    env.write_book("book.epub");
    env.scan().await;
    let book = env.book().await;
    env.save_progress(book.id, 12.0, "chapter1.xhtml").await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    // Simulate a file that disappeared before its first hash.
    sqlx::query("UPDATE books SET hash_state = 'pending', available = 0 WHERE book_uid = ?1")
        .bind(book.book_uid.clone().unwrap())
        .execute(&env.pool)
        .await
        .unwrap();

    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": book.id })).await,
        json!(true),
        "an unknown hash must not trap the removal"
    );
    assert!(env.books().await.is_empty());
    assert_eq!(env.progress_percent(book.id).await, Some(12.0));
    assert_eq!(env.annotation_count(book.id).await, 1);

    let issues = migration::list_open(&env.pool).await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "hash_failed"
            && issue.book_uid.as_deref() == book.book_uid.as_deref()),
        "the failed hash is visible as needing a relink: {issues:?}"
    );
    assert!(
        library_locations::list_locations(&env.pool)
            .await
            .unwrap()
            .iter()
            .any(|path| Path::new(path) == env.library),
        "remove leaves the watch list alone"
    );
}
