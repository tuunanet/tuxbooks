//! Command-surface journeys for Reset, Forget, and the 30-day restore
//! (ADR 0014 D5, ticket tuxbooks-ip6.7). Every test drives the JSON-RPC seam
//! the app uses, not the private tables, except where the acceptance criterion
//! is explicitly about aliases and identities.

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

    async fn effective_title(&self, book_id: i64) -> String {
        self.rpc("get_book_metadata", json!({ "bookId": book_id }))
            .await["effective"]["title"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn link_provider(&self, book_uid: &str, provider: &str, remote_id: &str) {
        self.rpc(
            "link_provider_book",
            json!({ "bookUid": book_uid, "provider": provider, "remoteId": remote_id }),
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

    async fn trash(&self) -> Vec<Value> {
        self.rpc("list_book_trash", json!({}))
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    async fn alias_count(&self, book_uid: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn alias_owner(&self, content_hash: &str) -> Option<String> {
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(content_hash)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
    }

    async fn content_hash(&self, book_uid: &str) -> String {
        sqlx::query_scalar(
            "SELECT content_hash FROM sync_book_bindings WHERE book_uid = ?1 LIMIT 1",
        )
        .bind(book_uid)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn durable_count(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM book_records")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

async fn imported_book(env: &Env) -> Book {
    env.books().await.pop().expect("one imported book")
}

/// Reset keeps the identity and file, and clears every user-owned surface.
#[tokio::test(flavor = "multi_thread")]
async fn reset_clears_state_and_keeps_the_book_and_file() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let source_title = book.title.clone();
    let uid = book.book_uid.clone().unwrap();
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(book.id, shelf).await;
    env.save_progress(book.id, 42.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.set_title_override(book.id, "Curated Reset Title").await;
    env.link_provider(&uid, "hardcover", "hc-reset").await;
    assert_eq!(env.effective_title(book.id).await, "Curated Reset Title");

    assert_eq!(
        env.rpc("reset_book_reading_data", json!({ "bookId": book.id }))
            .await,
        json!(true)
    );

    let library = env.books().await;
    assert_eq!(library.len(), 1, "the book stays in the library");
    assert_eq!(library[0].id, book.id, "Reset keeps the durable identity");
    assert_eq!(library[0].book_uid.as_deref(), Some(uid.as_str()));
    assert_eq!(library[0].path, path.to_string_lossy());
    assert_eq!(library[0].progress_percent, None);
    assert!(env.provider_links(&uid).await.is_empty());
    assert_eq!(env.annotation_count(book.id).await, 0);
    assert!(env.collection_book_ids(shelf).await.is_empty());
    assert_eq!(
        env.effective_title(book.id).await,
        source_title,
        "metadata falls back to the source file"
    );
    assert!(env.history().await.is_empty());
}

/// Forget with no file deletes the durable record and its hash aliases, so a
/// later import of the same bytes is a genuinely new book.
#[tokio::test(flavor = "multi_thread")]
async fn forget_without_a_file_deletes_the_record_and_its_aliases() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    let hash = env.content_hash(&old_uid).await;
    env.save_progress(book.id, 12.0).await;

    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    assert_eq!(env.history().await.len(), 1);

    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    assert!(outcome["replacementBookId"].is_null());
    assert_eq!(env.history().await.len(), 0);
    assert_eq!(env.durable_count().await, 0);
    assert_eq!(env.alias_count(&old_uid).await, 0);
    assert_eq!(env.trash().await.len(), 1);

    // Same bytes returning must not resurrect the forgotten identity.
    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let reimported = imported_book(&env).await;
    assert_ne!(reimported.id, book.id);
    assert_ne!(reimported.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(env.progress_percent(reimported.id).await, None);
    assert_ne!(
        env.alias_owner(&hash).await.as_deref(),
        Some(old_uid.as_str())
    );
}

/// A forgotten book with no file restores into Reading history with its
/// state intact, even when no fresh identity exists.
#[tokio::test(flavor = "multi_thread")]
async fn restore_without_a_file_returns_to_reading_history() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let uid = book.book_uid.clone().unwrap();
    env.save_progress(book.id, 31.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();

    let result = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(result["status"], json!("restored"));
    assert_eq!(result["bookId"].as_i64(), Some(book.id));
    assert_eq!(result["bookUid"].as_str(), Some(uid.as_str()));
    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["progressPercent"].as_f64(), Some(31.0));
    assert_eq!(history[0]["annotationCount"].as_i64(), Some(1));
}

/// Forget with a file keeps the library entry, rebinds it to a fresh identity,
/// moves the old state to the trash, re-points the hash alias, and unlinks
/// providers without touching remote history.
#[tokio::test(flavor = "multi_thread")]
async fn forget_with_a_file_rebinds_the_entry_and_moves_state_to_trash() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    let source_title = book.title.clone();
    let hash = env.content_hash(&old_uid).await;
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(book.id, shelf).await;
    env.save_progress(book.id, 44.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.set_title_override(book.id, "Curated Old Title").await;
    env.link_provider(&old_uid, "hardcover", "hc-forget").await;

    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let replacement_id = outcome["replacementBookId"]
        .as_i64()
        .expect("the file stays in the library");

    let library = env.books().await;
    assert_eq!(library.len(), 1, "the library entry never disappears");
    let fresh = &library[0];
    assert_eq!(fresh.id, replacement_id);
    assert_eq!(fresh.path, path.to_string_lossy());
    assert_ne!(fresh.id, book.id);
    assert_ne!(fresh.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(fresh.progress_percent, None);
    assert_eq!(fresh.title, source_title, "the fresh identity starts fresh");
    assert!(fresh.provider_links.is_empty());

    assert_eq!(env.progress_percent(fresh.id).await, None);
    assert_eq!(env.annotation_count(fresh.id).await, 0);
    assert!(env.collection_book_ids(shelf).await.is_empty());
    assert!(env.provider_links(old_uid.as_str()).await.is_empty());
    assert_eq!(env.alias_count(&old_uid).await, 0);
    let fresh_uid = fresh.book_uid.clone().unwrap();
    assert_eq!(
        env.alias_owner(&hash).await.as_deref(),
        Some(fresh_uid.as_str()),
        "the current bytes point at the fresh identity"
    );

    let trash = env.trash().await;
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0]["bookUid"].as_str(), Some(old_uid.as_str()));
    assert_eq!(trash[0]["replacementBookId"].as_i64(), Some(fresh.id));
    assert_eq!(trash[0]["progressPercent"].as_f64(), Some(44.0));
    assert_eq!(trash[0]["annotationCount"].as_i64(), Some(1));

    // A re-import of the same path finds the fresh alias, not the old one.
    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let after = env.books().await;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, fresh.id);
}

/// Restore with no new state rebinds the file to the old record silently.
#[tokio::test(flavor = "multi_thread")]
async fn restore_with_no_new_state_brings_back_the_old_identity() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    let hash = env.content_hash(&old_uid).await;
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(book.id, shelf).await;
    env.save_progress(book.id, 27.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.set_title_override(book.id, "Restored Title").await;
    env.link_provider(&old_uid, "hardcover", "hc-restore").await;

    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();

    let restored = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(restored["status"], json!("restored"));
    assert_eq!(restored["bookId"].as_i64(), Some(book.id));
    assert_eq!(restored["bookUid"].as_str(), Some(old_uid.as_str()));

    let library = env.books().await;
    assert_eq!(library.len(), 1);
    assert_eq!(library[0].id, book.id, "the old identity is back");
    assert_ne!(library[0].id, fresh_id);
    assert_eq!(library[0].book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(env.progress_percent(book.id).await, Some(27.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(env.effective_title(book.id).await, "Restored Title");
    let links = env.provider_links(&old_uid).await;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["remoteId"], json!("hc-restore"));
    assert_eq!(
        env.alias_owner(&hash).await.as_deref(),
        Some(old_uid.as_str())
    );
    assert!(
        env.trash().await.is_empty(),
        "the entry leaves the open trash"
    );
    assert_eq!(env.durable_count().await, 1, "the fresh record is gone");
}

/// A fresh identity with new progress forces an explicit choice. Replace puts
/// the old state back and discards the new.
#[tokio::test(flavor = "multi_thread")]
async fn restore_reports_a_conflict_and_replace_restores_old_state() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 18.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();
    env.save_progress(fresh_id, 55.0).await;
    env.annotate(fresh_id, "epubcfi(/6/4!/4/2,/1:10,/1:18)")
        .await;
    assert_eq!(env.trash().await[0]["hasNewState"], json!(true));

    let conflict = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(conflict["status"], json!("conflict"));
    assert_eq!(conflict["conflict"]["progressPercent"].as_f64(), Some(55.0));
    assert_eq!(conflict["conflict"]["annotationCount"].as_i64(), Some(1));
    assert_eq!(
        env.progress_percent(fresh_id).await,
        Some(55.0),
        "asking for the choice changes nothing"
    );

    let replaced = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "mode": "replace" }),
        )
        .await;
    assert_eq!(replaced["status"], json!("restored"));
    assert_eq!(env.progress_percent(book.id).await, Some(18.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.books().await[0].id, book.id);
}

/// Keep discards the snapshot and leaves the fresh identity and its new state
/// exactly where the user left them.
#[tokio::test(flavor = "multi_thread")]
async fn restore_keep_keeps_the_current_book() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 10.0).await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();
    env.save_progress(fresh_id, 62.0).await;
    env.annotate(fresh_id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    let kept = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "mode": "keep" }),
        )
        .await;
    assert_eq!(kept["status"], json!("kept"));
    assert_eq!(kept["bookId"].as_i64(), Some(fresh_id));
    assert_eq!(env.books().await[0].id, fresh_id);
    assert_eq!(env.progress_percent(fresh_id).await, Some(62.0));
    assert_eq!(env.annotation_count(fresh_id).await, 1);
    assert!(env.trash().await.is_empty());
    assert_eq!(env.durable_count().await, 1);
}

/// Merge keeps the newer progress and unions annotations on the current
/// identity.
#[tokio::test(flavor = "multi_thread")]
async fn restore_merge_takes_newer_progress_and_both_annotations() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 20.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();
    env.save_progress(fresh_id, 65.0).await;
    env.annotate(fresh_id, "epubcfi(/6/4!/4/2,/1:10,/1:18)")
        .await;

    let merged = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "mode": "merge" }),
        )
        .await;
    assert_eq!(merged["status"], json!("restored"));
    assert_eq!(merged["bookId"].as_i64(), Some(fresh_id));
    assert_eq!(
        env.progress_percent(fresh_id).await,
        Some(65.0),
        "the newer save wins"
    );
    assert_eq!(
        env.annotation_count(fresh_id).await,
        2,
        "both annotations survive the merge"
    );
    assert!(env.trash().await.is_empty());
}

/// Bulk Forget from Reading history applies the same local rebind to each
/// selected book and returns one trash entry per book.
#[tokio::test(flavor = "multi_thread")]
async fn bulk_forget_rebinds_every_selected_library_book() {
    let env = setup().await;
    env.write_book("minimal.epub", &minimal_epub());
    env.write_book("navigation.epub", &navigation_epub());
    env.scan().await;
    let before = env.books().await;
    assert_eq!(before.len(), 2);
    for book in &before {
        env.save_progress(book.id, 40.0).await;
    }

    let result = env
        .rpc(
            "forget_books",
            json!({ "bookIds": before.iter().map(|book| book.id).collect::<Vec<_>>() }),
        )
        .await;
    assert_eq!(result["forgotten"].as_i64(), Some(2));
    assert_eq!(result["trashIds"].as_array().unwrap().len(), 2);

    let after = env.books().await;
    assert_eq!(after.len(), 2, "both library entries survive");
    for (old, fresh) in before.iter().zip(after.iter()) {
        assert_ne!(fresh.id, old.id);
        assert_ne!(fresh.book_uid, old.book_uid);
        assert_eq!(env.progress_percent(fresh.id).await, None);
    }
    assert_eq!(env.trash().await.len(), 2);
    assert_eq!(env.durable_count().await, 2);
}
