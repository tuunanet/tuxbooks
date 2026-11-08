//! End-to-end tests for cloud-folder sync: two or three real databases
//! sharing one folder, with the real trigger pipeline and engine.

pub use std::path::{Path, PathBuf};
pub use std::sync::{Arc, Mutex};
pub use std::time::{Duration, UNIX_EPOCH};

pub use serde_json::Value;
pub use sha2::{Digest, Sha256};
pub use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
pub use sqlx::SqlitePool;
pub use tempfile::TempDir;

pub use tuxbooks_lib::db::connection::init_pool;
pub use tuxbooks_lib::domain::{
    AnnotationKind, AnnotationPatch, NewAnnotation, NewBook, ProgressUpdate, RestoreMode,
    RestoreStatus,
};
pub use tuxbooks_lib::error::AppError;
pub use tuxbooks_lib::repository::{
    annotations, books, collections, lifecycle, metadata as metadata_repo, reading_progress,
};
pub use tuxbooks_lib::rpc::EventEmitter;
pub use tuxbooks_lib::services::metadata;
pub use tuxbooks_lib::sync::clock;
pub use tuxbooks_lib::sync::engine::{SyncIssueAction, SyncService, SyncState};
pub use tuxbooks_lib::sync::model::{EntityKind, Hlc, Op, OP_SCHEMA};
pub use tuxbooks_lib::sync::waiting;

pub type EmittedEvents = Arc<Mutex<Vec<(&'static str, Value)>>>;

pub struct Device {
    _dir: TempDir,
    pub pool: SqlitePool,
    pub service: SyncService,
    pub db_path: PathBuf,
    pub events: EmittedEvents,
}

pub async fn device() -> Device {
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

pub fn emitted_states(device: &Device) -> Vec<String> {
    device
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| *name == "sync-status")
        .map(|(_, payload)| payload["state"].as_str().unwrap_or_default().to_string())
        .collect()
}

pub async fn connect(device: &Device, folder: &Path) {
    let result = device
        .service
        .connect(folder.to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    assert!(result.mismatch.is_none(), "unexpected mismatch");
}

pub async fn run(device: &Device) {
    device.service.run_pass().await.unwrap();
}

pub fn write_manual_op(folder: &Path, device: &str, name: &str, op: &Op) {
    let dir = folder.join("TuxBooks").join("ops").join(device);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(name), serde_json::to_vec(op).unwrap()).unwrap();
}

pub async fn add_book(device: &Device, name: &str, bytes: &[u8]) -> i64 {
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
    tuxbooks_lib::sync::identity::ensure_book_identity(&device.pool, upserted.file_id)
        .await
        .unwrap();
    books::durable_id_for_file(&device.pool, upserted.file_id)
        .await
        .unwrap()
        .expect("hashed book")
}

/// Committed EPUB bytes, for tests that must pass the real parser.
pub fn fixture_epub(relative: &str) -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)).unwrap()
}

/// Write a file into a device's library without creating a book row, so a
/// test can hand a path to the attach command the way the picker would.
pub fn place_file(device: &Device, name: &str, bytes: &[u8]) -> PathBuf {
    let library = device.db_path.parent().unwrap().join("library");
    std::fs::create_dir_all(&library).unwrap();
    let path = library.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

pub async fn book_id(device: &Device, name: &str) -> i64 {
    let path = device.db_path.parent().unwrap().join("library").join(name);
    books::get_book_by_path(&device.pool, &path.to_string_lossy())
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("book {name} missing"))
        .id
}

/// Give a book mirror state, which is what puts it on another machine's
/// waiting list in the first place.
pub async fn seed_progress(device: &Device, book_id: i64, percent: f64) {
    reading_progress::upsert_progress(
        &device.pool,
        book_id,
        &ProgressUpdate {
            progress_percent: Some(percent),
            ..Default::default()
        },
    )
    .await
    .unwrap();
}

pub async fn file_row_id(device: &Device, name: &str) -> i64 {
    let path = device.db_path.parent().unwrap().join("library").join(name);
    books::find_file_id_by_path(&device.pool, &path.to_string_lossy())
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("file row {name} missing"))
}

pub async fn update_book_bytes(device: &Device, book_id: i64, bytes: &[u8]) {
    let book = books::get_book(&device.pool, book_id)
        .await
        .unwrap()
        .unwrap();
    std::fs::write(&book.path, bytes).unwrap();
    let metadata = std::fs::metadata(&book.path).unwrap();
    let mtime = metadata
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    books::upsert_book(
        &device.pool,
        &NewBook {
            path: book.path.clone(),
            title: book.title,
            subtitle: None,
            author: book.author,
            authors: Vec::new(),
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
    let file_id = books::find_file_id_by_path(&device.pool, &book.path)
        .await
        .unwrap()
        .expect("rewritten file row");
    tuxbooks_lib::sync::identity::ensure_book_identity(&device.pool, file_id)
        .await
        .unwrap();
}

pub async fn add_bookmark(device: &Device, book_id: i64, cfi: &str, _text: &str) -> i64 {
    annotations::insert_annotation(
        &device.pool,
        book_id,
        &NewAnnotation {
            kind: AnnotationKind::Bookmark,
            cfi: Some(cfi.into()),
            chapter_href: Some("chapter1.xhtml".into()),
            page_number: None,
            page_fraction: None,
            text: None,
            color: None,
            geometry: None,
        },
    )
    .await
    .unwrap()
    .id
}

pub async fn annotation_count(device: &Device, book_id: i64) -> usize {
    annotations::list_annotations(&device.pool, book_id)
        .await
        .unwrap()
        .len()
}

pub async fn progress_percent(device: &Device, book_id: i64) -> Option<f64> {
    reading_progress::get_progress(&device.pool, book_id)
        .await
        .unwrap()
        .and_then(|progress| progress.progress_percent)
}

pub async fn book_uid(device: &Device, book_id: i64) -> String {
    books::get_book(&device.pool, book_id)
        .await
        .unwrap()
        .expect("book exists")
        .book_uid
        .expect("book has a uid")
}

pub async fn insert_trash(device: &Device, kind: &str, entity_uid: &str, prior_json: &str) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO sync_trash
            (kind, entity_uid, book_uid, prior_json, deleted_wall, deleted_count,
             deleted_dev, deleted_at, expires_at)
         VALUES (?1, ?2, NULL, ?3, 1, 0, 'test-device', ?4, ?5)
         RETURNING id",
    )
    .bind(kind)
    .bind(entity_uid)
    .bind(prior_json)
    .bind("2026-10-29T00:00:00.000Z")
    .bind("2999-01-01T00:00:00.000Z")
    .fetch_one(&device.pool)
    .await
    .unwrap()
}

pub async fn put_state_entity(pool: &SqlitePool, kind: &str, uid: &str, book_uid: &str) {
    sqlx::query("INSERT INTO sync_state_entities (kind, entity_uid, book_uid) VALUES (?1, ?2, ?3)")
        .bind(kind)
        .bind(uid)
        .bind(book_uid)
        .execute(pool)
        .await
        .unwrap();
}

pub async fn put_state_field(pool: &SqlitePool, kind: &str, uid: &str, field: &str, value: &str) {
    sqlx::query(
        "INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES (?1, ?2, ?3, ?4, 1, 0, 'test-device')",
    )
    .bind(kind)
    .bind(uid)
    .bind(field)
    .bind(value)
    .execute(pool)
    .await
    .unwrap();
}
