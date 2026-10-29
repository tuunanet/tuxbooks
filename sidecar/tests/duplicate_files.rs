//! Command-surface journeys for duplicate file copies (ADR 0014 D7, ticket
//! tuxbooks-ip6.6): identical bytes share one library entry, every location is
//! visible on the details, state is shared, removing one copy keeps the book,
//! and storage keeps counting every file's bytes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::{Book, NewBook};
use tuxbooks_lib::repository::books;
use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
use tuxbooks_lib::services::hash_backfill;
use tuxbooks_lib::services::library_reconciler::Reconciler;
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::{AppState, ImportRegistry};

fn minimal_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
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

    fn copy_book(&self, name: &str) -> PathBuf {
        let path = self.library.join(name);
        std::fs::copy(minimal_epub(), &path).unwrap();
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

    async fn scan(&self) {
        self.rpc(
            "scan_library",
            json!({ "path": self.library.to_string_lossy() }),
        )
        .await;
        self.watcher
            .unwatch_all(std::slice::from_ref(&self.library));
    }

    async fn library(&self) -> Vec<Book> {
        books::list_books(&self.pool).await.unwrap()
    }

    async fn files(&self, book_id: i64) -> Vec<Value> {
        self.rpc("list_book_files", json!({ "bookId": book_id }))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    async fn storage(&self) -> Value {
        self.rpc("get_storage_stats", json!({})).await
    }

    async fn save_progress(&self, book_id: i64) {
        self.rpc(
            "save_reading_progress",
            json!({
                "bookId": book_id,
                "progress": {
                    "chapterHref": "chapter1.xhtml",
                    "characterOffset": 120,
                    "progressPercent": 42,
                },
            }),
        )
        .await;
    }

    async fn annotate(&self, book_id: i64) -> i64 {
        let result = self
            .rpc(
                "create_annotation",
                json!({
                    "bookId": book_id,
                    "annotation": {
                        "kind": "highlight",
                        "cfi": "epubcfi(/6/4!/4/2,/1:0,/1:8)",
                        "chapterHref": "chapter1.xhtml",
                        "text": "a shared passage",
                        "color": "yellow",
                    },
                }),
            )
            .await;
        result["id"].as_i64().expect("annotation id")
    }

    async fn create_collection(&self, name: &str) -> i64 {
        let result = self.rpc("create_collection", json!({ "name": name })).await;
        result["id"].as_i64().expect("collection id")
    }

    async fn add_to_collection(&self, book_id: i64, collection_id: i64) {
        self.rpc(
            "add_book_to_collection",
            json!({ "bookId": book_id, "collectionId": collection_id }),
        )
        .await;
    }

    async fn progress_percent(&self, book_id: i64) -> Option<f64> {
        self.rpc("get_reading_progress", json!({ "bookId": book_id }))
            .await
            .get("progressPercent")
            .and_then(Value::as_f64)
    }

    async fn annotation_count(&self, book_id: i64) -> usize {
        self.rpc("list_annotations", json!({ "bookId": book_id }))
            .await
            .as_array()
            .map(Vec::len)
            .unwrap_or_default()
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

    async fn last_opened(&self, book_id: i64) -> Option<String> {
        self.library()
            .await
            .into_iter()
            .find(|book| book.id == book_id)
            .and_then(|book| book.last_opened_at)
            .map(|at| at.to_rfc3339())
    }
}

fn sample(path: &Path, file_size: i64) -> NewBook {
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: "First".into(),
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
        file_mtime: 1_700_000_000,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn identical_files_share_one_entry_with_every_location_and_shared_state() {
    let env = setup().await;
    let first = env.copy_book("first.epub");
    let second = env.copy_book("second.epub");
    env.scan().await;

    let listed = env.library().await;
    assert_eq!(listed.len(), 1, "one library entry per durable book");
    let book = &listed[0];

    // Library counts are books, not file rows.
    let stats = env.rpc("get_library_stats", json!({})).await;
    assert_eq!(stats["bookCount"], json!(1));

    let files = env.files(book.id).await;
    assert_eq!(files.len(), 2, "the details list every copy: {files:?}");
    let paths: Vec<&str> = files
        .iter()
        .filter_map(|file| file["path"].as_str())
        .collect();
    assert!(paths.contains(&first.to_string_lossy().as_ref()));
    assert!(paths.contains(&second.to_string_lossy().as_ref()));
    assert_eq!(
        files.iter().filter(|file| file["active"] == true).count(),
        1,
        "exactly one copy is the reader's active file"
    );

    // The active-file rule is available first, then the lowest file id. Both
    // copies are available, so the lower id wins and the library's path is it.
    let active = files
        .iter()
        .find(|file| file["active"] == true)
        .expect("active copy");
    let active_id = active["id"].as_i64().expect("active file id");
    let lowest_id = files
        .iter()
        .filter_map(|file| file["id"].as_i64())
        .min()
        .expect("file ids");
    assert_eq!(active_id, lowest_id);
    assert_eq!(
        book.path,
        active["path"].as_str().expect("active path"),
        "the library shows the active file"
    );
    assert_eq!(
        books::active_file_id(&env.pool, book.id).await.unwrap(),
        Some(active_id),
        "the reader resolves the same active file"
    );

    // Search indexes the durable book, so the two copies are one hit.
    let hits = env.rpc("search_books", json!({ "query": "Minimal" })).await;
    assert_eq!(hits.as_array().map(Vec::len), Some(1), "one hit per book");

    // State is keyed by the durable book, so reading or annotating through
    // the one entry is the state both copies share.
    env.save_progress(book.id).await;
    env.annotate(book.id).await;
    let shelf = env.create_collection("Duplicates").await;
    env.add_to_collection(book.id, shelf).await;
    env.rpc("mark_book_opened", json!({ "bookId": book.id }))
        .await;
    assert_eq!(env.progress_percent(book.id).await, Some(42.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert!(env.last_opened(book.id).await.is_some());

    // Storage reports every file's bytes but counts the book once.
    let file_bytes = std::fs::metadata(&first).unwrap().len() as i64;
    let storage = env.storage().await;
    assert_eq!(storage["catalog"]["books"], json!(1));
    assert_eq!(storage["bookTotalBytes"], json!(file_bytes * 2));
    assert_eq!(storage["locations"][0]["bookCount"], json!(1));
    assert_eq!(storage["locations"][0]["totalBytes"], json!(file_bytes * 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_one_copy_keeps_the_book_and_its_state() {
    let env = setup().await;
    let first = env.copy_book("first.epub");
    let second = env.copy_book("second.epub");
    env.scan().await;

    let mut listed = env.library().await;
    assert_eq!(listed.len(), 1);
    let book = listed.remove(0);
    env.save_progress(book.id).await;
    env.annotate(book.id).await;
    let shelf = env.create_collection("Kept").await;
    env.add_to_collection(book.id, shelf).await;
    env.rpc("mark_book_opened", json!({ "bookId": book.id }))
        .await;
    let opened = env.last_opened(book.id).await.expect("opened");

    let files = env.files(book.id).await;
    let active = files
        .iter()
        .find(|file| file["active"] == true)
        .expect("active file");
    let removed_id = active["id"].as_i64().unwrap();
    let active_path = active["path"].as_str().unwrap().to_string();
    let survivor = if active_path == first.to_string_lossy() {
        second.to_string_lossy().to_string()
    } else {
        first.to_string_lossy().to_string()
    };

    let removed = env
        .rpc(
            "remove_book_file",
            json!({ "bookId": book.id, "fileId": removed_id }),
        )
        .await;
    assert_eq!(removed, json!(true));

    // The library entry survives through the other copy and the active file
    // moved with it.
    let listed = env.library().await;
    assert_eq!(listed.len(), 1, "the book stays while a copy remains");
    assert_eq!(listed[0].id, book.id);
    assert_eq!(listed[0].path, survivor);
    let remaining = env.files(book.id).await;
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["path"], json!(survivor));
    assert_eq!(remaining[0]["active"], json!(true));

    // Every piece of durable state is untouched.
    assert_eq!(env.progress_percent(book.id).await, Some(42.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(
        env.last_opened(book.id).await.as_deref(),
        Some(opened.as_str())
    );

    // The surviving file's bytes are still reported; the removed copy is not.
    let file_bytes = std::fs::metadata(&survivor).unwrap().len() as i64;
    let storage = env.storage().await;
    assert_eq!(storage["catalog"]["books"], json!(1));
    assert_eq!(storage["bookTotalBytes"], json!(file_bytes));

    // Removing the last copy ends membership but keeps the durable book in
    // Reading history with its state.
    let last_id = remaining[0]["id"].as_i64().unwrap();
    env.rpc(
        "remove_book_file",
        json!({ "bookId": book.id, "fileId": last_id }),
    )
    .await;
    assert!(env.library().await.is_empty());
    let history = env
        .rpc("list_reading_history", json!({}))
        .await
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["id"], json!(book.id));
    assert_eq!(history[0]["progressPercent"], json!(42.0));
    assert_eq!(history[0]["annotationCount"], json!(1));
    assert_eq!(env.progress_percent(book.id).await, Some(42.0));
    assert_eq!(env.storage().await["bookTotalBytes"], json!(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_available_copy_wins_the_active_file_over_a_missing_lower_id() {
    let env = setup().await;
    let first = env.copy_book("first.epub");
    let second = env.copy_book("second.epub");
    env.scan().await;

    let mut listed = env.library().await;
    assert_eq!(listed.len(), 1);
    let book = listed.remove(0);
    let files = env.files(book.id).await;
    let lowest_id = files
        .iter()
        .filter_map(|file| file["id"].as_i64())
        .min()
        .expect("file ids");

    // The first copy disappears from disk; its row stays but is unavailable.
    books::set_availability_prefix(&env.pool, &first.to_string_lossy(), false)
        .await
        .unwrap();

    let listed = env.library().await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, second.to_string_lossy());
    let files = env.files(book.id).await;
    let active = files
        .iter()
        .find(|file| file["active"] == true)
        .expect("active copy");
    assert_eq!(active["path"], json!(second.to_string_lossy()));
    assert_eq!(active["available"], json!(true));
    assert_ne!(active["id"].as_i64(), Some(lowest_id));
    assert_eq!(
        books::active_file_id(&env.pool, book.id).await.unwrap(),
        active["id"].as_i64(),
        "the reader resolves the available copy, not the lower id"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn existing_duplicate_rows_collapse_after_the_hash_backfill() {
    let env = setup().await;
    let first = env.copy_book("first.epub");
    let second = env.copy_book("second.epub");
    let size = std::fs::metadata(&first).unwrap().len() as i64;

    // Two rows with separate durable identities, as an upgrade leaves them
    // before the background pass discovers they are the same bytes.
    let first_id = books::insert_book(&env.pool, &sample(&first, size))
        .await
        .unwrap();
    let second_id = books::insert_book(&env.pool, &sample(&second, size))
        .await
        .unwrap();
    assert_ne!(first_id, second_id);
    assert_eq!(env.library().await.len(), 2);

    hash_backfill::run_until_idle(&env.pool).await.unwrap();

    let listed = env.library().await;
    assert_eq!(listed.len(), 1, "the backfill collapses the duplicate rows");
    let book_id = listed[0].id;
    let files = env.files(book_id).await;
    assert_eq!(files.len(), 2, "both locations remain on the one entry");
    assert_eq!(
        env.rpc("get_library_stats", json!({})).await["bookCount"],
        json!(1)
    );
}
