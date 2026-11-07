//! A shared Forget or restore deletes the record the other machine's renderer
//! is showing, and the book can come back under a different public id. No
//! per-book upsert can drop that card, so the pass that applies one has to ask
//! for the settled list, or the file shows up twice (tuxbooks-jpj).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use sqlx::SqlitePool;
use tempfile::TempDir;

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::NewBook;
use tuxbooks_lib::repository::{books, lifecycle};
use tuxbooks_lib::rpc::EventEmitter;
use tuxbooks_lib::sync::engine::SyncService;
use tuxbooks_lib::sync::identity::ensure_book_identity;

type EmittedEvents = Arc<Mutex<Vec<(&'static str, Value)>>>;

struct Device {
    _dir: TempDir,
    pool: SqlitePool,
    service: SyncService,
    db_path: PathBuf,
    events: EmittedEvents,
}

async fn device() -> Device {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("tuxbooks.db");
    let pool = init_pool(&db_path).await.unwrap();
    let events: EmittedEvents = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let emitter = EventEmitter::new(move |name: &'static str, payload: Value| {
        sink.lock().unwrap().push((name, payload));
    });
    let service = SyncService::new(pool.clone(), &db_path, emitter)
        .await
        .unwrap();
    Device {
        _dir: dir,
        pool,
        service,
        db_path,
        events,
    }
}

async fn connect(device: &Device, folder: &Path) {
    let result = device
        .service
        .connect(folder.to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    assert!(result.mismatch.is_none(), "unexpected mismatch");
}

async fn run(device: &Device) {
    device.service.run_pass().await.unwrap();
}

async fn add_book(device: &Device, name: &str, bytes: &[u8]) -> i64 {
    let library = device.db_path.parent().unwrap().join("library");
    std::fs::create_dir_all(&library).unwrap();
    let path = library.join(name);
    std::fs::write(&path, bytes).unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    let mtime = metadata
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let upserted = books::upsert_file(
        &device.pool,
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
    // Import hashes before the row is published (ADR 0014 D8).
    ensure_book_identity(&device.pool, upserted.file_id)
        .await
        .unwrap();
    books::durable_id_for_file(&device.pool, upserted.file_id)
        .await
        .unwrap()
        .expect("hashed book")
}

async fn book_id(device: &Device, name: &str) -> i64 {
    let path = device.db_path.parent().unwrap().join("library").join(name);
    books::get_book_by_path(&device.pool, &path.to_string_lossy())
        .await
        .unwrap()
        .expect("book is in the library")
        .id
}

async fn book_uid(device: &Device, name: &str) -> String {
    let id = book_id(device, name).await;
    sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(id)
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

/// One reload event and a spent marker: the pass asked the renderer to
/// refetch the settled list.
fn reloaded(device: &Device) -> bool {
    device.events.lock().unwrap().iter().any(|(name, payload)| {
        *name == "library-changed" && payload["kind"].as_str() == Some("reload")
    })
}

async fn reload_marker(device: &Device) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'library_reload_pending'")
        .fetch_optional(&device.pool)
        .await
        .unwrap()
}

/// Forget on one machine deletes the record the other machine's renderer
/// holds, and the restore that follows deletes the fresh identity in its
/// place. Both passes must end in one reload and one library card.
#[tokio::test(flavor = "multi_thread")]
async fn a_shared_forget_and_restore_ask_the_other_renderer_to_reload() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"one book, two machines";
    let _ = add_book(&a, "shared.epub", bytes).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let _ = add_book(&b, "shared.epub", bytes).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    run(&a).await;
    run(&b).await;
    run(&a).await;
    // Convergence can re-key the public id, so resolve it fresh.
    let a_book = book_id(&a, "shared.epub").await;
    assert_eq!(
        book_uid(&a, "shared.epub").await,
        book_uid(&b, "shared.epub").await,
        "the two identities converged before the Forget"
    );

    // A forgets; B applies the shared delete, whose id B's renderer holds.
    lifecycle::forget(&a.pool, a_book).await.unwrap();
    run(&a).await;
    b.events.lock().unwrap().clear();
    run(&b).await;
    assert!(
        reloaded(&b),
        "the shared Forget must reload B's renderer instead of leaving both cards"
    );
    assert_eq!(
        reload_marker(&b).await.as_deref(),
        Some("0"),
        "the reload marker is cleared after it emits"
    );
    assert_eq!(
        books::list_books(&b.pool).await.unwrap().len(),
        1,
        "one library card for the file after the shared Forget"
    );

    // A restores; B applies the shared restore, which takes the fresh
    // identity's record away from the card B's renderer is showing.
    let trash = lifecycle::list_trash(&a.pool).await.unwrap();
    let entry = trash.first().expect("A holds the open trash entry");
    lifecycle::restore(&a.pool, entry.id, None).await.unwrap();
    run(&a).await;
    b.events.lock().unwrap().clear();
    run(&b).await;
    assert!(
        reloaded(&b),
        "the shared restore must reload B's renderer too"
    );
    assert_eq!(
        books::list_books(&b.pool).await.unwrap().len(),
        1,
        "one library card for the file after the round trip"
    );
}
