//! A capture backlog that cannot fit in one pass (tuxbooks-fx2): the
//! engine has to carry dirty rows across passes until the queue is empty,
//! without dropping or duplicating an operation. Per docs/TESTING.md this
//! lives in its own file rather than joining the journey suites.

use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tempfile::TempDir;

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::{AnnotationKind, NewAnnotation, NewBook};
use tuxbooks_lib::repository::{annotations, books};
use tuxbooks_lib::rpc::EventEmitter;
use tuxbooks_lib::sync::clock;
use tuxbooks_lib::sync::engine::SyncService;
use tuxbooks_lib::sync::identity::ensure_book_identity;

/// One pass captures at most two batches of `CAPTURE_BATCH` (250, drained
/// twice per pass), so 500 rows fit and this many do not: the drain has
/// to continue over at least two passes by arithmetic, not by timing.
const ANNOTATIONS: usize = 600;
const ONE_PASS: usize = 500;

async fn hashed_book(pool: &SqlitePool, library: &std::path::Path) -> i64 {
    std::fs::create_dir_all(library).unwrap();
    let path = library.join("backlog.epub");
    std::fs::write(&path, "backlog book bytes").unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    let mtime = metadata
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let upserted = books::upsert_file(
        pool,
        &NewBook {
            path: path.to_string_lossy().into_owned(),
            title: "Backlog".into(),
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
    ensure_book_identity(pool, upserted.file_id).await.unwrap();
    books::durable_id_for_file(pool, upserted.file_id)
        .await
        .unwrap()
        .expect("hashed book")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_backlog_beyond_one_capture_batch_drains_across_passes() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let pool = init_pool(&db_path).await.unwrap();
    let book_id = hashed_book(&pool, &tmp.path().join("library")).await;

    // Every annotation insert fires its own dirty marker: this is the
    // backlog the engine has to drain.
    for i in 0..ANNOTATIONS {
        annotations::insert_annotation(
            &pool,
            book_id,
            &NewAnnotation {
                kind: AnnotationKind::Bookmark,
                cfi: Some(format!("epubcfi(/6/4!/4/{i})")),
                chapter_href: Some("chapter1.xhtml".into()),
                page_number: None,
                page_fraction: None,
                text: None,
                color: None,
                geometry: None,
            },
        )
        .await
        .unwrap();
    }

    let folder = TempDir::new().unwrap();
    let service = SyncService::new(
        pool.clone(),
        &db_path,
        EventEmitter::new(|_: &'static str, _: Value| {}),
    )
    .await
    .unwrap();
    let connected = service
        .connect(folder.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    assert!(connected.mismatch.is_none());

    // Passes run by hand: the arithmetic decides how many are needed, not
    // a poll on the background loop's timing.
    let mut passes = 0;
    loop {
        let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
            .fetch_one(&pool)
            .await
            .unwrap();
        if dirty == 0 {
            break;
        }
        passes += 1;
        assert!(
            passes <= 10,
            "the queue never drains: {dirty} rows left after {passes} passes"
        );
        service.run_pass().await.unwrap();
    }

    assert!(
        passes >= 2,
        "a backlog of {ANNOTATIONS} does not fit one {ONE_PASS}-row pass; used {passes}"
    );

    let open_issues: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_issues WHERE resolved_at IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(open_issues, 0, "the drain records no issues");
    let listed = annotations::list_annotations(&pool, book_id).await.unwrap();
    assert_eq!(listed.len(), ANNOTATIONS, "no annotation was lost");

    // Every annotation reached the folder as an op under the device's
    // directory. Echo markers may add files, so count distinct entities
    // rather than raw files.
    let device_id = clock::device_id(&pool).await.unwrap();
    let ops_dir = folder.path().join("TuxBooks").join("ops").join(&device_id);
    let mut seen = std::collections::HashSet::new();
    for entry in std::fs::read_dir(&ops_dir).unwrap() {
        let raw = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        let op: Value = serde_json::from_str(&raw).unwrap();
        if op["kind"] == json!("annotation") && op["deleted"] == json!(false) {
            let uid = op["entity_uid"].as_str().expect("annotation op uid");
            seen.insert(uid.to_string());
        }
    }
    assert_eq!(
        seen.len(),
        ANNOTATIONS,
        "one op per annotation reached the folder"
    );
}
