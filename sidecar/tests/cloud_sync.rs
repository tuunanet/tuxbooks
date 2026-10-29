//! End-to-end tests for cloud-folder sync: two or three real databases
//! sharing one folder, with the real trigger pipeline and engine.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use sqlx::SqlitePool;
use tempfile::TempDir;

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::{
    AnnotationKind, AnnotationPatch, NewAnnotation, NewBook, ProgressUpdate,
};
use tuxbooks_lib::error::AppError;
use tuxbooks_lib::repository::{
    annotations, books, collections, metadata as metadata_repo, reading_progress,
};
use tuxbooks_lib::rpc::EventEmitter;
use tuxbooks_lib::services::metadata;
use tuxbooks_lib::sync::clock;
use tuxbooks_lib::sync::engine::SyncService;
use tuxbooks_lib::sync::model::{EntityKind, Hlc, Op, OP_SCHEMA};

struct Device {
    _dir: TempDir,
    pool: SqlitePool,
    service: SyncService,
    db_path: PathBuf,
}

async fn device() -> Device {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("tuxbooks.db");
    let pool = init_pool(&db_path).await.unwrap();
    let events = EventEmitter::new(|_name: &'static str, _payload: Value| {});
    let service = SyncService::new(pool.clone(), &db_path, events)
        .await
        .unwrap();
    Device {
        _dir: dir,
        pool,
        service,
        db_path,
    }
}

async fn connect(device: &Device, folder: &Path) {
    let result = device
        .service
        .connect(folder.to_str().unwrap(), None, None)
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
    books::upsert_book(
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
    .unwrap()
    .0
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
    let b_book = add_book(&b, "same.epub", b"the exact same book bytes").await;
    run(&b).await;
    run(&b).await;

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
    let b_book = add_book(&b, "same.epub", b"progress book").await;
    run(&b).await;
    run(&b).await;
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
    let b_book = add_book(&b, "same.epub", b"collection book").await;
    run(&b).await;
    run(&b).await;

    let summaries = collections::list_collection_summaries(&b.pool)
        .await
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].name, "Favorites");
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
    let b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    assert_eq!(annotation_count(&b, b_book).await, 1);

    books::delete_book(&a.pool, a_book).await.unwrap();
    run(&a).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, b_book).await,
        1,
        "A's local removal must not become a shared delete"
    );

    let a_book_again = add_book(&a, "same.epub", bytes).await;
    run(&a).await;
    run(&a).await;
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
    let b_book = add_book(&b, "same.epub", b"duplicate ops").await;
    run(&b).await;
    run(&b).await;

    assert_eq!(
        annotation_count(&b, b_book).await,
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
    let a_book = add_book(&a, "same.epub", b"metadata book").await;

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
        a_book,
        &overrides,
        &["Alice".into(), "Bob".into()],
        &["Essays".into()],
    )
    .await
    .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let b_book = add_book(&b, "same.epub", b"metadata book").await;
    run(&b).await;
    run(&b).await;

    let book = books::get_book(&b.pool, b_book).await.unwrap().unwrap();
    assert_eq!(book.title, "Curated title");
    assert_eq!(book.author.as_deref(), Some("Alice, Bob"));
    let authors = metadata_repo::list_book_authors(&b.pool, b_book)
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
    let b_book = add_book(&b, "same.epub", b"version one").await;
    run(&b).await;
    run(&b).await;
    assert_eq!(annotation_count(&b, b_book).await, 1);

    // Simulate a metadata embed on A: same row, new bytes.
    update_book_bytes(&a, a_book, b"version two with new metadata").await;
    run(&a).await;
    run(&a).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&a, a_book).await,
        1,
        "the rewriting device keeps its book"
    );
    assert_eq!(
        annotation_count(&b, b_book).await,
        1,
        "the other device keeps the annotation under the old alias"
    );

    // B's cloud client eventually delivers the rewritten bytes.
    update_book_bytes(&b, b_book, b"version two with new metadata").await;
    run(&b).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, b_book).await,
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
        .connect(sync_dir.path().to_str().unwrap(), None, None)
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
    let b_book = add_book(&b, "same.epub", b"conflict book").await;
    run(&b).await;
    run(&b).await;
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

    let a_note = annotations::list_annotations(&a.pool, a_book)
        .await
        .unwrap()[0]
        .note
        .clone();
    let b_note = annotations::list_annotations(&b.pool, b_book)
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
        .connect(file.path().to_str().unwrap(), None, None)
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
            .bind(a_book)
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
async fn deleting_the_canonical_copy_reprojects_to_the_duplicate() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let first = add_book(&a, "copy-one.epub", b"duplicate content").await;
    let second = add_book(&a, "copy-two.epub", b"duplicate content").await;
    add_bookmark(&a, first, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    run(&a).await;

    assert_eq!(annotation_count(&a, first).await, 1);
    assert_eq!(annotation_count(&a, second).await, 0);
    let issues = a.service.issues().await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "duplicate_book"),
        "the duplicate copy is named in Sync issues: {issues:?}"
    );

    books::delete_book(&a.pool, first).await.unwrap();
    run(&a).await;
    run(&a).await;

    assert_eq!(
        annotation_count(&a, second).await,
        1,
        "the remaining copy inherits the shared state"
    );
}
