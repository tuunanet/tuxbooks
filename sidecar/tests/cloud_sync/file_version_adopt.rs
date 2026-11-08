//! End-to-end tests for file-version ADOPTION (ADR 0018 D3): the consumer
//! side of convergence. Device B fetches the staged blob for the winning
//! pointer, verifies it, swaps its local file's bytes, and lets the identity
//! sweep rebind onto the existing book — while annotations and progress
//! stay put, and nothing B does republishes a pointer.
//!
//! The helpers mirror the ones in `file_version.rs`; they stay local so that
//! module keeps its shape under the 500-line push gate.

use crate::common::*;
use sha2::{Digest, Sha256};
use tuxbooks_lib::services::library_reconciler::Reconciler;
use tuxbooks_lib::sync::file_version;

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

async fn file_version_ops(device: &Device) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_ops WHERE kind = 'file_version'")
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

async fn file_version_dirty_rows(device: &Device) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty WHERE kind = 'file_version'")
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

/// The identity the copy's binding carries. Keyed by the file row (which
/// identity merges re-key in place, never delete), so the value is stable
/// across the merge an incoming pointer can trigger.
async fn binding_uid(device: &Device, file_row_id: i64) -> String {
    sqlx::query_scalar("SELECT book_uid FROM sync_book_bindings WHERE book_id = ?1")
        .bind(file_row_id)
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

async fn binding_hash(device: &Device, file_row_id: i64) -> String {
    sqlx::query_scalar("SELECT content_hash FROM sync_book_bindings WHERE book_id = ?1")
        .bind(file_row_id)
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

/// The adoption issue row, if the sweep recorded one for this uid.
async fn adopt_issue(device: &Device, uid: &str) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT id FROM sync_issues
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

/// Device A publishes an external edit of `from` bytes to `to` bytes and
/// runs one pass, so the blob and the pointer are both in the folder.
async fn publish_edit(a: &Device, name: &str, to: &[u8]) {
    let path = library_path(a, name).await;
    std::fs::write(&path, to).unwrap();
    bump_mtime(&path);
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

/// Two devices, A publishes an external edit, B (book closed) adopts: the
/// bytes swap, the hash matches the winner, the identity rebinds onto the
/// existing book, and annotations and progress survive untouched.
#[tokio::test(flavor = "multi_thread")]
async fn closed_book_adopts_the_winning_bytes_and_keeps_its_identity() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;

    let a_path = library_path(&a, "book.epub").await;
    std::fs::write(&a_path, epub_v1()).unwrap();
    let _ = reconciler(&a).import_created(&a_path).await;
    let v2 = epub_v2();
    publish_edit(&a, "book.epub", &v2).await;
    assert!(staged_blob(sync_dir.path(), &sha(&v2), "epub").is_some());

    // Device B has the same original bytes, plus state that must survive.
    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;
    let b_id = book_id(&b, "book.epub").await;
    let b_file_row = file_row_id(&b, "book.epub").await;
    add_bookmark(&b, b_id, "epubcfi(/6/4!/4/2,/1:0,/1:1)", "kept").await;
    seed_progress(&b, b_id, 42.0).await;
    assert_eq!(file_version_ops(&b).await, 0);

    // First pass: the pointer lands, and adoption swaps the bytes in the
    // same pass. The binding is still the old hash until the sweep rebinds,
    // which is exactly the window the badge state reports.
    run(&b).await;
    assert_eq!(std::fs::read(&b_path).unwrap(), v2, "B adopted the bytes");
    assert_eq!(sha(&std::fs::read(&b_path).unwrap()), sha(&v2));
    let uid_after_pointer = canonical_uid(&b, &uid_of(&b, "book.epub").await).await;
    assert_eq!(
        unsettled_uids(&b).await,
        vec![uid_after_pointer.clone()],
        "the copy differs from the winner until the rebind"
    );
    let identity_at_swap = binding_uid(&b, b_file_row).await;

    // Second pass: the identity sweep rehashes the swapped file and rebinds
    // it onto the existing uid.
    run(&b).await;
    assert_eq!(binding_hash(&b, b_file_row).await, sha(&v2));
    assert_eq!(
        binding_uid(&b, b_file_row).await,
        identity_at_swap,
        "the rebind resolved to the existing identity, not a new one"
    );
    assert_eq!(
        unsettled_uids(&b).await,
        Vec::<String>::new(),
        "settled: local hash equals the winning hash"
    );

    // Annotations and progress keep their rows and their stored locators.
    let annotations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM annotations")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(annotations, 1, "the annotation survived adoption");
    let b_id_after = book_id(&b, "book.epub").await;
    assert_eq!(progress_percent(&b, b_id_after).await, Some(42.0));

    // And A is already settled: its bytes are the winner, nothing to do.
    run(&a).await;
    assert_eq!(unsettled_uids(&a).await, Vec::<String>::new());
}

/// Op-before-blob arrival (ADR 0018 D2): the pointer lands while the bytes
/// are still in flight, B changes nothing and records no issue, and the
/// next pass after the blob arrives converges.
#[tokio::test(flavor = "multi_thread")]
async fn pointer_before_blob_waits_then_converges_when_the_blob_arrives() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;

    let a_path = library_path(&a, "book.epub").await;
    std::fs::write(&a_path, epub_v1()).unwrap();
    let _ = reconciler(&a).import_created(&a_path).await;
    let v2 = epub_v2();
    publish_edit(&a, "book.epub", &v2).await;
    let v2_hash = sha(&v2);

    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;

    // The blob is still "in flight": move it out of the folder.
    let blob = staged_blob(sync_dir.path(), &v2_hash, "epub").unwrap();
    let parked = sync_dir.path().join("parked.blob");
    std::fs::rename(&blob, &parked).unwrap();

    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        epub_v1(),
        "no bytes changed while the blob is absent"
    );
    let uid = canonical_uid(&b, &uid_of(&b, "book.epub").await).await;
    assert!(
        adopt_issue(&b, &uid).await.is_none(),
        "a missing blob is not a failure"
    );

    // The blob arrives; the next pass adopts and settles.
    std::fs::rename(&parked, &blob).unwrap();
    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        v2,
        "converged once the bytes arrived"
    );
    run(&b).await;
    let b_file_row = file_row_id(&b, "book.epub").await;
    assert_eq!(
        binding_hash(&b, b_file_row).await,
        v2_hash,
        "rebound onto the winner"
    );
    assert_eq!(unsettled_uids(&b).await, Vec::<String>::new());
}

/// A staged blob that does not verify (here: same length, wrong bytes) is
/// never adopted, records a visible issue, and the next pass after the blob
/// is fixed adopts and closes the row.
#[tokio::test(flavor = "multi_thread")]
async fn corrupted_blob_blocks_adoption_until_it_verifies() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;

    let a_path = library_path(&a, "book.epub").await;
    std::fs::write(&a_path, epub_v1()).unwrap();
    let _ = reconciler(&a).import_created(&a_path).await;
    let v2 = epub_v2();
    publish_edit(&a, "book.epub", &v2).await;
    let v2_hash = sha(&v2);

    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;

    // Corrupt the staged copy, keeping its length so the size pre-check
    // passes and the hash is what rejects it.
    let blob = staged_blob(sync_dir.path(), &v2_hash, "epub").unwrap();
    let junk = vec![0u8; v2.len()];
    std::fs::write(&blob, &junk).unwrap();

    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        epub_v1(),
        "corrupt bytes never swap"
    );
    let uid = canonical_uid(&b, &uid_of(&b, "book.epub").await).await;
    assert!(
        adopt_issue(&b, &uid).await.is_some(),
        "the failure is visible"
    );

    // The folder heals (a re-stage or a fresh cloud copy); adoption succeeds
    // and the issue row closes.
    std::fs::write(&blob, &v2).unwrap();
    run(&b).await;
    assert_eq!(std::fs::read(&b_path).unwrap(), v2);
    assert!(
        adopt_issue(&b, &uid).await.is_none(),
        "success resolved the row"
    );
}

/// The loop-break regression: after B adopts, every later re-import of the
/// adopted bytes — the shape the file watcher produces — mints nothing, so
/// B never republishes the pointer it just consumed (ADR 0018 D1/D3).
#[tokio::test(flavor = "multi_thread")]
async fn adoption_reimport_mints_nothing() {
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
    run(&b).await;
    run(&b).await;
    let b_file_row = file_row_id(&b, "book.epub").await;
    assert_eq!(
        binding_hash(&b, b_file_row).await,
        sha(&v2),
        "adopted and rebound"
    );

    // The watcher fires on the swap's file change: a re-import whose bytes
    // hash to the winning version. It rebinds and mints nothing.
    bump_mtime(&b_path);
    reconciler(&b).handle_modified(&b_path).await;
    assert_eq!(
        file_version_dirty_rows(&b).await,
        0,
        "publish-only-on-hash-change keeps adoption re-imports silent"
    );
    run(&b).await;
    assert_eq!(file_version_ops(&b).await, 0, "no pointer op ever leaves B");
    assert_eq!(file_version_dirty_rows(&b).await, 0);
}

/// A copy whose bytes moved without a rebind — an external edit in flight —
/// is left alone. Adoption only swaps bytes it can prove match the binding;
/// the edit then wins the pointer through the normal re-import path, and
/// the other device converges onto it.
#[tokio::test(flavor = "multi_thread")]
async fn adoption_skips_a_file_whose_bytes_moved_without_a_rebind() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;

    let a_path = library_path(&a, "book.epub").await;
    std::fs::write(&a_path, epub_v1()).unwrap();
    let _ = reconciler(&a).import_created(&a_path).await;
    let v2 = epub_v2();
    publish_edit(&a, "book.epub", &v2).await;
    let blob = staged_blob(sync_dir.path(), &sha(&v2), "epub").unwrap();

    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;

    // The pointer arrives without the blob, so the first pass cannot adopt;
    // then the user edits the file externally before the blob lands.
    let parked = sync_dir.path().join("parked.blob");
    std::fs::rename(&blob, &parked).unwrap();
    run(&b).await;
    let v3 = epub_v3();
    std::fs::write(&b_path, &v3).unwrap();
    bump_mtime(&b_path);

    std::fs::rename(&parked, &blob).unwrap();
    run(&b).await;
    assert_eq!(
        std::fs::read(&b_path).unwrap(),
        v3,
        "the in-flight edit was not clobbered by the older winner"
    );

    // The edit re-imports, mints a newer pointer, and A converges onto it.
    bump_mtime(&b_path);
    reconciler(&b).handle_modified(&b_path).await;
    run(&b).await;
    let b_file_row = file_row_id(&b, "book.epub").await;
    assert_eq!(
        binding_hash(&b, b_file_row).await,
        sha(&v3),
        "B's edit is the new winner"
    );
    run(&a).await;
    let a_path = library_path(&a, "book.epub").await;
    assert_eq!(
        std::fs::read(&a_path).unwrap(),
        v3,
        "A adopted B's newer version"
    );
}

/// A vanished local file is not adoption's business: no swap, no delete of
/// the staged blob, and the winning pointer stays authoritative for the
/// re-fetch path (ADR 0018 D4, ADR 0013 D6).
#[tokio::test(flavor = "multi_thread")]
async fn vanished_local_file_changes_nothing() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;

    let a_path = library_path(&a, "book.epub").await;
    std::fs::write(&a_path, epub_v1()).unwrap();
    let _ = reconciler(&a).import_created(&a_path).await;
    let v2 = epub_v2();
    publish_edit(&a, "book.epub", &v2).await;
    let v2_hash = sha(&v2);

    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;
    let b_file_row = file_row_id(&b, "book.epub").await;
    // The file disappears; the row waits for reconnection.
    std::fs::remove_file(&b_path).unwrap();
    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(b_file_row)
        .execute(&b.pool)
        .await
        .unwrap();

    run(&b).await;
    assert_eq!(
        mirrored_version(&b, &canonical_uid(&b, &uid_of(&b, "book.epub").await).await)
            .await
            .map(|(hash, _)| hash),
        Some(v2_hash.clone()),
        "the pointer stays authoritative"
    );
    assert!(
        staged_blob(sync_dir.path(), &v2_hash, "epub").is_some(),
        "adoption never deletes the staged winner"
    );
    assert!(
        !b_path.exists(),
        "adoption never resurrects or rewrites files"
    );
}

/// The winning pointer as the mirror holds it, if any.
async fn mirrored_version(device: &Device, uid: &str) -> Option<(String, i64)> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT
             (SELECT value_json FROM sync_state_fields
              WHERE kind = 'file_version' AND entity_uid = ?1 AND field = 'content_hash'),
             (SELECT value_json FROM sync_state_fields
              WHERE kind = 'file_version' AND entity_uid = ?1 AND field = 'size')",
    )
    .bind(uid)
    .fetch_optional(&device.pool)
    .await
    .unwrap();
    match row {
        Some((Some(hash), Some(size))) => {
            let hash: String = serde_json::from_str(&hash).unwrap();
            let size: i64 = serde_json::from_str(&size).unwrap();
            Some((hash, size))
        }
        _ => None,
    }
}
