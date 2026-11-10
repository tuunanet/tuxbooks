//! Shared harness for the Reset, Forget, and restore journeys: a
//! temporary library and database behind the JSON-RPC seam, plus the
//! fixtures and environment methods the journeys share.

pub use std::collections::HashSet;
pub use std::path::{Path, PathBuf};
pub use std::sync::{Arc, Mutex};
pub use std::time::{Duration, Instant, UNIX_EPOCH};

pub use serde_json::{json, Value};
pub use sqlx::{Connection, SqlitePool};
pub use tempfile::TempDir;
pub use tuxbooks_lib::db::connection::init_pool;
pub use tuxbooks_lib::domain::{Book, NewBook, ProgressUpdate};
pub use tuxbooks_lib::repository::{books, lifecycle, metadata as metadata_repo, reading_progress};
pub use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
pub use tuxbooks_lib::services::library_reconciler::Reconciler;
pub use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
pub use tuxbooks_lib::services::metadata;
pub use tuxbooks_lib::sync::capture;
pub use tuxbooks_lib::sync::clock::device_id;
pub use tuxbooks_lib::sync::engine::{SyncService, SyncState};
pub use tuxbooks_lib::sync::identity::record_issue;
pub use tuxbooks_lib::sync::merge::retry_book_lifecycle;
pub use tuxbooks_lib::sync::model::EntityKind;
pub use tuxbooks_lib::sync::store;
pub use tuxbooks_lib::{AppState, ImportRegistry};

pub fn minimal_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
}

pub fn navigation_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/epub/core/epub3/navigation.epub")
}

pub struct Env {
    pub _tmp: TempDir,
    pub db_path: PathBuf,
    pub library: PathBuf,
    pub pool: SqlitePool,
    pub watcher: Arc<LibraryWatcher>,
    pub emitter: EventEmitter,
    pub importing: ImportRegistry,
    pub sync: Option<Arc<SyncService>>,
}

pub async fn setup() -> Env {
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
        sync: None,
    }
}

impl Env {
    pub fn state(&self) -> Arc<AppState> {
        Arc::new(AppState {
            db: self.pool.clone(),
            db_path: self.db_path.clone(),
            watcher: Arc::clone(&self.watcher),
            startup_recovery: None,
            sync: self.sync.clone(),
            importing: self.importing.clone(),
        })
    }

    pub fn write_book(&self, name: &str, source: &Path) -> PathBuf {
        let path = self.library.join(name);
        std::fs::copy(source, &path).unwrap();
        path
    }

    pub async fn rpc(&self, method: &str, params: Value) -> Value {
        let response = self.rpc_raw(method, params).await;
        assert!(
            response.get("error").is_none(),
            "{method} failed: {response}"
        );
        response["result"].clone()
    }

    /// Like `rpc`, but hands back the whole response: for the tests that
    /// pin the error surface itself.
    pub async fn rpc_raw(&self, method: &str, params: Value) -> Value {
        let request = json!({
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

    pub async fn scan(&self) {
        self.rpc(
            "scan_library",
            json!({ "path": self.library.to_string_lossy() }),
        )
        .await;
        self.watcher
            .unwatch_all(std::slice::from_ref(&self.library));
    }

    pub async fn books(&self) -> Vec<Book> {
        books::list_books(&self.pool).await.unwrap()
    }

    pub async fn history(&self) -> Vec<Value> {
        self.rpc("list_reading_history", json!({}))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    pub async fn save_progress(&self, book_id: i64, percent: f64) {
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

    pub async fn annotate(&self, book_id: i64, cfi: &str) {
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

    pub async fn progress_percent(&self, book_id: i64) -> Option<f64> {
        self.rpc("get_reading_progress", json!({ "bookId": book_id }))
            .await
            .get("progressPercent")
            .and_then(Value::as_f64)
    }

    pub async fn annotation_count(&self, book_id: i64) -> usize {
        self.rpc("list_annotations", json!({ "bookId": book_id }))
            .await
            .as_array()
            .map(Vec::len)
            .unwrap_or_default()
    }

    pub async fn create_collection(&self, name: &str) -> i64 {
        self.rpc("create_collection", json!({ "name": name })).await["id"]
            .as_i64()
            .expect("collection id")
    }

    pub async fn add_to_collection(&self, book_id: i64, collection_id: i64) {
        self.rpc(
            "add_book_to_collection",
            json!({ "bookId": book_id, "collectionId": collection_id }),
        )
        .await;
    }

    pub async fn collection_book_ids(&self, collection_id: i64) -> Vec<i64> {
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

    pub async fn set_title_override(&self, book_id: i64, title: &str) {
        let overrides = metadata_repo::OverrideRow {
            title: Some(title.into()),
            ..metadata_repo::OverrideRow::default()
        };
        metadata::apply_synced_overrides(&self.pool, book_id, &overrides, &[], &[])
            .await
            .unwrap();
    }

    pub async fn effective_title(&self, book_id: i64) -> String {
        self.rpc("get_book_metadata", json!({ "bookId": book_id }))
            .await["effective"]["title"]
            .as_str()
            .unwrap()
            .to_string()
    }

    pub async fn link_provider(&self, book_uid: &str, provider: &str, remote_id: &str) {
        self.rpc(
            "link_provider_book",
            json!({ "bookUid": book_uid, "provider": provider, "remoteId": remote_id }),
        )
        .await;
    }

    pub async fn provider_links(&self, book_uid: &str) -> Vec<Value> {
        self.rpc("list_provider_links", json!({ "bookUid": book_uid }))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    pub async fn trash(&self) -> Vec<Value> {
        self.rpc("list_book_trash", json!({}))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    pub async fn alias_count(&self, book_uid: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    pub async fn alias_owner(&self, content_hash: &str) -> Option<String> {
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(content_hash)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
    }

    pub async fn content_hash(&self, book_uid: &str) -> String {
        sqlx::query_scalar(
            "SELECT content_hash FROM sync_book_bindings WHERE book_uid = ?1 LIMIT 1",
        )
        .bind(book_uid)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    pub async fn durable_count(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM book_records")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// Seed one durable file-backed book through the repository path the
    /// import pipeline lands on, skipping the parser. Unique bytes per book
    /// keep every identity separate.
    pub async fn add_durable_book(&self, name: &str, tag: &str) -> i64 {
        let path = self.library.join(name);
        std::fs::write(&path, format!("durable bytes for {tag}\n")).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let mtime = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let upserted = books::upsert_file(
            &self.pool,
            &NewBook {
                path: path.to_string_lossy().into_owned(),
                title: name.trim_end_matches(".epub").to_string(),
                subtitle: None,
                author: Some("Author".into()),
                authors: vec!["Author".into()],
                subjects: Vec::new(),
                publisher: None,
                language: None,
                isbn: None,
                description: None,
                publication_date: None,
                series: None,
                series_index: None,
                cover_path: None,
                file_size: metadata.len() as i64,
                file_mtime: mtime,
            },
        )
        .await
        .unwrap();
        tuxbooks_lib::sync::identity::ensure_book_identity(&self.pool, upserted.file_id)
            .await
            .unwrap();
        books::durable_id_for_file(&self.pool, upserted.file_id)
            .await
            .unwrap()
            .expect("seeded book is durable")
    }

    /// Mirror state on a durable book, which is what feeds `sync_dirty`.
    pub async fn seed_progress(&self, book_id: i64, percent: f64) {
        reading_progress::upsert_progress(
            &self.pool,
            book_id,
            &ProgressUpdate {
                progress_percent: Some(percent),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
}

pub async fn imported_book(env: &Env) -> Book {
    env.books().await.pop().expect("one imported book")
}
