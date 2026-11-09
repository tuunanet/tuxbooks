//! End-to-end tests for the adoption deferrals: open-book deferral (ADR 0018
//! D5) and the missing-blob visibility counter. The helpers mirror the ones
//! in `file_version_adopt.rs`; they stay local so that module keeps its
//! shape under the 500-line push gate.
//!
//! Both tests land the pointer in a first pass with the blob parked, before
//! the behavior under test: the pass settles this device's identity merge
//! (its fresh uid folds into the shared winner, whichever side wins), so
//! the uids the assertions hold stay stable afterwards.

use crate::common::*;
use sha2::{Digest, Sha256};
use tuxbooks_lib::services::library_reconciler::Reconciler;
use tuxbooks_lib::sync::engine::MISSING_BLOB_ISSUE_THRESHOLD;
use tuxbooks_lib::sync::file_version;

fn epub_v1() -> Vec<u8> {
    fixture_epub("../tests/fixtures/books/minimal.epub")
}

fn epub_v2() -> Vec<u8> {
    fixture_epub("../tests/fixtures/epub/core/epub3/styling.epub")
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn uid_of(device: &Device, name: &str) -> String {
    let id = book_id(device, name).await;
    book_uid(device, id).await
}

/// The uid as the device's merge table resolves it.
async fn canonical_uid(device: &Device, uid: &str) -> String {
    tuxbooks_lib::sync::identity::canonical_book_uid(&device.pool, uid)
        .await
        .unwrap()
}

async fn library_path(device: &Device, name: &str) -> PathBuf {
    let path = device.db_path.parent().unwrap().join("library").join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    path
}

/// A reconciler wired like the watcher's: real imports against the device's
/// database, with the covers cache beside the database.
fn reconciler(device: &Device) -> Reconciler {
    let covers = device.db_path.parent().unwrap().join("covers");
    Reconciler::new(
        device.pool.clone(),
        covers,
        Vec::new(),
        tokio::runtime::Handle::current(),
        Box::new(|_| {}),
    )
}

/// Device A publishes an external edit of `from` bytes to `to` bytes and
/// runs one pass, so the blob and the pointer are both in the folder.
async fn publish_edit(a: &Device, name: &str, to: &[u8]) {
    let path = library_path(a, name).await;
    std::fs::write(&path, to).unwrap();
    let previous = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::File::open(&path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(previous + std::time::Duration::from_secs(10)),
        )
        .unwrap();
    reconciler(a).handle_modified(&path).await;
    run(a).await;
}

/// The unsettled set as the engine and the badge both see it.
async fn unsettled_uids(device: &Device) -> Vec<String> {
    file_version::unsettled_copies(&device.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|copy| copy.book_uid)
        .collect()
}

/// The open adoption issue row's detail, if the sweep recorded one.
async fn adopt_issue_detail(device: &Device, uid: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT detail FROM sync_issues
         WHERE kind = 'book_file_adopt_failed' AND issue_key = ?1 AND resolved_at IS NULL",
    )
    .bind(format!("book-file-adopt:{uid}"))
    .fetch_optional(&device.pool)
    .await
    .unwrap()
}

fn staged_blob(folder: &Path, hash: &str, extension: &str) -> Option<PathBuf> {
    let blob = folder
        .join("TuxBooks")
        .join("blobs")
        .join("books")
        .join(format!("{hash}.{extension}"));
    blob.exists().then_some(blob)
}

/// Move the staged blob aside so the next pass sees a pointer without its
/// bytes, and return how to put it back.
fn park_blob(folder: &Path, hash: &str) -> (PathBuf, PathBuf) {
    let blob = staged_blob(folder, hash, "epub").unwrap();
    let parked = folder.join("parked.blob");
    std::fs::rename(&blob, &parked).unwrap();
    (blob, parked)
}

/// Device A publishes an edit; device B holds the old bytes, connected and
/// imported. Returns the sync folder (kept alive), both devices, and B's
/// library file.
async fn two_devices_with_a_pending_winner() -> (TempDir, Device, Device, PathBuf) {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;

    let a_path = library_path(&a, "book.epub").await;
    std::fs::write(&a_path, epub_v1()).unwrap();
    let _ = reconciler(&a).import_created(&a_path).await;
    let v2 = epub_v2();
    publish_edit(&a, "book.epub", &v2).await;

    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;
    (sync_dir, a, b, b_path)
}

/// Open-book deferral (ADR 0018 D5): with the reader session open, the
/// pointer and its blob are both present, yet nothing swaps and the badge
/// state stays true; closing the reader releases the deferral and the next
/// pass swaps and settles.
#[tokio::test(flavor = "multi_thread")]
async fn open_book_defers_adoption_until_the_reader_closes() {
    let (sync_dir, _a, b, b_path) = two_devices_with_a_pending_winner().await;
    let v2 = epub_v2();
    let v2_hash = sha(&v2);

    // First pass: the pointer lands while the blob is still in flight, so
    // nothing can adopt yet and the identity merge settles.
    let (blob, parked) = park_blob(sync_dir.path(), &v2_hash);
    run(&b).await;

    // The reader session opens while the bytes are pending.
    let uid = canonical_uid(&b, &uid_of(&b, "book.epub").await).await;
    b.service.reader_opened(uid.clone());

    // The blob arrives; pointer and bytes are both there, yet the open
    // reader keeps the file untouched and the badge state stays visible.
    std::fs::rename(&parked, &blob).unwrap();
    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        epub_v1(),
        "no bytes swap under an open reader"
    );
    assert_eq!(
        unsettled_uids(&b).await,
        vec![uid.clone()],
        "the badge state stays visible for the deferred book"
    );
    assert!(
        adopt_issue_detail(&b, &uid).await.is_none(),
        "deferral records no issue"
    );

    // Closing the reader empties the deferral; the next pass adopts and the
    // one after rebinds, settling the badge state.
    b.service.reader_closed(uid);
    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        v2,
        "the post-close pass adopted the winning bytes"
    );
    run(&b).await;
    assert_eq!(
        unsettled_uids(&b).await,
        Vec::<String>::new(),
        "the copy settled once the reader was closed"
    );
}

/// Missing-blob visibility: the pointer without its blob stays silent for a
/// few passes, then the wait surfaces as an issue naming the missing blob;
/// when the blob arrives the next pass adopts and the row self-closes.
#[tokio::test(flavor = "multi_thread")]
async fn repeated_missing_blob_passes_surface_an_issue_then_self_close() {
    let (sync_dir, _a, b, b_path) = two_devices_with_a_pending_winner().await;
    let v2 = epub_v2();
    let v2_hash = sha(&v2);
    let (blob, parked) = park_blob(sync_dir.path(), &v2_hash);

    // First pass: the pointer lands and the identity merge settles.
    run(&b).await;
    let uid = canonical_uid(&b, &uid_of(&b, "book.epub").await).await;

    // Threshold minus one missing passes in total: the op-before-blob wait
    // is still invisible.
    for _ in 1..MISSING_BLOB_ISSUE_THRESHOLD - 1 {
        run(&b).await;
    }
    assert!(adopt_issue_detail(&b, &uid).await.is_none());
    assert_eq!(std::fs::read(&b_path).unwrap(), epub_v1());

    // The Nth consecutive pass surfaces the wait, naming hash and name.
    run(&b).await;
    let detail = adopt_issue_detail(&b, &uid)
        .await
        .expect("the endless wait became visible");
    assert!(
        detail.contains(&format!("{v2_hash}.epub")),
        "the detail names the missing blob: {detail}"
    );

    // The blob arrives; adoption proceeds and the row self-closes.
    std::fs::rename(&parked, &blob).unwrap();
    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        v2,
        "converged once the bytes arrived"
    );
    assert!(
        adopt_issue_detail(&b, &uid).await.is_none(),
        "success resolved the row"
    );
}
