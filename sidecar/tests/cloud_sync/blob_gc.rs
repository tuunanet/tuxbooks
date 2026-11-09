//! End-to-end tests for the staging-folder GC (ADR 0018 D4): superseded
//! blobs, stale staging temps, and off-grammar artifacts age out after 90
//! days, the winning blob is kept forever, a device with an empty mirror
//! deletes nothing, and the sweep runs at most once per hour.
//!
//! The helpers mirror the ones in `file_version.rs` and
//! `file_version_adopt.rs`; they stay local so those modules keep their
//! shape under the 500-line push gate.

use crate::common::*;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};
use tuxbooks_lib::services::library_reconciler::Reconciler;
use tuxbooks_lib::sync::clock;

fn epub_v1() -> Vec<u8> {
    fixture_epub("../tests/fixtures/books/minimal.epub")
}

fn epub_v2() -> Vec<u8> {
    fixture_epub("../tests/fixtures/epub/core/epub3/styling.epub")
}

fn epub_v3() -> Vec<u8> {
    fixture_epub("../tests/fixtures/epub/core/epub3/images.epub")
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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

/// Bump mtime by a future second so a rewrite is a genuine size+mtime
/// divergence for the reconciler and the identity sweep.
fn bump_mtime(path: &Path) {
    let previous = std::fs::metadata(path).unwrap().modified().unwrap();
    std::fs::File::open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(previous + std::time::Duration::from_secs(10)),
        )
        .unwrap();
}

/// Backdate a file deep past the 90-day GC window.
fn backdate_past_window(path: &Path) {
    let modified = SystemTime::now() - Duration::from_secs(91 * 24 * 60 * 60);
    std::fs::File::open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
}

fn blob_path(folder: &Path, bytes: &[u8], extension: &str) -> PathBuf {
    folder
        .join("TuxBooks")
        .join("blobs")
        .join("books")
        .join(format!("{}.{extension}", sha(bytes)))
}

fn blob_dir(folder: &Path) -> PathBuf {
    folder.join("TuxBooks").join("blobs").join("books")
}

fn blob_names(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(blob_dir(folder))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The GC cadence stamp, so tests can prove the sweep ran (or was
/// throttled) rather than guessing from side effects.
async fn gc_stamp(pool: &SqlitePool) -> Option<String> {
    clock::get_meta(pool, clock::META_BLOB_GC).await.unwrap()
}

/// Publish an external edit of `name` to `bytes` and run one pass, so the
/// blob and the pointer are both in the folder.
async fn publish_edit(a: &Device, name: &str, to: &[u8]) {
    let path = library_path(a, name).await;
    std::fs::write(&path, to).unwrap();
    bump_mtime(&path);
    reconciler(a).handle_modified(&path).await;
    run(a).await;
}

/// One publish of v2 then a superseding publish of v3, the shape every GC
/// test starts from: two staged blobs, the winner is v3's.
async fn publish_two_versions(a: &Device, name: &str) {
    let path = library_path(a, name).await;
    std::fs::write(&path, epub_v1()).unwrap();
    let _ = reconciler(a).import_created(&path).await;
    publish_edit(a, name, &epub_v2()).await;
    publish_edit(a, name, &epub_v3()).await;
}

/// A device whose mirror holds no `file_version` rows (a fresh joiner)
/// declines to prune, no matter how old the folder's blobs are: an empty
/// winning set is not enough information to call anything superseded.
#[tokio::test(flavor = "multi_thread")]
async fn gc_declines_while_the_mirror_holds_no_file_version_rows() {
    let sync_dir = tempfile::tempdir().unwrap();
    let device = device().await;
    connect(&device, sync_dir.path()).await;

    // A folder another device has used for months: blobs with ancient
    // mtimes, one grammar-valid, one a conflict copy, one a stale temp.
    let v1 = epub_v1();
    let loser = blob_path(sync_dir.path(), &v1, "epub");
    std::fs::create_dir_all(blob_dir(sync_dir.path())).unwrap();
    std::fs::write(&loser, &v1).unwrap();
    backdate_past_window(&loser);
    let conflict = blob_dir(sync_dir.path()).join("old (conflicting copy).epub");
    std::fs::write(&conflict, &v1).unwrap();
    backdate_past_window(&conflict);
    let temp = blob_dir(sync_dir.path()).join(format!(".{}.epub.4711.tmp", sha(&v1)));
    std::fs::write(&temp, b"half-written").unwrap();
    backdate_past_window(&temp);

    run(&device).await;

    assert!(
        std::fs::metadata(&loser).is_ok(),
        "an empty mirror must not mass-delete old blobs"
    );
    assert!(std::fs::metadata(&conflict).is_ok());
    assert!(std::fs::metadata(&temp).is_ok());
    assert!(
        gc_stamp(&device.pool).await.is_some(),
        "the sweep ran and declined; the cadence stamp still moved"
    );
}

/// The full D4 sweep through the real pipeline: two published versions, the
/// loser aged past the window, off-grammar debris beside it — GC deletes
/// the loser, the debris, and the stale temp, keeps the ancient winner and
/// the recent artifact, and a late device still converges on the winner
/// without the pruned loser ever existing for it.
#[tokio::test(flavor = "multi_thread")]
async fn gc_prunes_superseded_artifacts_and_keeps_the_winner_forever() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    publish_two_versions(&a, "book.epub").await;

    let v2 = epub_v2();
    let v3 = epub_v3();
    let loser = blob_path(sync_dir.path(), &v2, "epub");
    let winner = blob_path(sync_dir.path(), &v3, "epub");
    assert!(std::fs::metadata(&loser).is_ok());
    assert!(std::fs::metadata(&winner).is_ok());

    // Age everything the D4 window can see: the loser past the window, the
    // winner at 400 days (it must survive regardless of age), plus debris
    // — an old cloud conflict copy, a recent one, a stale staging temp in
    // the writer's real grammar.
    backdate_past_window(&loser);
    let ancient = SystemTime::now() - Duration::from_secs(400 * 24 * 60 * 60);
    std::fs::File::open(&winner)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(ancient))
        .unwrap();
    let old_conflict = blob_dir(sync_dir.path()).join("old (conflicting copy from 'Desktop').epub");
    std::fs::write(&old_conflict, &v2).unwrap();
    backdate_past_window(&old_conflict);
    let new_conflict = blob_dir(sync_dir.path()).join("new (conflicting copy).epub");
    std::fs::write(&new_conflict, &v2).unwrap();
    let stale_temp = blob_dir(sync_dir.path()).join(format!(".{}.epub.4242.tmp", sha(&v2)));
    std::fs::write(&stale_temp, b"half-written").unwrap();
    backdate_past_window(&stale_temp);

    // The startup GC ran on the earlier passes (throttled since); move the
    // stamp back so this pass sweeps.
    clock::set_meta(&a.pool, clock::META_BLOB_GC, "2026-01-01T00:00:00.000Z")
        .await
        .unwrap();
    run(&a).await;

    assert!(
        std::fs::metadata(&loser).is_err(),
        "the superseded blob aged out"
    );
    assert!(
        std::fs::metadata(&old_conflict).is_err(),
        "old debris ages out"
    );
    assert!(
        std::fs::metadata(&stale_temp).is_err(),
        "the stale staging temp ages out"
    );
    assert!(
        std::fs::metadata(&winner).is_ok(),
        "the winner is kept forever, whatever its age"
    );
    assert_eq!(
        std::fs::read(&winner).unwrap(),
        v3,
        "the winner keeps its bytes"
    );
    assert!(
        std::fs::metadata(&new_conflict).is_ok(),
        "recent debris is inside the window and stays"
    );
    // Nothing outside blobs/books/ was touched: A's own operations survive.
    assert!(
        std::fs::read_dir(sync_dir.path().join("TuxBooks").join("ops"))
            .unwrap()
            .next()
            .is_some(),
        "the operation tree is off-limits to GC"
    );

    // A late device: B holds v1 bytes, joins after the prune, and adopts
    // the winner. It never needed the loser — late devices adopt only the
    // winner (D4) — so pruning it cannot block convergence.
    let b = device().await;
    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;
    run(&b).await;
    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        v3,
        "B adopted the surviving winner's bytes"
    );
    let b_file_row = file_row_id(&b, "book.epub").await;
    let binding: String =
        sqlx::query_scalar("SELECT content_hash FROM sync_book_bindings WHERE book_id = ?1")
            .bind(b_file_row)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(binding, sha(&v3), "B's identity rebound onto the winner");
    // B staged nothing and deleted nothing: the folder holds exactly the
    // winner and the recent artifact now.
    assert_eq!(
        blob_names(sync_dir.path()),
        vec![
            format!("{}.epub", sha(&v3)),
            "new (conflicting copy).epub".to_string()
        ]
    );
    let b_ops: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_ops WHERE kind = 'file_version'")
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(b_ops, 0, "adoption never republishes");
}

/// The cadence gate: back-to-back passes sweep at most once per hour — a
/// blob that becomes prunable between two passes survives the throttled
/// pass — and the stamp moves when a sweep actually runs.
#[tokio::test(flavor = "multi_thread")]
async fn gc_is_throttled_to_one_sweep_per_hour() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    publish_two_versions(&a, "book.epub").await;

    // Pass 1 already ran the startup sweep: the stamp exists.
    let first_stamp = gc_stamp(&a.pool).await.expect("the startup sweep stamped");
    let v2 = epub_v2();
    let loser = blob_path(sync_dir.path(), &v2, "epub");
    backdate_past_window(&loser);

    // Second pass, back to back: throttled, so the now-prunable loser
    // survives, and the stamp did not move.
    run(&a).await;
    assert!(
        std::fs::metadata(&loser).is_ok(),
        "the hourly gate skipped the sweep"
    );
    assert_eq!(
        gc_stamp(&a.pool).await.as_deref(),
        Some(first_stamp.as_str()),
        "a throttled sweep does not re-stamp"
    );

    // An hour later the sweep runs and the loser goes.
    clock::set_meta(&a.pool, clock::META_BLOB_GC, "2026-01-01T00:00:00.000Z")
        .await
        .unwrap();
    run(&a).await;
    assert!(std::fs::metadata(&loser).is_err(), "the due sweep pruned");
    let moved = gc_stamp(&a.pool).await.expect("the sweep re-stamped");
    assert_ne!(moved, "2026-01-01T00:00:00.000Z", "the stamp moved");
}
