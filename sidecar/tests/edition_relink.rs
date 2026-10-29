//! Command-surface journeys for confirmed cross-edition relinks (ADR 0014 D9,
//! ticket tuxbooks-ip6.8): two durable books stay separate identities, only
//! the source percentage and provider links move, and annotations stay with
//! the source.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::Book;
use tuxbooks_lib::repository::{books, providers};
use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
use tuxbooks_lib::services::library_reconciler::Reconciler;
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::{AppState, ImportRegistry};

const PROVIDER: &str = "fake";

fn minimal_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
}

/// Different bytes from the minimal book, so it becomes a second durable
/// book instead of attaching to the first by content hash.
fn navigation_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/epub/core/epub3/navigation.epub")
}

struct Env {
    _tmp: TempDir,
    db_path: PathBuf,
    library: PathBuf,
    pool: SqlitePool,
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
            reconciler,
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

    fn write_book(&self, name: &str, source: &Path) -> PathBuf {
        let path = self.library.join(name);
        std::fs::copy(source, &path).unwrap();
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

    async fn rpc_error(&self, method: &str, params: Value) -> String {
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
                let message = response["error"]["message"]
                    .as_str()
                    .unwrap_or_else(|| panic!("{method} unexpectedly succeeded: {response}"));
                message.to_string()
            }
            RequestLineOutcome::Malformed(err) => panic!("request was rejected: {err}"),
        }
    }

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

    async fn history(&self) -> Vec<Value> {
        self.rpc("list_reading_history", json!({}))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    async fn save_progress(&self, book_id: i64, percent: f64) {
        self.rpc(
            "save_reading_progress",
            json!({
                "bookId": book_id,
                "progress": {
                    "chapterHref": "chapter1.xhtml",
                    "cfi": "epubcfi(/6/4!/4/2,/1:0,/1:20)",
                    "characterOffset": 120,
                    "pageNumber": 7,
                    "scrollOffset": 42.5,
                    "progressPercent": percent,
                    "locator": r#"{"href":"chapter1.xhtml"}"#,
                    "progression": 0.425,
                    "locations": r#"{"progression":0.425}"#,
                    "engine": "readium",
                    "schemaVersion": 2,
                },
            }),
        )
        .await;
    }

    async fn annotate(&self, book_id: i64, cfi: &str) {
        self.rpc(
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
    }

    async fn link_provider(&self, book_uid: &str, remote_id: &str) {
        self.rpc(
            "link_provider_book",
            json!({
                "bookUid": book_uid,
                "provider": PROVIDER,
                "remoteId": remote_id,
            }),
        )
        .await;
    }

    async fn set_provider_status(&self, book_uid: &str, status: &str) {
        self.rpc(
            "apply_provider_reading_update",
            json!({
                "bookUid": book_uid,
                "provider": PROVIDER,
                "status": status,
            }),
        )
        .await;
    }

    async fn provider_links(&self, book_uid: &str) -> Vec<Value> {
        self.rpc("list_provider_links", json!({ "bookUid": book_uid }))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    async fn progress(&self, book_id: i64) -> Option<Value> {
        let value = self
            .rpc("get_reading_progress", json!({ "bookId": book_id }))
            .await;
        if value.is_null() {
            None
        } else {
            Some(value)
        }
    }

    async fn annotation_count(&self, book_id: i64) -> usize {
        self.rpc("list_annotations", json!({ "bookId": book_id }))
            .await
            .as_array()
            .map(Vec::len)
            .unwrap_or_default()
    }
}

fn find_by_path(books: &[Book], path: &Path) -> Book {
    books
        .iter()
        .find(|book| book.path == path.to_string_lossy())
        .cloned()
        .unwrap_or_else(|| panic!("book at {} was imported", path.display()))
}

/// The full journey: the original edition is in Reading history, the current
/// edition is in the library. Confirming the link keeps two identities,
/// copies only the percentage, moves the provider link/status and its queued
/// page turn, and leaves annotations with the original.
#[tokio::test(flavor = "multi_thread")]
async fn confirmed_link_copies_percentage_moves_provider_and_keeps_annotations() {
    let env = setup().await;
    let source_path = env.write_book("original.epub", &minimal_epub());
    let target_path = env.write_book("current.epub", &navigation_epub());
    env.scan().await;

    let imported = env.books().await;
    let source = find_by_path(&imported, &source_path);
    let target = find_by_path(&imported, &target_path);
    let source_uid = source.book_uid.clone().expect("source durable uid");
    let target_uid = target.book_uid.clone().expect("target durable uid");

    env.link_provider(&source_uid, "remote-original").await;
    env.set_provider_status(&source_uid, "reading").await;
    env.save_progress(source.id, 42.5).await;
    // A target that was already opened must still land on the copied
    // percentage; the old target locator is replaced, not carried along.
    env.save_progress(target.id, 90.0).await;
    env.annotate(source.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)")
        .await;

    // The original edition leaves the library but keeps its state.
    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": source.id })).await,
        json!(true)
    );
    let history = env.history().await;
    assert_eq!(history.len(), 1, "the original is in Reading history");
    assert_eq!(history[0]["id"].as_i64(), Some(source.id));
    assert_eq!(history[0]["annotationCount"].as_i64(), Some(1));
    assert_eq!(history[0]["progressPercent"].as_f64(), Some(42.5));
    assert_eq!(
        history[0]["providerLinks"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(
        env.progress(target.id).await.expect("target was opened")["progressPercent"].as_f64(),
        Some(90.0)
    );

    let outcome = env
        .rpc(
            "link_book_edition",
            json!({ "sourceBookId": source.id, "targetBookId": target.id }),
        )
        .await;
    assert_eq!(outcome["sourceBookId"].as_i64(), Some(source.id));
    assert_eq!(outcome["targetBookId"].as_i64(), Some(target.id));
    assert_eq!(outcome["sourceBookUid"].as_str(), Some(source_uid.as_str()));
    assert_eq!(outcome["targetBookUid"].as_str(), Some(target_uid.as_str()));
    assert_eq!(outcome["copiedProgressPercent"].as_f64(), Some(42.5));
    assert_eq!(outcome["movedProviders"], json!([PROVIDER]));

    // Two durable identities still exist; the link is a relation, not a merge.
    let durable_books: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(durable_books, 2);
    let library = env.books().await;
    assert_eq!(library.len(), 1, "only the current edition is a membership");
    assert_eq!(library[0].id, target.id);
    assert_eq!(
        find_by_path(&library, &target_path).book_uid.as_deref(),
        Some(target_uid.as_str())
    );

    // Percentage only: every locator-shaped column on the target is empty.
    let target_progress = env.progress(target.id).await.expect("target progress");
    assert_eq!(target_progress["bookId"].as_i64(), Some(target.id));
    assert_eq!(target_progress["progressPercent"].as_f64(), Some(42.5));
    for field in [
        "chapterHref",
        "cfi",
        "characterOffset",
        "pageNumber",
        "scrollOffset",
        "locator",
        "progression",
        "locations",
        "engine",
        "schemaVersion",
    ] {
        assert!(
            target_progress[field].is_null(),
            "{field} must not cross editions: {target_progress}"
        );
    }

    // The source keeps its own progress and annotations untouched.
    let source_progress = env
        .progress(source.id)
        .await
        .expect("source progress stays");
    assert_eq!(
        source_progress["cfi"].as_str(),
        Some("epubcfi(/6/4!/4/2,/1:0,/1:20)")
    );
    assert_eq!(source_progress["engine"].as_str(), Some("readium"));
    assert_eq!(env.annotation_count(source.id).await, 1);
    assert_eq!(env.annotation_count(target.id).await, 0);

    // Provider link and cached status moved exactly once, with the queued
    // page turn following the link.
    assert!(
        env.provider_links(&source_uid).await.is_empty(),
        "the source must not keep a second link to the remote work"
    );
    let target_links = env.provider_links(&target_uid).await;
    assert_eq!(target_links.len(), 1, "{target_links:?}");
    assert_eq!(
        target_links[0]["remoteId"].as_str(),
        Some("remote-original")
    );
    assert_eq!(target_links[0]["status"].as_str(), Some("reading"));
    assert_eq!(
        providers::pending_progress(&env.pool, &target_uid, PROVIDER)
            .await
            .unwrap(),
        Some(42.5)
    );
    assert_eq!(
        providers::pending_progress(&env.pool, &source_uid, PROVIDER)
            .await
            .unwrap(),
        None
    );

    // Reading history still shows the original with its annotation count;
    // the provider link moved away from it.
    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["id"].as_i64(), Some(source.id));
    assert_eq!(history[0]["annotationCount"].as_i64(), Some(1));
    assert_eq!(history[0]["progressPercent"].as_f64(), Some(42.5));
    assert_eq!(history[0]["providerLinks"], json!([]));

    // The relation is visible from both sides, with the surface each edition
    // currently belongs to.
    let target_editions = env
        .rpc("list_book_editions", json!({ "bookId": target.id }))
        .await;
    assert_eq!(target_editions.as_array().map(Vec::len), Some(1));
    assert_eq!(target_editions[0]["id"].as_i64(), Some(source.id));
    assert_eq!(
        target_editions[0]["bookUid"].as_str(),
        Some(source_uid.as_str())
    );
    assert_eq!(target_editions[0]["inLibrary"].as_bool(), Some(false));
    let source_editions = env
        .rpc("list_book_editions", json!({ "bookId": source.id }))
        .await;
    assert_eq!(source_editions.as_array().map(Vec::len), Some(1));
    assert_eq!(source_editions[0]["id"].as_i64(), Some(target.id));
    assert_eq!(source_editions[0]["inLibrary"].as_bool(), Some(true));
}

/// The relation is symmetric and single: linking the same pair again, in
/// either argument order, is rejected without changing state.
#[tokio::test(flavor = "multi_thread")]
async fn duplicate_edition_link_is_rejected() {
    let env = setup().await;
    let first_path = env.write_book("first.epub", &minimal_epub());
    let second_path = env.write_book("second.epub", &navigation_epub());
    env.scan().await;
    let imported = env.books().await;
    let first = find_by_path(&imported, &first_path);
    let second = find_by_path(&imported, &second_path);

    env.rpc(
        "link_book_edition",
        json!({ "sourceBookId": first.id, "targetBookId": second.id }),
    )
    .await;

    let library = env.books().await;
    assert_eq!(
        library.len(),
        2,
        "both editions keep their library membership"
    );
    assert!(library.iter().any(|book| book.id == first.id));
    assert!(library.iter().any(|book| book.id == second.id));
    assert_ne!(
        first.book_uid, second.book_uid,
        "linking never merges durable identities"
    );

    let message = env
        .rpc_error(
            "link_book_edition",
            json!({ "sourceBookId": second.id, "targetBookId": first.id }),
        )
        .await;
    assert!(
        message.contains("already linked as editions"),
        "duplicate link is explicit: {message}"
    );

    let editions = env
        .rpc("list_book_editions", json!({ "bookId": first.id }))
        .await;
    assert_eq!(
        editions.as_array().map(Vec::len),
        Some(1),
        "one relation per pair"
    );
}

/// A target that already tracks the same provider is an explicit conflict.
/// Nothing is copied or moved, so the user can unlink deliberately and retry.
#[tokio::test(flavor = "multi_thread")]
async fn provider_conflict_rejects_the_whole_link() {
    let env = setup().await;
    let source_path = env.write_book("source.epub", &minimal_epub());
    let target_path = env.write_book("target.epub", &navigation_epub());
    env.scan().await;
    let imported = env.books().await;
    let source = find_by_path(&imported, &source_path);
    let target = find_by_path(&imported, &target_path);
    let source_uid = source.book_uid.clone().expect("source uid");
    let target_uid = target.book_uid.clone().expect("target uid");

    env.save_progress(source.id, 30.0).await;
    env.link_provider(&source_uid, "remote-source").await;
    env.link_provider(&target_uid, "remote-target").await;

    let message = env
        .rpc_error(
            "link_book_edition",
            json!({ "sourceBookId": source.id, "targetBookId": target.id }),
        )
        .await;
    assert!(
        message.contains(PROVIDER) && message.contains("already linked"),
        "provider conflict is explicit: {message}"
    );

    assert_eq!(
        env.rpc("list_book_editions", json!({ "bookId": target.id }))
            .await,
        json!([]),
        "a rejected link leaves no relation"
    );
    assert_eq!(
        env.progress(target.id).await,
        None,
        "a rejected link copies no percentage"
    );
    let source_links = env.provider_links(&source_uid).await;
    let target_links = env.provider_links(&target_uid).await;
    assert_eq!(source_links.len(), 1);
    assert_eq!(source_links[0]["remoteId"].as_str(), Some("remote-source"));
    assert_eq!(target_links.len(), 1);
    assert_eq!(target_links[0]["remoteId"].as_str(), Some("remote-target"));
}

/// Linking a book to itself is rejected before touching anything.
#[tokio::test(flavor = "multi_thread")]
async fn linking_a_book_to_itself_is_rejected() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = find_by_path(&env.books().await, &path);

    let message = env
        .rpc_error(
            "link_book_edition",
            json!({ "sourceBookId": book.id, "targetBookId": book.id }),
        )
        .await;
    assert!(message.contains("itself"), "got: {message}");
}
