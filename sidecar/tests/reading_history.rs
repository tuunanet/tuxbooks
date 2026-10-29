//! Command-surface journeys for Reading history and relink (ADR 0014,
//! ticket tuxbooks-ip6.5): a book whose file rows are gone appears in the
//! separate view, an unavailable file row stays in the library, and relinking
//! a chosen file returns the book with its durable state.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::Book;
use tuxbooks_lib::repository::{books, metadata as metadata_repo};
use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
use tuxbooks_lib::services::library_reconciler::Reconciler;
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::services::metadata;
use tuxbooks_lib::{AppState, ImportRegistry};

fn minimal_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
}

/// A second EPUB with genuinely different bytes, so importing it does not
/// attach to the minimal book by content hash.
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

    /// Import through the folder-picker command, then stop OS events so the
    /// test controls what happens next.
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

    async fn history(&self, query: Option<&str>) -> Vec<Value> {
        let params = match query {
            Some(query) => json!({ "query": query }),
            None => json!({}),
        };
        self.rpc("list_reading_history", params)
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
                    "characterOffset": 120,
                    "progressPercent": percent,
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

    async fn create_collection(&self, name: &str) -> i64 {
        self.rpc("create_collection", json!({ "name": name })).await["id"]
            .as_i64()
            .expect("collection id")
    }

    async fn add_to_collection(&self, book_id: i64, collection_id: i64) {
        self.rpc(
            "add_book_to_collection",
            json!({ "bookId": book_id, "collectionId": collection_id }),
        )
        .await;
    }

    async fn collection_book_ids(&self, collection_id: i64) -> Vec<i64> {
        self.rpc("list_collections", json!({}))
            .await
            .as_array()
            .and_then(|collections| {
                collections
                    .iter()
                    .find(|collection| collection["id"].as_i64() == Some(collection_id))
            })
            .and_then(|collection| collection["bookIds"].as_array())
            .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default()
    }

    async fn set_title_override(&self, book_id: i64, title: &str) {
        let overrides = metadata_repo::OverrideRow {
            title: Some(title.into()),
            ..metadata_repo::OverrideRow::default()
        };
        metadata::apply_synced_overrides(&self.pool, book_id, &overrides, &[], &[])
            .await
            .unwrap();
    }
}

/// A book with no file row belongs to Reading history, and the library's
/// counts and storage totals stay membership-only.
#[tokio::test(flavor = "multi_thread")]
async fn removed_book_is_reading_history_not_library() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;

    let book = env.books().await.pop().expect("one imported book");
    env.save_progress(book.id, 42.5).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": book.id })).await,
        json!(true)
    );
    assert!(
        env.books().await.is_empty(),
        "the library is membership-only"
    );
    assert_eq!(
        env.rpc("get_library_stats", json!({})).await["bookCount"].as_i64(),
        Some(0)
    );

    let history = env.history(None).await;
    assert_eq!(
        history.len(),
        1,
        "the durable book stays visible: {history:?}"
    );
    assert_eq!(history[0]["id"].as_i64(), Some(book.id));
    assert_eq!(
        history[0]["bookUid"].as_str(),
        book.book_uid.as_deref(),
        "the row keeps the stable durable identity"
    );
    assert_eq!(history[0]["title"].as_str(), Some(book.title.as_str()));
    assert_eq!(history[0]["progressPercent"].as_f64(), Some(42.5));
    assert_eq!(history[0]["annotationCount"].as_i64(), Some(1));

    let storage = env.rpc("get_storage_stats", json!({})).await;
    assert_eq!(storage["bookTotalBytes"].as_i64(), Some(0));
    assert_eq!(storage["catalog"]["books"].as_i64(), Some(0));
    let locations = storage["locations"].as_array().cloned().unwrap_or_default();
    assert!(
        locations
            .iter()
            .all(|location| location["bookCount"] == json!(0)),
        "Reading history must not inflate a watched folder: {storage}"
    );
}

/// A missing file inside a watched folder keeps its row and stays in the
/// library as unavailable. It is not Reading history.
#[tokio::test(flavor = "multi_thread")]
async fn unavailable_file_row_stays_in_the_library() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = env.books().await.pop().expect("one imported book");

    sqlx::query("UPDATE books SET available = 0 WHERE book_uid = ?1")
        .bind(book.book_uid.clone().unwrap())
        .execute(&env.pool)
        .await
        .unwrap();

    let library = env.books().await;
    assert_eq!(
        library.len(),
        1,
        "the unavailable row is still a membership"
    );
    assert!(!library[0].available);
    assert!(
        env.history(None).await.is_empty(),
        "an unavailable file row is not Reading history"
    );
    assert_eq!(
        env.rpc("get_library_stats", json!({})).await["bookCount"].as_i64(),
        Some(1)
    );
}

/// Relink attaches a chosen file to the history book and returns the same
/// durable book with every piece of state intact.
#[tokio::test(flavor = "multi_thread")]
async fn relink_restores_the_book_and_its_state() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;

    let book = env.books().await.pop().expect("one imported book");
    let book_uid = book.book_uid.clone().expect("durable uid");
    let shelf = env.create_collection("History").await;
    env.add_to_collection(book.id, shelf).await;
    env.set_title_override(book.id, "Curated History Title")
        .await;
    env.rpc("mark_book_opened", json!({ "bookId": book.id }))
        .await;
    let opened = env
        .rpc("list_books", json!({}))
        .await
        .as_array()
        .and_then(|books| books.first())
        .and_then(|book| book["lastOpenedAt"].as_str())
        .map(str::to_owned)
        .expect("last-opened is recorded");
    env.save_progress(book.id, 63.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": book.id })).await,
        json!(true)
    );
    assert_eq!(env.history(None).await.len(), 1);

    // The picker hands the sidecar a dialog-issued path; the command itself
    // only needs a file path.
    let relinked = env
        .rpc(
            "relink_book",
            json!({ "bookId": book.id, "path": path.to_string_lossy() }),
        )
        .await;
    assert_eq!(relinked["id"].as_i64(), Some(book.id));
    assert_eq!(relinked["bookUid"].as_str(), Some(book_uid.as_str()));
    assert_eq!(
        relinked["path"].as_str(),
        Some(path.to_string_lossy().as_ref())
    );

    let library = env.books().await;
    assert_eq!(library.len(), 1, "the book returns to the library");
    assert_eq!(library[0].id, book.id, "relink does not mint a second book");
    assert!(env.history(None).await.is_empty());

    assert_eq!(env.progress_percent(book.id).await, Some(63.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(
        env.rpc("get_book_metadata", json!({ "bookId": book.id }))
            .await["effective"]["title"],
        json!("Curated History Title")
    );
    assert_eq!(
        env.rpc("list_books", json!({}))
            .await
            .as_array()
            .and_then(|books| books.first())
            .and_then(|book| book["lastOpenedAt"].as_str())
            .map(str::to_owned)
            .as_deref(),
        Some(opened.as_str())
    );

    let durable_books: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(
        durable_books, 1,
        "relink must not create a second durable book"
    );
}

/// Reading-history search is scoped to books without a file; the library
/// search keeps its opposite membership filter.
#[tokio::test(flavor = "multi_thread")]
async fn reading_history_search_is_scoped_to_books_without_a_file() {
    let env = setup().await;
    let history_path = env.write_book("history-copy.epub", &navigation_epub());
    env.write_book("library-copy.epub", &minimal_epub());
    env.scan().await;

    let history_book = env
        .books()
        .await
        .into_iter()
        .find(|book| book.path == history_path.to_string_lossy())
        .expect("the history book imported");
    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": history_book.id }))
            .await,
        json!(true)
    );

    let found = env.history(Some("navigation")).await;
    assert_eq!(
        found.len(),
        1,
        "history search finds the absent book: {found:?}"
    );
    assert_eq!(found[0]["id"].as_i64(), Some(history_book.id));
    assert!(
        env.history(Some("minimal")).await.is_empty(),
        "history search never returns a library membership"
    );

    assert!(
        env.rpc("search_books", json!({ "query": "navigation" }))
            .await
            .as_array()
            .map(Vec::is_empty)
            .unwrap_or(false),
        "library search never returns Reading history"
    );
    assert_eq!(
        env.rpc("search_books", json!({ "query": "minimal" }))
            .await
            .as_array()
            .map(Vec::len),
        Some(1),
        "the library search still returns the remaining membership"
    );
}
