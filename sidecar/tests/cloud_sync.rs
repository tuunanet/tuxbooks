//! End-to-end tests for cloud-folder sync: two or three real databases
//! sharing one folder, with the real trigger pipeline and engine.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tempfile::TempDir;

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::{
    AnnotationKind, AnnotationPatch, NewAnnotation, NewBook, ProgressUpdate, RestoreMode,
    RestoreStatus,
};
use tuxbooks_lib::error::AppError;
use tuxbooks_lib::repository::{
    annotations, books, collections, lifecycle, metadata as metadata_repo, reading_progress,
};
use tuxbooks_lib::rpc::EventEmitter;
use tuxbooks_lib::services::metadata;
use tuxbooks_lib::sync::clock;
use tuxbooks_lib::sync::engine::{SyncService, SyncState};
use tuxbooks_lib::sync::model::{EntityKind, Hlc, Op, OP_SCHEMA};
use tuxbooks_lib::sync::waiting;

type EmittedEvents = Arc<Mutex<Vec<(&'static str, Value)>>>;

struct Device {
    _dir: TempDir,
    pool: SqlitePool,
    service: SyncService,
    db_path: PathBuf,
    events: EmittedEvents,
}

/// A copy of the migration set up to and including `max_version`, so an
/// upgrade test can seed the schema the previous release shipped.
async fn migrator_through(dir: &Path, max_version: u64) -> sqlx::migrate::Migrator {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let target = dir.join(format!("migrations-{max_version}"));
    std::fs::create_dir_all(&target).unwrap();
    for entry in std::fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = name
            .strip_prefix('0')
            .and_then(|rest| rest.split('_').next())
            .and_then(|digits| digits.parse::<u64>().ok())
        else {
            continue;
        };
        if version <= max_version {
            std::fs::copy(entry.path(), target.join(&name)).unwrap();
        }
    }
    sqlx::migrate::Migrator::new(target).await.unwrap()
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

fn emitted_states(device: &Device) -> Vec<String> {
    device
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| *name == "sync-status")
        .map(|(_, payload)| payload["state"].as_str().unwrap_or_default().to_string())
        .collect()
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

fn write_manual_op(folder: &Path, device: &str, name: &str, op: &Op) {
    let dir = folder.join("TuxBooks").join("ops").join(device);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(name), serde_json::to_vec(op).unwrap()).unwrap();
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
    tuxbooks_lib::sync::identity::ensure_book_identity(&device.pool, upserted.file_id)
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
        .unwrap_or_else(|| panic!("book {name} missing"))
        .id
}

async fn file_row_id(device: &Device, name: &str) -> i64 {
    let path = device.db_path.parent().unwrap().join("library").join(name);
    books::find_file_id_by_path(&device.pool, &path.to_string_lossy())
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("file row {name} missing"))
}

async fn update_book_bytes(device: &Device, book_id: i64, bytes: &[u8]) {
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

async fn add_bookmark(device: &Device, book_id: i64, cfi: &str, _text: &str) -> i64 {
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

async fn annotation_count(device: &Device, book_id: i64) -> usize {
    annotations::list_annotations(&device.pool, book_id)
        .await
        .unwrap()
        .len()
}

async fn progress_percent(device: &Device, book_id: i64) -> Option<f64> {
    reading_progress::get_progress(&device.pool, book_id)
        .await
        .unwrap()
        .and_then(|progress| progress.progress_percent)
}

async fn book_uid(device: &Device, book_id: i64) -> String {
    books::get_book(&device.pool, book_id)
        .await
        .unwrap()
        .expect("book exists")
        .book_uid
        .expect("book has a uid")
}

async fn insert_trash(device: &Device, kind: &str, entity_uid: &str, prior_json: &str) -> i64 {
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

#[tokio::test(flavor = "multi_thread")]
async fn annotation_written_on_one_machine_appears_on_the_other() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"the exact same book bytes").await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"the exact same book bytes").await;
    run(&b).await;
    run(&b).await;

    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    let listed = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap();
    assert_eq!(
        listed[0].cfi.as_deref(),
        Some("epubcfi(/6/4!/4/2,/1:0,/1:8)")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn two_machines_that_import_the_same_book_before_meeting_converge() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"an independently imported but identical file";
    let a_book = add_book(&a, "same.epub", bytes).await;
    let b_book = add_book(&b, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "a").await;
    add_bookmark(&b, b_book, "epubcfi(/6/4!/4/2,/1:0,/1:9)", "b").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;

    run(&a).await;
    run(&b).await;
    run(&a).await;

    let a_book = book_id(&a, "same.epub").await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(
        annotation_count(&a, a_book).await,
        2,
        "A sees both bookmarks"
    );
    assert_eq!(
        annotation_count(&b, b_book).await,
        2,
        "B sees both bookmarks"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_moves_as_one_locator_and_the_later_write_wins() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"progress book").await;

    reading_progress::upsert_progress(
        &a.pool,
        a_book,
        &ProgressUpdate {
            chapter_href: Some("c1.xhtml".into()),
            progress_percent: Some(10.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"progress book").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(progress_percent(&b, b_book).await, Some(10.0));

    reading_progress::upsert_progress(
        &b.pool,
        b_book,
        &ProgressUpdate {
            chapter_href: Some("c2.xhtml".into()),
            progress_percent: Some(55.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    run(&b).await;
    run(&a).await;
    run(&a).await;

    let a_book = book_id(&a, "same.epub").await;
    assert_eq!(progress_percent(&a, a_book).await, Some(55.0));
    let progress = reading_progress::get_progress(&a.pool, a_book)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(progress.chapter_href.as_deref(), Some("c2.xhtml"));
}

#[tokio::test(flavor = "multi_thread")]
async fn collection_and_membership_survive_the_trip() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"collection book").await;
    let collection = collections::create_collection(&a.pool, "Favorites")
        .await
        .unwrap();
    collections::add_book_to_collection(&a.pool, a_book, collection)
        .await
        .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"collection book").await;
    run(&b).await;
    run(&b).await;

    let summaries = collections::list_collection_summaries(&b.pool)
        .await
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].name, "Favorites");
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(summaries[0].book_ids, vec![b_book]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unwatch_on_one_machine_does_not_delete_the_other_machines_state() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"book that will be unwatched";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);

    books::delete_book(&a.pool, a_book).await.unwrap();
    run(&a).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, b_book).await,
        1,
        "A's local removal must not become a shared delete"
    );

    let _a_book_again = add_book(&a, "same.epub", bytes).await;
    run(&a).await;
    run(&a).await;
    let a_book_again = book_id(&a, "same.epub").await;
    assert_eq!(
        annotation_count(&a, a_book_again).await,
        1,
        "the annotation returns when the same content is re-imported"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_and_corrupt_operation_files_are_tolerated() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"duplicate ops").await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let root = sync_dir.path().join("TuxBooks");
    let op_dir = root.join("ops");
    let mut op_files = Vec::new();
    for entry in std::fs::read_dir(&op_dir).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            for file in std::fs::read_dir(entry.path()).unwrap() {
                op_files.push(file.unwrap().path());
            }
        }
    }
    assert!(!op_files.is_empty());
    let first = op_files[0].clone();
    std::fs::copy(&first, first.with_file_name("conflict copy.json")).unwrap();
    let corrupt_dir = op_dir.join("b".repeat(32));
    std::fs::create_dir_all(&corrupt_dir).unwrap();
    std::fs::write(corrupt_dir.join("broken.json"), b"{not json").unwrap();
    std::fs::write(corrupt_dir.join("oversized.json"), vec![b' '; 1_100_000]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&first, corrupt_dir.join("linked.json")).unwrap();

    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"duplicate ops").await;
    run(&b).await;
    run(&b).await;

    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1,
        "a conflict copy must not duplicate the annotation"
    );
    let issues = b.service.issues().await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.file_name.is_some()),
        "the corrupt file must surface as an issue"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restored_bookmark_is_available_for_thirty_days() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let a_book = add_book(&a, "same.epub", b"trash book").await;
    let annotation_id = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    annotations::delete_annotation(&a.pool, annotation_id)
        .await
        .unwrap();
    run(&a).await;
    let trash = a.service.trash().await.unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].kind, "annotation");

    assert!(a.service.restore(trash[0].id).await.unwrap());
    run(&a).await;
    assert_eq!(annotation_count(&a, a_book).await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_override_authors_and_cover_travel_together() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let _a_book = add_book(&a, "same.epub", b"metadata book").await;

    let covers = a.db_path.parent().unwrap().join("covers");
    std::fs::create_dir_all(&covers).unwrap();
    let cover_name = "0123456789abcdef.png";
    let cover_bytes = b"\x89PNG\r\n\x1a\nnot-a-real-png-but-bytes";
    std::fs::write(covers.join(cover_name), cover_bytes).unwrap();

    let overrides = metadata_repo::OverrideRow {
        title: Some("Curated title".into()),
        authors_customized: true,
        subjects_customized: true,
        cover_path: Some(covers.join(cover_name).to_string_lossy().into_owned()),
        ..metadata_repo::OverrideRow::default()
    };
    metadata::apply_synced_overrides(
        &a.pool,
        book_id(&a, "same.epub").await,
        &overrides,
        &["Alice".into(), "Bob".into()],
        &["Essays".into()],
    )
    .await
    .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"metadata book").await;
    run(&b).await;
    run(&b).await;

    let b_book = book_id(&b, "same.epub").await;
    let book = books::get_book(&b.pool, b_book).await.unwrap().unwrap();
    assert_eq!(book.title, "Curated title");
    assert_eq!(book.author.as_deref(), Some("Alice, Bob"));
    let book_uid = book.book_uid.clone().expect("book uid");
    let authors = metadata_repo::list_book_authors(&b.pool, &book_uid)
        .await
        .unwrap();
    assert_eq!(authors, vec!["Alice".to_string(), "Bob".to_string()]);
    let cover_path = book.cover_path.expect("cover override projected");
    assert!(
        Path::new(&cover_path).exists(),
        "cover blob must be copied into B's cache"
    );
    assert_eq!(std::fs::read(&cover_path).unwrap(), cover_bytes);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rewritten_file_keeps_its_book_identity() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"version one").await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"version one").await;
    run(&b).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1
    );

    // Simulate a metadata embed on A: same row, new bytes.
    let a_book = book_id(&a, "same.epub").await;
    update_book_bytes(&a, a_book, b"version two with new metadata").await;
    run(&a).await;
    run(&a).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&a, book_id(&a, "same.epub").await).await,
        1,
        "the rewriting device keeps its book"
    );
    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1,
        "the other device keeps the annotation under the old alias"
    );

    // B's cloud client eventually delivers the rewritten bytes.
    let b_book = book_id(&b, "same.epub").await;
    update_book_bytes(&b, b_book, b"version two with new metadata").await;
    run(&b).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1,
        "the new hash alias resolves to the same book"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_library_mismatch_requires_confirmation_then_merges() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;
    let remote_id = a.service.status().await.unwrap().library_id.unwrap();
    clock::set_meta(
        &b.pool,
        clock::META_LIBRARY_ID,
        "0123456789abcdef0123456789abcdef",
    )
    .await
    .unwrap();

    let result = b
        .service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    let mismatch = result.mismatch.expect("mismatch surfaced");
    assert_eq!(mismatch.remote_library_id, remote_id);

    let confirmed = b
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            None,
            Some(remote_id.clone()),
            false,
        )
        .await
        .unwrap();
    assert!(confirmed.mismatch.is_none());
    assert_eq!(
        confirmed.status.library_id.as_deref(),
        Some(remote_id.as_str())
    );
    assert!(confirmed.status.enabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_folder_is_adopted_without_a_mismatch() {
    let sync_dir = tempfile::tempdir().unwrap();
    let b = device().await;
    let old_id = "0123456789abcdef0123456789abcdef";
    clock::set_meta(&b.pool, clock::META_LIBRARY_ID, old_id)
        .await
        .unwrap();

    let result = b
        .service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();

    assert!(
        result.mismatch.is_none(),
        "a freshly created library must be adopted, not treated as another one"
    );
    let library_id = result.status.library_id.clone().expect("library id");
    assert_ne!(library_id, old_id);
    assert!(result.status.enabled);
    let library: Value = serde_json::from_str(
        &std::fs::read_to_string(sync_dir.path().join("TuxBooks/library.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(library["library_id"], library_id);
}

#[tokio::test(flavor = "multi_thread")]
async fn starting_a_new_library_archives_the_existing_one() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let old_id = a.service.status().await.unwrap().library_id.unwrap();

    let b = device().await;
    clock::set_meta(&b.pool, clock::META_LIBRARY_ID, &old_id)
        .await
        .unwrap();

    let result = b
        .service
        .connect(sync_dir.path().to_str().unwrap(), None, None, true)
        .await
        .unwrap();

    assert!(result.mismatch.is_none());
    let new_id = result.status.library_id.clone().expect("new library id");
    assert_ne!(new_id, old_id);
    let archived = result
        .archived_library_path
        .expect("the old library path is reported");
    let archived_library: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(&archived).join("library.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(archived_library["library_id"], old_id);
    assert!(sync_dir.path().join("TuxBooks/library.json").exists());
    let current: Value = serde_json::from_str(
        &std::fs::read_to_string(sync_dir.path().join("TuxBooks/library.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(current["library_id"], new_id);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_waiting_book_can_be_hidden_on_one_machine_and_still_attach_later() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"waiting book bytes";
    let a_book = add_book(&a, "waiting.epub", bytes).await;
    reading_progress::upsert_progress(
        &a.pool,
        a_book,
        &ProgressUpdate {
            progress_percent: Some(42.0),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    annotations::insert_annotation(
        &a.pool,
        a_book,
        &NewAnnotation {
            kind: AnnotationKind::Highlight,
            cfi: Some("epubcfi(/6/4)".into()),
            chapter_href: Some("chapter1.xhtml".into()),
            page_number: None,
            page_fraction: None,
            text: Some("sample highlight".into()),
            color: Some("yellow".into()),
            geometry: None,
        },
    )
    .await
    .unwrap();
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    run(&b).await;
    let waiting_books = waiting::list(&b.pool).await.unwrap();
    assert_eq!(waiting_books.len(), 1);
    let waiting_book = &waiting_books[0];
    assert_eq!(waiting_book.annotation_count, 1);
    assert_eq!(waiting_book.progress_percent, Some(42.0));
    assert_eq!(
        waiting_book.sample_annotation.as_deref(),
        Some("sample highlight")
    );
    assert_eq!(b.service.status().await.unwrap().waiting_books, 1);

    assert!(b
        .service
        .forget_waiting_book(&waiting_book.book_uid)
        .await
        .unwrap());
    assert!(waiting::list(&b.pool).await.unwrap().is_empty());
    assert_eq!(b.service.status().await.unwrap().waiting_books, 0);

    // Hiding the waiting state is local. Importing the same bytes still joins
    // the mirror state to the book.
    add_book(&b, "waiting.epub", bytes).await;
    run(&b).await;
    let b_book = book_id(&b, "waiting.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    assert_eq!(progress_percent(&b, b_book).await, Some(42.0));
}

#[tokio::test(flavor = "multi_thread")]
async fn all_waiting_books_can_be_hidden_at_once() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let one = add_book(&a, "one.epub", b"one").await;
    let two = add_book(&a, "two.epub", b"two").await;
    for (book_id, percent) in [(one, 10.0), (two, 20.0)] {
        reading_progress::upsert_progress(
            &a.pool,
            book_id,
            &ProgressUpdate {
                progress_percent: Some(percent),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    run(&b).await;
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 2);
    assert_eq!(b.service.status().await.unwrap().waiting_books, 2);

    assert_eq!(waiting::forget_all(&b.pool).await.unwrap(), 2);
    assert!(waiting::list(&b.pool).await.unwrap().is_empty());
    assert_eq!(b.service.status().await.unwrap().waiting_books, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn same_named_collections_merge_instead_of_duplicating() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"same shelf").await;
    let b_book = add_book(&b, "same.epub", b"same shelf").await;
    let a_collection = collections::create_collection(&a.pool, "Favorites")
        .await
        .unwrap();
    let b_collection = collections::create_collection(&b.pool, "Favorites")
        .await
        .unwrap();
    collections::add_book_to_collection(&a.pool, a_book, a_collection)
        .await
        .unwrap();
    collections::add_book_to_collection(&b.pool, b_book, b_collection)
        .await
        .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    run(&a).await;
    run(&b).await;

    for device in [&a, &b] {
        let summaries = collections::list_collection_summaries(&device.pool)
            .await
            .unwrap();
        assert_eq!(summaries.len(), 1, "one shelf, not two");
        assert_eq!(summaries[0].name, "Favorites");
        assert_eq!(summaries[0].book_ids.len(), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_note_edits_pick_one_winner_and_keep_the_loser() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"conflict book").await;
    let annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"conflict book").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    let b_annotation = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap()[0]
        .id;

    annotations::update_annotation(
        &a.pool,
        annotation,
        &AnnotationPatch {
            color: None,
            label: None,
            note: Some("A's note".into()),
        },
    )
    .await
    .unwrap();
    annotations::update_annotation(
        &b.pool,
        b_annotation,
        &AnnotationPatch {
            color: None,
            label: None,
            note: Some("B's note".into()),
        },
    )
    .await
    .unwrap();

    run(&b).await;
    run(&a).await;
    run(&a).await;
    run(&b).await;

    let a_note = annotations::list_annotations(&a.pool, book_id(&a, "same.epub").await)
        .await
        .unwrap()[0]
        .note
        .clone();
    let b_note = annotations::list_annotations(&b.pool, book_id(&b, "same.epub").await)
        .await
        .unwrap()[0]
        .note
        .clone();
    assert_eq!(a_note, b_note, "both devices converge");
    assert!(a_note.as_deref() == Some("A's note") || a_note.as_deref() == Some("B's note"));
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert!(conflicts >= 1, "the losing note is kept as a conflict");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_that_is_not_a_directory_is_rejected() {
    let a = device().await;
    let file = tempfile::NamedTempFile::new().unwrap();
    let err = a
        .service
        .connect(file.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn operations_are_ordered_by_clock_not_by_file_name() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let a_book = add_book(&a, "same.epub", b"out of order").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let book_uid: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_row_id(&a, "same.epub").await)
            .fetch_one(&a.pool)
            .await
            .unwrap();

    let manual_device = "c".repeat(32);
    let manual_dir = sync_dir
        .path()
        .join("TuxBooks")
        .join("ops")
        .join(&manual_device);
    std::fs::create_dir_all(&manual_dir).unwrap();
    let entity_uid = "a".repeat(32);
    let make = |op_id: &str, wall: i64, note: &str| Op {
        schema: OP_SCHEMA,
        op_id: op_id.to_string(),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::Annotation,
        entity_uid: entity_uid.clone(),
        book_uid: Some(book_uid.clone()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({
            "kind": "bookmark",
            "cfi": "epubcfi(/6/4)",
            "note": note,
        })
        .as_object()
        .cloned()
        .unwrap(),
        prior: None,
        created_at: "2026-10-28T00:00:00.000Z".into(),
    };
    // The newer clock deliberately sorts first: the merge, not the directory
    // listing, must decide the winner.
    std::fs::write(
        manual_dir.join("00000000000000000001.json"),
        serde_json::to_vec(&make("1".repeat(32).as_str(), 200, "newer")).unwrap(),
    )
    .unwrap();
    std::fs::write(
        manual_dir.join("99999999999999999999.json"),
        serde_json::to_vec(&make("2".repeat(32).as_str(), 100, "older")).unwrap(),
    )
    .unwrap();

    run(&a).await;
    run(&a).await;
    let listed = annotations::list_annotations(&a.pool, a_book)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].note.as_deref(), Some("newer"));
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert!(conflicts >= 1, "the older value is preserved");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disappearing_folder_becomes_a_sync_issue() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    drop(sync_dir);
    let err = a.service.run_pass().await.unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
    let issues = a.service.issues().await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "sync_failed"),
        "a folder failure must surface in Sync issues: {issues:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_one_copy_keeps_the_book_and_its_state() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let first = add_book(&a, "copy-one.epub", b"duplicate content").await;
    let second = add_book(&a, "copy-two.epub", b"duplicate content").await;
    add_bookmark(&a, first, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    run(&a).await;

    assert_eq!(first, second, "duplicate bytes share one durable book");
    assert_eq!(annotation_count(&a, first).await, 1);
    let issues = a.service.issues().await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "duplicate_book"),
        "the duplicate copy is named in Sync issues: {issues:?}"
    );

    // Removing one location ends that copy's membership only.
    let first_file = file_row_id(&a, "copy-one.epub").await;
    books::delete_file_row(&a.pool, first_file).await.unwrap();
    run(&a).await;
    run(&a).await;

    assert_eq!(
        annotation_count(&a, second).await,
        1,
        "the remaining copy keeps the shared state"
    );
    assert_eq!(
        book_id(&a, "copy-two.epub").await,
        second,
        "the surviving copy is still in the library"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn forget_on_one_machine_is_a_shared_delete_and_restores_on_the_other() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"book that will be forgotten";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    reading_progress::upsert_progress(
        &a.pool,
        a_book,
        &ProgressUpdate {
            chapter_href: Some("c1.xhtml".into()),
            progress_percent: Some(44.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    assert_eq!(progress_percent(&b, b_book).await, Some(44.0));
    // The two identities converge during the first trip; Forget acts on the
    // canonical uuid, not the one this device minted before meeting.
    run(&a).await;
    let a_book = book_id(&a, "same.epub").await;
    let old_uid = book_uid(&a, a_book).await;

    let outcome = lifecycle::forget(&a.pool, a_book).await.unwrap();
    let replacement = outcome.replacement_book_id.expect("file stays");
    assert!(!book_uid(&a, replacement).await.is_empty());

    run(&a).await;
    run(&b).await;
    run(&b).await;

    // B's old identity is gone, and the file is a fresh unread book.
    let b_fresh = book_id(&b, "same.epub").await;
    assert_ne!(book_uid(&b, b_fresh).await, old_uid);
    assert_eq!(annotation_count(&b, b_fresh).await, 0);
    assert_eq!(progress_percent(&b, b_fresh).await, None);
    let old_aliases: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(&old_uid)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(old_aliases, 0, "the forgotten identity owns no alias");

    let trash = lifecycle::list_trash(&b.pool).await.unwrap();
    let entry = trash
        .iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("the shared Forget appears in B's Reading history trash");
    let restored = lifecycle::restore(&b.pool, entry.id, None).await.unwrap();
    assert_eq!(restored.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(progress_percent(&b, b_book).await, Some(44.0));
    assert_eq!(annotation_count(&b, b_book).await, 1);

    run(&b).await;
    run(&a).await;
    run(&a).await;

    let a_restored = book_id(&a, "same.epub").await;
    assert_eq!(book_uid(&a, a_restored).await, old_uid);
    assert_eq!(progress_percent(&a, a_restored).await, Some(44.0));
    assert_eq!(annotation_count(&a, a_restored).await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_no_file_forget_still_propagates_and_restores_on_the_machine_with_the_file() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"forgotten from reading history";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    // Let A consume B's identity operation before capturing the canonical ids.
    run(&a).await;
    let a_book = book_id(&a, "same.epub").await;
    let old_uid = book_uid(&a, a_book).await;

    // A drops its membership, then forgets the book from Reading history.
    books::delete_book(&a.pool, a_book).await.unwrap();
    run(&a).await;
    let outcome = lifecycle::forget(&a.pool, a_book).await.unwrap();
    assert!(outcome.replacement_book_id.is_none());

    run(&a).await;
    run(&b).await;
    run(&b).await;

    // B still has the bytes, so it keeps a fresh unread entry and the old
    // identity moves to B's trash.
    let b_fresh = book_id(&b, "same.epub").await;
    assert_ne!(book_uid(&b, b_fresh).await, old_uid);
    assert_eq!(annotation_count(&b, b_fresh).await, 0);
    let trash = lifecycle::list_trash(&b.pool).await.unwrap();
    let entry = trash
        .iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("a remote Forget with no sender file is still restorable");
    let restored = lifecycle::restore(&b.pool, entry.id, None).await.unwrap();
    assert_eq!(restored.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(annotation_count(&b, b_book).await, 1);

    // A has no file, so the restore returns the book to A's Reading history.
    run(&b).await;
    run(&a).await;
    run(&a).await;
    let history = books::list_reading_history(&a.pool, None).await.unwrap();
    let restored_a = history
        .iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("A's reading history has the restored identity");
    assert_eq!(restored_a.annotation_count, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn upgrade_preserves_mirror_clocks_and_does_not_rebaseline() {
    const OLD_UID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let library_id = a.service.status().await.unwrap().library_id.unwrap();

    // A database created by the previous release, with mirror state and
    // clocks that must survive the upgrade untouched.
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let old = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    migrator_through(tmp.path(), 22)
        .await
        .run(&old)
        .await
        .unwrap();
    sqlx::query("INSERT INTO book_records (uid, title) VALUES (?1, 'Upgraded')")
        .bind(OLD_UID)
        .execute(&old)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_state_entities
            (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device)
         VALUES ('progress', ?1, ?1, 111, 2, 'previous-device')",
    )
    .bind(OLD_UID)
    .execute(&old)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES ('progress', ?1, 'progress_percent', '42.5', 111, 2, 'previous-device')",
    )
    .bind(OLD_UID)
    .execute(&old)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
        .bind("b".repeat(32))
        .bind(OLD_UID)
        .execute(&old)
        .await
        .unwrap();
    for (key, value) in [
        ("baseline_done", "1".to_string()),
        ("enabled", "1".to_string()),
        ("library_id", library_id),
        (
            "folder_path",
            sync_dir.path().to_string_lossy().into_owned(),
        ),
    ] {
        sqlx::query("INSERT INTO sync_meta (key, value) VALUES (?1, ?2)")
            .bind(key)
            .bind(value)
            .execute(&old)
            .await
            .unwrap();
    }
    old.close().await;

    let upgraded = init_pool(&db_path).await.unwrap();
    let clock: (i64, i64, String, String) = sqlx::query_as(
        "SELECT hlc_wall, hlc_counter, hlc_device, value_json
         FROM sync_state_fields WHERE kind = 'progress' AND entity_uid = ?1",
    )
    .bind(OLD_UID)
    .fetch_one(&upgraded)
    .await
    .unwrap();
    assert_eq!(clock, (111, 2, "previous-device".into(), "42.5".into()));
    let baseline: String =
        sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'baseline_done'")
            .fetch_one(&upgraded)
            .await
            .unwrap();
    assert_eq!(baseline, "1", "the upgrade must not force a re-baseline");
    let merges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_merges")
        .fetch_one(&upgraded)
        .await
        .unwrap();
    assert_eq!(merges, 1, "merged identities survive the upgrade");
    let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
        .fetch_one(&upgraded)
        .await
        .unwrap();
    assert_eq!(dirty, 0, "the migration does not touch local state");

    // An older remote write must lose to the preserved clock.
    let root = sync_dir.path().join("TuxBooks");
    let manual_device = "c".repeat(32);
    let manual_dir = root.join("ops").join(&manual_device);
    std::fs::create_dir_all(&manual_dir).unwrap();
    let op = Op {
        schema: OP_SCHEMA,
        op_id: "d".repeat(32),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall: 50,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::Progress,
        entity_uid: OLD_UID.into(),
        book_uid: Some(OLD_UID.into()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({ "progress_percent": 5.0 })
            .as_object()
            .cloned()
            .unwrap(),
        prior: None,
        created_at: "2026-10-01T00:00:00.000Z".into(),
    };
    std::fs::write(
        manual_dir.join("00000000000000000050.json"),
        serde_json::to_vec(&op).unwrap(),
    )
    .unwrap();

    let events = EventEmitter::new(|_name: &'static str, _payload: Value| {});
    let service = SyncService::new(upgraded.clone(), &db_path, events)
        .await
        .unwrap();
    service.run_pass().await.unwrap();

    let after: (i64, i64, String, String) = sqlx::query_as(
        "SELECT hlc_wall, hlc_counter, hlc_device, value_json
         FROM sync_state_fields WHERE kind = 'progress' AND entity_uid = ?1",
    )
    .bind(OLD_UID)
    .fetch_one(&upgraded)
    .await
    .unwrap();
    assert_eq!(after, clock, "the preserved clock still wins after a pass");
    let baseline: String =
        sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'baseline_done'")
            .fetch_one(&upgraded)
            .await
            .unwrap();
    assert_eq!(baseline, "1", "running the engine does not re-baseline");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stale_alias_or_edit_cannot_resurrect_a_forgotten_identity() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"forget then replay stale ops";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    run(&a).await;
    let a_book = book_id(&a, "same.epub").await;
    let old_uid = book_uid(&a, a_book).await;

    lifecycle::forget(&a.pool, a_book).await.unwrap();
    run(&a).await;
    run(&b).await;
    run(&b).await;
    let fresh_uid = book_uid(&b, book_id(&b, "same.epub").await).await;
    assert_ne!(fresh_uid, old_uid);

    // A device that had not seen the Forget yet replays an old identity alias
    // and a stale progress edit with a newer clock.
    let manual_device = "e".repeat(32);
    let stale_hash = "f".repeat(64);
    let identity = Op {
        schema: OP_SCHEMA,
        op_id: "1".repeat(32),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall: 9_000_000_000_000,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::BookIdentity,
        entity_uid: old_uid.clone(),
        book_uid: Some(old_uid.clone()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({ "content_hash": stale_hash })
            .as_object()
            .cloned()
            .unwrap(),
        prior: None,
        created_at: "2026-10-01T00:00:00.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &manual_device,
        "00000000000000000001.json",
        &identity,
    );
    let edit = Op {
        schema: OP_SCHEMA,
        op_id: "2".repeat(32),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall: 9_000_000_000_001,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::Progress,
        entity_uid: old_uid.clone(),
        book_uid: Some(old_uid.clone()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({ "progress_percent": 99.0 })
            .as_object()
            .cloned()
            .unwrap(),
        prior: None,
        created_at: "2026-10-01T00:00:01.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &manual_device,
        "00000000000000000002.json",
        &edit,
    );
    run(&b).await;
    run(&b).await;

    let old_records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(old_records, 0, "the forgotten identity stays deleted");
    let alias_owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&stale_hash)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(
        alias_owner, fresh_uid,
        "a stale alias resolves to the fresh identity, never the old one"
    );
    let fresh = book_id(&b, "same.epub").await;
    assert_eq!(progress_percent(&b, fresh).await, None);
    assert_eq!(annotation_count(&b, fresh).await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn keep_resolution_closes_the_remote_trash_without_restoring_the_old_identity() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"keep the fresh book";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "old").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    run(&a).await;
    let a_book = book_id(&a, "same.epub").await;
    let old_uid = book_uid(&a, a_book).await;

    lifecycle::forget(&a.pool, a_book).await.unwrap();
    run(&a).await;
    run(&b).await;
    run(&b).await;

    let b_fresh = book_id(&b, "same.epub").await;
    let fresh_uid = book_uid(&b, b_fresh).await;
    reading_progress::upsert_progress(
        &b.pool,
        b_fresh,
        &ProgressUpdate {
            progress_percent: Some(12.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    let entry = lifecycle::list_trash(&b.pool)
        .await
        .unwrap()
        .into_iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("remote trash entry");
    let outcome = lifecycle::restore(&b.pool, entry.id, Some(RestoreMode::Keep))
        .await
        .unwrap();
    assert_eq!(outcome.status, RestoreStatus::Kept);

    run(&b).await;
    run(&a).await;
    run(&a).await;
    assert!(
        lifecycle::list_trash(&b.pool).await.unwrap().is_empty(),
        "Keep closes B's trash entry"
    );
    assert!(
        lifecycle::list_trash(&a.pool).await.unwrap().is_empty(),
        "Keep propagates and closes A's copy too"
    );
    assert_eq!(book_uid(&b, b_fresh).await, fresh_uid);
    assert_eq!(progress_percent(&b, b_fresh).await, Some(12.0));
    let old_records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(old_records, 0, "Keep never recreates the old identity");
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_disconnect_and_rename_are_visible_in_status() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;

    let initial = a.service.status().await.unwrap();
    assert!(!initial.enabled);
    assert_eq!(initial.state, SyncState::Disabled);
    assert_eq!(initial.folder, None);

    let connected = a
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            Some("Desk".into()),
            None,
            false,
        )
        .await
        .unwrap();
    assert!(connected.mismatch.is_none());
    assert!(connected.status.enabled);
    assert_eq!(connected.status.state, SyncState::Idle);
    assert_eq!(connected.status.device_name.as_deref(), Some("Desk"));
    assert!(connected.status.library_id.is_some());
    let expected_folder = std::fs::canonicalize(sync_dir.path()).unwrap();
    assert_eq!(
        connected.status.folder.as_deref(),
        Some(expected_folder.to_string_lossy().as_ref())
    );

    let renamed = a.service.set_device_name("  Study  ").await.unwrap();
    assert_eq!(renamed.device_name.as_deref(), Some("Study"));
    let device_file = sync_dir
        .path()
        .join("TuxBooks/devices")
        .join(renamed.device_id.as_deref().unwrap())
        .join("device.json");
    let device_json: Value =
        serde_json::from_str(&std::fs::read_to_string(device_file).unwrap()).unwrap();
    assert_eq!(device_json["name"], "Study");

    let blank = a.service.set_device_name("   ").await.unwrap_err();
    assert!(matches!(blank, AppError::InvalidInput(_)), "got {blank:?}");
    let too_long = a
        .service
        .set_device_name(&"x".repeat(81))
        .await
        .unwrap_err();
    assert!(
        matches!(too_long, AppError::InvalidInput(_)),
        "got {too_long:?}"
    );

    let off = a.service.disconnect().await.unwrap();
    assert!(!off.enabled);
    assert_eq!(off.state, SyncState::Disabled);
    let after = a.service.sync_now().await.unwrap();
    assert!(!after.enabled);
    assert_eq!(after.state, SyncState::Disabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_rejects_bad_paths_names_and_read_only_folders() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;

    let relative = a
        .service
        .connect("relative/sync", None, None, false)
        .await
        .unwrap_err();
    assert!(
        matches!(relative, AppError::InvalidInput(_)),
        "got {relative:?}"
    );

    let missing = sync_dir.path().join("does-not-exist");
    let err = a
        .service
        .connect(missing.to_str().unwrap(), None, None, false)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");

    let empty_name = a
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            Some("   ".into()),
            None,
            false,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(empty_name, AppError::InvalidInput(_)),
        "got {empty_name:?}"
    );

    let long_name = a
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            Some("x".repeat(81)),
            None,
            false,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(long_name, AppError::InvalidInput(_)),
        "got {long_name:?}"
    );

    connect(&a, sync_dir.path()).await;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let root = sync_dir.path().join("TuxBooks");
        let original = std::fs::metadata(&root).unwrap().permissions();
        let mut read_only = original.clone();
        read_only.set_mode(0o555);
        std::fs::set_permissions(&root, read_only).unwrap();
        let still_writable = std::fs::write(root.join(".write-check"), b"x").is_ok();
        if still_writable {
            let _ = std::fs::remove_file(root.join(".write-check"));
        }
        let result = a
            .service
            .connect(sync_dir.path().to_str().unwrap(), None, None, false)
            .await;
        if still_writable {
            let connected = result.expect("a folder that is still writable connects");
            assert!(
                connected.status.enabled,
                "the folder was never actually read-only"
            );
        } else {
            let err = result.unwrap_err();
            assert!(err.to_string().contains("not writable"), "got {err}");
        }
        std::fs::set_permissions(&root, original).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_reports_syncing_then_idle_and_refreshes_aggregate_counts() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "status.epub", b"status book").await;
    let bookmark = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "note").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    annotations::delete_annotation(&a.pool, bookmark)
        .await
        .unwrap();
    let op_dir = sync_dir.path().join("TuxBooks/ops").join("f".repeat(32));
    std::fs::create_dir_all(&op_dir).unwrap();
    std::fs::write(op_dir.join("broken.json"), b"{not json").unwrap();
    a.events.lock().unwrap().clear();

    run(&a).await;

    let states = emitted_states(&a);
    assert!(
        states.iter().any(|state| state == "syncing"),
        "the pass announces it is syncing: {states:?}"
    );
    assert_eq!(states.last().map(String::as_str), Some("idle"));

    let status = a.service.status().await.unwrap();
    assert_eq!(status.state, SyncState::Idle);
    assert_eq!(status.pending_local, 0);
    assert!(status.issues >= 1, "the corrupt file is counted");
    assert!(status.trash >= 1, "the deleted bookmark is counted");
    assert_eq!(
        status.issues as usize,
        a.service.issues().await.unwrap().len()
    );
    assert_eq!(
        status.trash as usize,
        a.service.trash().await.unwrap().len()
    );
    assert_eq!(
        status.waiting_books as usize,
        a.service.waiting_books().await.unwrap().len()
    );
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(status.conflicts, conflicts);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_does_nothing_when_disabled_or_the_folder_is_unset() {
    let a = device().await;

    a.service.run_pass().await.unwrap();
    assert_eq!(a.service.status().await.unwrap().state, SyncState::Disabled);

    clock::set_meta(&a.pool, clock::META_ENABLED, "1")
        .await
        .unwrap();
    a.service.run_pass().await.unwrap();
    let status = a.service.status().await.unwrap();
    assert!(status.enabled);
    assert_eq!(status.folder, None);
    assert_eq!(status.state, SyncState::Idle);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_or_corrupt_library_file_fails_the_pass_and_recovers() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let library = sync_dir.path().join("TuxBooks/library.json");
    let saved = std::fs::read(&library).unwrap();

    std::fs::remove_file(&library).unwrap();
    let missing = a.service.run_pass().await.unwrap_err();
    assert!(
        missing.to_string().contains("missing library.json"),
        "got {missing}"
    );
    let failed = a.service.status().await.unwrap();
    assert_eq!(failed.state, SyncState::Error);
    assert!(failed.last_error.is_some());
    assert!(failed.issues >= 1);
    assert!(a
        .service
        .issues()
        .await
        .unwrap()
        .iter()
        .any(|issue| issue.kind == "sync_failed"));

    std::fs::write(&library, b"{not json").unwrap();
    let corrupt = a.service.run_pass().await.unwrap_err();
    assert!(
        matches!(corrupt, AppError::InvalidInput(_)),
        "got {corrupt:?}"
    );

    std::fs::write(&library, saved).unwrap();
    run(&a).await;
    let recovered = a.service.status().await.unwrap();
    assert_eq!(recovered.state, SyncState::Idle);
    assert_eq!(recovered.last_error, None);
    assert!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .all(|issue| issue.kind != "sync_failed"),
        "the recovered pass resolves its sync issue"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_issues_can_be_dismissed_one_by_one_or_all_at_once() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;

    let op_dir = sync_dir.path().join("TuxBooks/ops").join("f".repeat(32));
    std::fs::create_dir_all(&op_dir).unwrap();
    std::fs::write(op_dir.join("one.json"), b"{not json").unwrap();
    std::fs::write(op_dir.join("two.json"), b"{still not json").unwrap();

    run(&a).await;
    let issues = a.service.issues().await.unwrap();
    assert_eq!(issues.len(), 2, "one issue per rejected file: {issues:?}");

    assert!(a.service.dismiss_issue(issues[0].id).await.unwrap());
    assert!(
        !a.service.dismiss_issue(issues[0].id).await.unwrap(),
        "an already dismissed issue is not dismissed twice"
    );
    assert_eq!(a.service.dismiss_all_issues().await.unwrap(), 1);
    assert!(a.service.issues().await.unwrap().is_empty());
    assert_eq!(a.service.status().await.unwrap().issues, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_corrupt_operation_is_retried_then_given_up() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let op_dir = sync_dir.path().join("TuxBooks/ops").join("f".repeat(32));
    std::fs::create_dir_all(&op_dir).unwrap();
    let op_path = op_dir.join("broken.json");

    // There is no backoff: every pass retries the file until FILE_RETRY_LIMIT
    // (5) is reached, then caches it as given up.
    std::fs::write(&op_path, b"{not json").unwrap();
    run(&a).await;
    let retrying = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "operation_retrying")
        .expect("the first failure is retried");
    assert!(retrying.detail.contains("attempt 1"), "{}", retrying.detail);

    // A changed file starts a fresh attempt count instead of carrying the
    // previous file's failures forward.
    std::fs::write(&op_path, b"{still not valid json").unwrap();
    run(&a).await;
    let reset = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "operation_retrying")
        .expect("the replacement file is retried");
    assert!(reset.detail.contains("attempt 1"), "{}", reset.detail);

    for _ in 0..4 {
        run(&a).await;
    }
    let issues = a.service.issues().await.unwrap();
    let rejected = issues
        .iter()
        .find(|issue| issue.kind == "operation_rejected")
        .expect("the file is given up after the retry limit");
    assert!(
        rejected.detail.contains("gave up after 5 attempts"),
        "{}",
        rejected.detail
    );

    // A given-up file is cached and no longer reported every pass.
    run(&a).await;
    assert_eq!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .filter(|issue| issue.file_name.as_deref()
                == Some("ops/ffffffffffffffffffffffffffffffff/broken.json"))
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_with_a_missing_or_oversized_cover_still_applies() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let root = sync_dir.path().join("TuxBooks");
    let device = "f".repeat(32);
    let book_uid = "a".repeat(32);
    let missing_cover = "0123456789abcdef.png";

    let missing = Op {
        schema: OP_SCHEMA,
        op_id: "1".repeat(32),
        device_id: device.clone(),
        hlc: Hlc {
            wall: 10,
            counter: 0,
            device: device.clone(),
        },
        kind: EntityKind::Metadata,
        entity_uid: book_uid.clone(),
        book_uid: Some(book_uid.clone()),
        deleted: false,
        restore: false,
        fields: json!({
            "title": "Missing cover",
            "cover_path": missing_cover,
        })
        .as_object()
        .cloned()
        .unwrap(),
        prior: None,
        created_at: "2026-10-29T00:00:00.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &device,
        "00000000000000000001.json",
        &missing,
    );
    run(&a).await;
    let issues = a.service.issues().await.unwrap();
    let cover_issue = issues
        .iter()
        .find(|issue| issue.kind == "cover_missing")
        .expect("a missing cover is reported");
    assert!(
        cover_issue.detail.contains("not in the sync folder yet"),
        "{}",
        cover_issue.detail
    );

    let oversized_cover = "fedcba9876543210.png";
    let blob_dir = root.join("blobs/covers");
    std::fs::create_dir_all(&blob_dir).unwrap();
    let oversized = std::fs::File::create(blob_dir.join(oversized_cover)).unwrap();
    oversized.set_len(16 * 1024 * 1024 + 1).unwrap();
    let oversized_op = Op {
        schema: OP_SCHEMA,
        op_id: "2".repeat(32),
        device_id: device.clone(),
        hlc: Hlc {
            wall: 11,
            counter: 0,
            device: device.clone(),
        },
        kind: EntityKind::Metadata,
        entity_uid: book_uid.clone(),
        book_uid: Some(book_uid),
        deleted: false,
        restore: false,
        fields: json!({
            "title": "Oversized cover",
            "cover_path": oversized_cover,
        })
        .as_object()
        .cloned()
        .unwrap(),
        prior: None,
        created_at: "2026-10-29T00:00:01.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &device,
        "00000000000000000002.json",
        &oversized_op,
    );
    run(&a).await;
    let issues = a.service.issues().await.unwrap();
    let oversized_issue = issues
        .iter()
        .find(|issue| issue.detail.contains("could not read cover"))
        .expect("an unreadable cover is reported");
    assert_eq!(oversized_issue.kind, "cover_missing");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_identity_sweep_binds_new_books_and_skips_unreadable_ones() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    add_book(&a, "sweep.epub", b"sweep me").await;
    add_book(&a, "gone.epub", b"gone bytes").await;
    for name in ["sweep.epub", "gone.epub"] {
        let file = file_row_id(&a, name).await;
        sqlx::query("DELETE FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file)
            .execute(&a.pool)
            .await
            .unwrap();
    }
    let gone = a.db_path.parent().unwrap().join("library/gone.epub");
    std::fs::remove_file(gone).unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let bindings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_row_id(&a, "sweep.epub").await)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(bindings, 1, "the readable book gets its identity back");
    let gone_bindings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_row_id(&a, "gone.epub").await)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(
        gone_bindings, 0,
        "a vanished file is skipped instead of aborting the pass"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_rejects_a_folder_that_belongs_to_another_library() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;

    clock::set_meta(
        &a.pool,
        clock::META_LIBRARY_ID,
        "0123456789abcdef0123456789abcdef",
    )
    .await
    .unwrap();

    let err = a.service.run_pass().await.unwrap_err();
    assert!(err.to_string().contains("different library"), "got {err}");
    assert_eq!(a.service.status().await.unwrap().state, SyncState::Error);
}

#[tokio::test(flavor = "multi_thread")]
async fn unreadable_trash_entries_are_skipped_and_restore_refuses_them() {
    let a = device().await;

    assert!(!a.service.restore(999).await.unwrap());
    let unknown = insert_trash(&a, "not-a-kind", &"e".repeat(32), "{}").await;
    assert!(!a.service.restore(unknown).await.unwrap());
    let unreadable = insert_trash(&a, "annotation", &"f".repeat(32), "{not json").await;
    let err = a.service.restore(unreadable).await.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidInput(_)),
        "an unreadable entry is rejected: {err:?}"
    );
    let readable = insert_trash(&a, "annotation", &"a".repeat(32), "{}").await;
    let err = a.service.restore(readable).await.unwrap_err();
    assert!(err.to_string().contains("not connected"), "got {err}");

    let listed = a.service.trash().await.unwrap();
    assert!(listed.iter().any(|entry| entry.id == readable));
    assert!(listed
        .iter()
        .all(|entry| entry.id != unknown && entry.id != unreadable));
}

#[tokio::test(start_paused = true)]
async fn the_background_loop_starts_and_stops() {
    // Setup uses real time: sqlx pool acquisition has its own 30 s timer, and
    // an idle paused runtime would auto-advance straight into it.
    tokio::time::resume();
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("tuxbooks.db");
    let pool = init_pool(&db_path).await.unwrap();
    let events = EventEmitter::new(|_name: &'static str, _payload: Value| {});
    let service = Arc::new(SyncService::new(pool, &db_path, events).await.unwrap());
    let sync_dir = tempfile::tempdir().unwrap();
    service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();

    tokio::time::pause();
    service.start();
    service.wake();
    // Let the task reach its startup sleep, then release it.
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(2)).await;
    // Database work runs in real time; only the loop's timers are paused.
    tokio::time::resume();

    let mut first_sync = None;
    for _ in 0..1000 {
        let status = service.status().await.unwrap();
        if let Some(last_sync) = status.last_sync_at {
            first_sync = Some(last_sync);
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(first_sync.is_some(), "the background loop completed a pass");

    service.shutdown().await;
    let after_shutdown = service.status().await.unwrap().last_sync_at;
    assert!(
        after_shutdown.is_some(),
        "the shutdown flush records a sync time"
    );

    // The loop is gone, so waking it and passing the poll interval is inert.
    tokio::time::pause();
    service.wake();
    tokio::time::advance(Duration::from_secs(10)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    tokio::time::resume();
    let after = service.status().await.unwrap().last_sync_at;
    assert_eq!(
        after, after_shutdown,
        "shutdown stops the background loop from running another pass"
    );
    assert!(service.status().await.unwrap().enabled);
}
