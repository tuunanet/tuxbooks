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
use tuxbooks_lib::repository::{books, library_locations, metadata as metadata_repo};
use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
use tuxbooks_lib::services::library_reconciler::{PathChange, Reconciler};
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::services::metadata;
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

    async fn metadata(&self, book_id: i64) -> Value {
        self.rpc("get_book_metadata", json!({ "bookId": book_id }))
            .await
    }

    async fn mark_opened(&self, book_id: i64) {
        self.rpc("mark_book_opened", json!({ "bookId": book_id }))
            .await;
    }

    async fn last_opened(&self, book_id: i64) -> Option<String> {
        self.books()
            .await
            .into_iter()
            .find(|book| book.id == book_id)
            .and_then(|book| book.last_opened_at)
            .map(|when| when.to_rfc3339())
    }

    async fn durable_last_opened(&self, book_uid: &str) -> Option<String> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT last_opened_at FROM book_records WHERE uid = ?1")
                .bind(book_uid)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        value.map(|when| {
            chrono::DateTime::parse_from_rfc3339(&when)
                .expect("stored timestamp")
                .with_timezone(&chrono::Utc)
                .to_rfc3339()
        })
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

/// An unreadable file cannot produce a hash. Remove proceeds, keeps the durable
/// state, and does not write the retired relink row.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_hash_does_not_block_removal_and_writes_no_relink_row() {
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

    let relink_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM migration_issues WHERE kind = 'hash_failed'")
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(
        relink_rows, 0,
        "a failed hash no longer writes a relink issue: the book carries it"
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

/// Collection membership, a metadata override, and last-opened are durable
/// book state: an unwatch ends the membership but not any of them, and a
/// re-watch restores the same book with the state attached.
#[tokio::test(flavor = "multi_thread")]
async fn collection_metadata_and_last_opened_survive_unwatch_and_rewatch() {
    let env = setup().await;
    env.write_book("book.epub");
    env.scan().await;

    let book = env.book().await;
    let book_uid = book.book_uid.clone().expect("durable uid");
    let shelf = env.create_collection("Favorites").await;
    env.add_to_collection(book.id, shelf).await;
    env.set_title_override(book.id, "Curated Title").await;
    env.mark_opened(book.id).await;
    let opened = env
        .last_opened(book.id)
        .await
        .expect("the session is recorded");

    let view = env.metadata(book.id).await;
    assert_eq!(view["effective"]["title"], json!("Curated Title"));
    assert_eq!(view["overridden"]["title"], json!(true));

    let root = env.library.to_string_lossy().into_owned();
    assert_eq!(
        env.rpc("unwatch_locations", json!({ "paths": [root.clone()] }))
            .await,
        json!(1)
    );
    assert!(env.books().await.is_empty(), "membership ends");

    // No file is present, but the durable book still owns all three states.
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(
        env.durable_last_opened(&book_uid).await.as_deref(),
        Some(opened.as_str())
    );
    let overrides: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM book_metadata_overrides WHERE book_uid = ?1")
            .bind(&book_uid)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(overrides, 1, "the override survives the last file row");

    env.scan().await;
    let again = env.book().await;
    assert_eq!(again.id, book.id, "same durable book");
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(
        env.last_opened(again.id).await.as_deref(),
        Some(opened.as_str())
    );
    let view = env.metadata(again.id).await;
    assert_eq!(view["effective"]["title"], json!("Curated Title"));
}

/// Remove ends the membership; a re-import reattaches to the durable book and
/// refreshes only the per-file source layer. The override still wins.
#[tokio::test(flavor = "multi_thread")]
async fn metadata_override_and_last_opened_survive_remove_and_reimport() {
    let env = setup().await;
    let path = env.write_book("book.epub");
    env.scan().await;

    let book = env.book().await;
    let shelf = env.create_collection("Keepers").await;
    env.add_to_collection(book.id, shelf).await;
    env.set_title_override(book.id, "Curated Title").await;
    env.mark_opened(book.id).await;
    let opened = env.last_opened(book.id).await.expect("opened");

    assert_eq!(
        env.rpc("remove_book", json!({ "bookId": book.id })).await,
        json!(true)
    );
    assert!(env.books().await.is_empty());
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);

    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let again = env.book().await;
    assert_eq!(again.id, book.id, "the bytes reattach");
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(
        env.last_opened(again.id).await.as_deref(),
        Some(opened.as_str())
    );
    let view = env.metadata(again.id).await;
    assert_eq!(view["effective"]["title"], json!("Curated Title"));

    // A real re-import refreshes the source layer. The curated title still
    // wins, while an untouched field follows the new file.
    let file_id = books::active_file_id(&env.pool, book.id)
        .await
        .unwrap()
        .expect("file row");
    let refreshed = tuxbooks_lib::domain::NewBook {
        path: path.to_string_lossy().into_owned(),
        title: "Fresh Source Title".into(),
        subtitle: Some("Fresh Source Subtitle".into()),
        author: Some("Fresh Author".into()),
        authors: vec!["Fresh Author".into()],
        subjects: vec!["Fresh Subject".into()],
        publisher: Some("Fresh Press".into()),
        language: Some("en".into()),
        isbn: None,
        description: None,
        publication_date: None,
        series: None,
        series_index: None,
        cover_path: None,
        file_size: 42,
        file_mtime: 1_900_000_000,
    };
    metadata_repo::record_imported_source(&env.pool, file_id, &refreshed)
        .await
        .unwrap();

    let view = env.metadata(again.id).await;
    assert_eq!(view["source"]["title"], json!("Fresh Source Title"));
    assert_eq!(view["effective"]["title"], json!("Curated Title"));
    assert_eq!(
        view["effective"]["subtitle"],
        json!("Fresh Source Subtitle"),
        "an untouched field follows the refreshed file"
    );
}

/// A move inside a watched folder keeps the book, its override, its shelf,
/// and its last-opened timestamp.
#[tokio::test(flavor = "multi_thread")]
async fn collection_metadata_and_last_opened_survive_a_move() {
    let env = setup().await;
    let original = env.write_book("book.epub");
    env.scan().await;

    let book = env.book().await;
    let shelf = env.create_collection("Moved").await;
    env.add_to_collection(book.id, shelf).await;
    env.set_title_override(book.id, "Moved Title").await;
    env.mark_opened(book.id).await;
    let opened = env.last_opened(book.id).await.expect("opened");

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
    assert_eq!(again.path, moved.to_string_lossy());
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(
        env.last_opened(again.id).await.as_deref(),
        Some(opened.as_str())
    );
    assert_eq!(
        env.metadata(again.id).await["effective"]["title"],
        json!("Moved Title")
    );
}

/// Two copies of the same bytes collapse into one library entry and share the
/// durable state, including a membership added before the second copy arrived.
#[tokio::test(flavor = "multi_thread")]
async fn a_duplicate_copy_joins_the_same_book_and_state() {
    let env = setup().await;
    env.write_book("first.epub");
    env.scan().await;

    let book = env.book().await;
    let shelf = env.create_collection("Duplicates").await;
    env.add_to_collection(book.id, shelf).await;
    env.set_title_override(book.id, "Shared Title").await;
    env.mark_opened(book.id).await;
    let opened = env.last_opened(book.id).await.expect("opened");

    // The same bytes under a second path attach to the same durable book.
    std::fs::copy(
        env.library.join("first.epub"),
        env.library.join("second.epub"),
    )
    .unwrap();
    env.scan().await;

    let books = env.books().await;
    assert_eq!(
        books.len(),
        1,
        "one library entry per durable book: {books:?}"
    );
    assert_eq!(books[0].id, book.id);
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(
        env.last_opened(book.id).await.as_deref(),
        Some(opened.as_str())
    );
    assert_eq!(
        env.metadata(book.id).await["effective"]["title"],
        json!("Shared Title")
    );
}

/// No user-state table cascades when a file row is deleted. This is the
/// storage guarantee behind the whole durable-book model.
#[tokio::test(flavor = "multi_thread")]
async fn removing_the_last_file_row_keeps_every_user_state_table() {
    let env = setup().await;
    env.write_book("book.epub");
    env.scan().await;

    let book = env.book().await;
    let book_uid = book.book_uid.clone().expect("durable uid");
    let shelf = env.create_collection("State").await;
    env.add_to_collection(book.id, shelf).await;
    env.set_title_override(book.id, "Kept Title").await;
    env.mark_opened(book.id).await;
    env.save_progress(book.id, 33.0, "chapter1.xhtml").await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    // A customized list is user state too.
    let overrides = metadata_repo::OverrideRow {
        authors_customized: true,
        subjects_customized: true,
        ..metadata_repo::OverrideRow::default()
    };
    metadata::apply_synced_overrides(
        &env.pool,
        book.id,
        &overrides,
        &["Custom Author".into()],
        &["Custom Subject".into()],
    )
    .await
    .unwrap();

    assert!(books::delete_book(&env.pool, book.id).await.unwrap());
    assert!(env.books().await.is_empty());

    for (table, key) in [
        ("book_collections", "book_uid"),
        ("book_metadata_overrides", "book_uid"),
        ("book_authors", "book_uid"),
        ("book_subjects", "book_uid"),
        ("reading_progress", "book_uid"),
        ("annotations", "book_uid"),
    ] {
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE {key} = ?1"))
                .bind(&book_uid)
                .fetch_one(&env.pool)
                .await
                .unwrap();
        assert!(count > 0, "{table} lost its rows with the file row");
    }
}
