//! Provider-link contract (ADR 0014 D11, ticket tuxbooks-ip6.3).
//!
//! These journeys drive the same JSON-RPC methods the renderer and a future
//! Hardcover adapter use. The provider half is a `FakeProvider`: it records
//! what a real service would send and reads the outgoing queue, with no
//! network call anywhere.

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

    async fn scan(&self) {
        self.rpc(
            "scan_library",
            json!({ "path": self.library.to_string_lossy() }),
        )
        .await;
        self.watcher
            .unwatch_all(std::slice::from_ref(&self.library));
    }

    async fn book(&self) -> Book {
        books::list_books(&self.pool)
            .await
            .unwrap()
            .pop()
            .expect("one imported book")
    }

    async fn history(&self) -> Vec<Value> {
        self.rpc("list_reading_history", json!({}))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    async fn progress_percent(&self, book_id: i64) -> Option<f64> {
        self.rpc("get_reading_progress", json!({ "bookId": book_id }))
            .await
            .get("progressPercent")
            .and_then(Value::as_f64)
    }

    async fn unwatch(&self) {
        let root = self.library.to_string_lossy().into_owned();
        assert_eq!(
            self.rpc("unwatch_locations", json!({ "paths": [root] }))
                .await,
            json!(1)
        );
    }
}

/// The provider side of the contract. It never opens a socket: a remote
/// service would make the same calls after its own HTTP/OAuth layer.
struct FakeProvider<'a> {
    env: &'a Env,
    book_uid: String,
    remote_id: String,
}

impl<'a> FakeProvider<'a> {
    fn new(env: &'a Env, book_uid: &str, remote_id: &str) -> Self {
        Self {
            env,
            book_uid: book_uid.to_string(),
            remote_id: remote_id.to_string(),
        }
    }

    async fn link(&self) -> Value {
        self.env
            .rpc(
                "link_provider_book",
                json!({
                    "bookUid": self.book_uid,
                    "provider": PROVIDER,
                    "remoteId": self.remote_id,
                }),
            )
            .await
    }

    /// What a provider poll or webhook does: report status and/or progress.
    async fn push_reading_update(&self, status: Option<&str>, progress: Option<f64>) -> Value {
        self.env
            .rpc(
                "apply_provider_reading_update",
                json!({
                    "bookUid": self.book_uid,
                    "provider": PROVIDER,
                    "status": status,
                    "progressPercent": progress,
                }),
            )
            .await
    }

    async fn links(&self) -> Vec<Value> {
        self.env
            .rpc("list_provider_links", json!({ "bookUid": self.book_uid }))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    /// The outgoing page-turn a real adapter would drain before calling the
    /// provider API.
    async fn queued_progress(&self) -> Option<f64> {
        providers::pending_progress(&self.env.pool, &self.book_uid, PROVIDER)
            .await
            .unwrap()
    }

    async fn unlink(&self) -> bool {
        self.env
            .rpc(
                "unlink_provider_book",
                json!({ "bookUid": self.book_uid, "provider": PROVIDER }),
            )
            .await
            .as_bool()
            .expect("unlink returns a boolean")
    }
}

/// A link is created, read, and removed by durable book uid. The book payload
/// carries it so the detail view can show it without a second request.
#[tokio::test(flavor = "multi_thread")]
async fn provider_link_is_created_read_and_removed_by_book_uid() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = env.book().await;
    let uid = book.book_uid.clone().expect("durable uid");
    let provider = FakeProvider::new(&env, &uid, "remote-42");

    let linked = provider.link().await;
    assert_eq!(linked["bookUid"].as_str(), Some(uid.as_str()));
    assert_eq!(linked["provider"].as_str(), Some(PROVIDER));
    assert_eq!(linked["remoteId"].as_str(), Some("remote-42"));
    assert!(
        linked["status"].is_null(),
        "no status has been reported yet"
    );

    let links = provider.links().await;
    assert_eq!(links.len(), 1, "one link by bookUid: {links:?}");
    assert_eq!(links[0]["remoteId"].as_str(), Some("remote-42"));

    let payload = env.book().await;
    assert_eq!(payload.provider_links.len(), 1);
    assert_eq!(payload.provider_links[0].remote_id, "remote-42");

    assert!(provider.unlink().await);
    assert!(provider.links().await.is_empty());
    assert_eq!(env.book().await.provider_links.len(), 0);
    assert!(
        !provider.unlink().await,
        "removing a missing link is a no-op"
    );
}

/// The link and its last known status survive unwatch, appear in Reading
/// history, and remote updates keep landing in durable state after the file
/// is gone. Remote updates never queue an outgoing page-turn, and a local
/// save for an absent book queues nothing either.
#[tokio::test(flavor = "multi_thread")]
async fn link_survives_unwatch_and_absent_book_accepts_remote_updates() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = env.book().await;
    let uid = book.book_uid.clone().expect("durable uid");
    let provider = FakeProvider::new(&env, &uid, "remote-42");

    provider.link().await;
    provider
        .push_reading_update(Some("reading"), Some(42.5))
        .await;
    assert_eq!(
        provider.queued_progress().await,
        None,
        "remote writes never queue"
    );
    assert_eq!(env.progress_percent(book.id).await, Some(42.5));

    env.unwatch().await;
    assert!(books::list_books(&env.pool).await.unwrap().is_empty());

    let links = provider.links().await;
    assert_eq!(links.len(), 1, "the link survives unwatch: {links:?}");
    assert_eq!(links[0]["status"].as_str(), Some("reading"));
    assert_eq!(links[0]["remoteId"].as_str(), Some("remote-42"));

    let history = env.history().await;
    assert_eq!(history.len(), 1, "the book is in Reading history");
    let history_links = history[0]["providerLinks"]
        .as_array()
        .expect("history carries provider links");
    assert_eq!(history_links.len(), 1);
    assert_eq!(history_links[0]["provider"].as_str(), Some(PROVIDER));
    assert_eq!(history_links[0]["status"].as_str(), Some("reading"));

    // Remote progress for the absent book is accepted into the same durable
    // progress row the reader uses.
    provider.push_reading_update(None, Some(73.5)).await;
    assert_eq!(env.progress_percent(book.id).await, Some(73.5));
    assert_eq!(
        provider.links().await[0]["status"].as_str(),
        Some("reading"),
        "a progress-only update leaves the cached status alone"
    );

    // A stray local page turn cannot queue anything while no file is open.
    env.rpc(
        "save_reading_progress",
        json!({
            "bookId": book.id,
            "progress": { "progressPercent": 80.0 },
        }),
    )
    .await;
    assert_eq!(
        provider.queued_progress().await,
        None,
        "no local page-turn update while the book has no file"
    );

    // Finished maps onto the existing 100% semantics.
    provider.push_reading_update(Some("finished"), None).await;
    assert_eq!(env.progress_percent(book.id).await, Some(100.0));
    assert_eq!(
        provider.links().await[0]["status"].as_str(),
        Some("finished")
    );
    let history = env.history().await;
    assert_eq!(history[0]["progressPercent"].as_f64(), Some(100.0));
    assert_eq!(
        history[0]["providerLinks"][0]["status"].as_str(),
        Some("finished")
    );

    // The link is still owned by the durable book, so re-importing the same
    // bytes finds it again.
    env.scan().await;
    let again = env.book().await;
    assert_eq!(again.id, book.id);
    assert_eq!(again.provider_links.len(), 1);
    assert_eq!(
        again.provider_links[0].status,
        Some(tuxbooks_lib::domain::ProviderReadingStatus::Finished)
    );
}

/// A local page turn queues one coalesced progress update per link while the
/// book has a file, and unlinking drops the queued update with the link.
#[tokio::test(flavor = "multi_thread")]
async fn local_page_turns_queue_while_a_file_is_open_and_unlink_clears_them() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = env.book().await;
    let uid = book.book_uid.clone().expect("durable uid");
    let provider = FakeProvider::new(&env, &uid, "remote-42");
    provider.link().await;

    provider
        .push_reading_update(Some("reading"), Some(10.0))
        .await;
    assert_eq!(provider.queued_progress().await, None);

    env.rpc(
        "save_reading_progress",
        json!({
            "bookId": book.id,
            "progress": { "progressPercent": 30.0 },
        }),
    )
    .await;
    assert_eq!(provider.queued_progress().await, Some(30.0));

    env.rpc(
        "save_reading_progress",
        json!({
            "bookId": book.id,
            "progress": { "progressPercent": 35.0 },
        }),
    )
    .await;
    assert_eq!(
        provider.queued_progress().await,
        Some(35.0),
        "a later page turn replaces the unsent one"
    );

    env.unwatch().await;
    env.rpc(
        "save_reading_progress",
        json!({
            "bookId": book.id,
            "progress": { "progressPercent": 40.0 },
        }),
    )
    .await;
    assert_eq!(
        provider.queued_progress().await,
        Some(35.0),
        "an absent book queues nothing"
    );

    assert!(provider.unlink().await);
    assert_eq!(provider.queued_progress().await, None);
}
