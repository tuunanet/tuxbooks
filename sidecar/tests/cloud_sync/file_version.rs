//! End-to-end tests for the book file_version pointer (ADR 0018 D1/D2):
//! the re-import mint, the publish-only-on-hash-change loop break, the
//! `blobs/books/` staging channel, and entity-level convergence.

use crate::common::*;
use sha2::{Digest, Sha256};
use tuxbooks_lib::services::library_reconciler::{ImportOutcome, Reconciler};
use tuxbooks_lib::sync::file_version;

/// Three distinct, parseable committed EPUBs, so a rewrite is a genuine
/// content change the real parser accepts.
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

/// The identity both devices converge on after the aliases meet.
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

/// Bump mtime by a future second so the size+mtime gate sees the rewrite
/// even inside the same timestamp bucket.
fn bump_mtime(path: &Path) {
    let previous = std::fs::metadata(path).unwrap().modified().unwrap();
    std::fs::File::open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(previous + std::time::Duration::from_secs(10)),
        )
        .unwrap();
}

async fn file_version_dirty_rows(device: &Device) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty WHERE kind = 'file_version'")
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

async fn file_version_ops(device: &Device) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_ops WHERE kind = 'file_version'")
        .fetch_one(&device.pool)
        .await
        .unwrap()
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

fn staged_blob(folder: &Path, hash: &str, extension: &str) -> Option<PathBuf> {
    let blob = folder
        .join("TuxBooks")
        .join("blobs")
        .join("books")
        .join(format!("{hash}.{extension}"));
    blob.exists().then_some(blob)
}

/// External edit through the reconciler path: the blob is staged under the
/// content address, the pointer op is published, and the op stays small.
/// The oversize test doubles as the stage-before-publish proof — an oversize
/// book records the issue and its op never appears, so the origin side only
/// ever writes the pointer after its blob.
#[tokio::test(flavor = "multi_thread")]
async fn external_edit_stages_the_blob_then_publishes_the_file_version() {
    let sync_dir = tempfile::tempdir().unwrap();
    let device = device().await;
    connect(&device, sync_dir.path()).await;

    let path = library_path(&device, "book.epub").await;
    std::fs::write(&path, epub_v1()).unwrap();
    let first = reconciler(&device).import_created(&path).await;
    assert_eq!(first, ImportOutcome::Imported);
    let uid = uid_of(&device, "book.epub").await;
    assert_eq!(
        file_version_dirty_rows(&device).await,
        0,
        "a first import never mints (ADR 0018 D1)"
    );

    // The external edit: size and mtime move, the reconciler re-imports.
    let v2 = epub_v2();
    std::fs::write(&path, &v2).unwrap();
    bump_mtime(&path);
    reconciler(&device).handle_modified(&path).await;
    assert_eq!(
        file_version_dirty_rows(&device).await,
        1,
        "the re-import minted one file_version"
    );

    run(&device).await;

    let hash = sha(&v2);
    let blob = staged_blob(sync_dir.path(), &hash, "epub")
        .expect("the blob is staged under its content address");
    assert_eq!(std::fs::read(&blob).unwrap(), v2, "name matches content");
    assert_eq!(
        file_version_ops(&device).await,
        1,
        "one pointer op published"
    );
    assert_eq!(
        mirrored_version(&device, &uid).await,
        Some((hash.clone(), v2.len() as i64)),
        "the mirror holds the minted hash and size as one value"
    );
    let (payload_bytes,): (i64,) =
        sqlx::query_as("SELECT LENGTH(payload_json) FROM sync_ops WHERE kind = 'file_version'")
            .fetch_one(&device.pool)
            .await
            .unwrap();
    assert!(
        payload_bytes < 1_000,
        "the op is a pointer, not bytes: {payload_bytes} bytes"
    );

    // The loop break: a re-import whose bytes hash to the winning version —
    // the shape every adoption re-import will have — mints nothing.
    bump_mtime(&path);
    reconciler(&device).handle_modified(&path).await;
    assert_eq!(
        file_version_dirty_rows(&device).await,
        0,
        "publish-only-on-hash-change keeps adoption re-imports silent"
    );
    run(&device).await;
    assert_eq!(file_version_ops(&device).await, 1, "no second op published");
}

/// The mint guard against an unchanged hash: identical content re-imported
/// (an editor touch) re-imports, mints nothing, republishes nothing.
#[tokio::test(flavor = "multi_thread")]
async fn reimport_of_identical_content_mints_nothing() {
    let sync_dir = tempfile::tempdir().unwrap();
    let device = device().await;
    connect(&device, sync_dir.path()).await;

    let path = library_path(&device, "book.epub").await;
    std::fs::write(&path, epub_v1()).unwrap();
    let _ = reconciler(&device).import_created(&path).await;
    let v2 = epub_v2();
    std::fs::write(&path, &v2).unwrap();
    bump_mtime(&path);
    reconciler(&device).handle_modified(&path).await;
    run(&device).await;
    let uid = uid_of(&device, "book.epub").await;
    assert!(mirrored_version(&device, &uid).await.is_some());

    // Same bytes, new mtime: the reconciler re-imports, the guard blocks.
    bump_mtime(&path);
    reconciler(&device).handle_modified(&path).await;
    assert_eq!(file_version_dirty_rows(&device).await, 0);
    run(&device).await;
    assert_eq!(file_version_ops(&device).await, 1);
    assert_eq!(
        mirrored_version(&device, &uid).await,
        Some((sha(&v2), v2.len() as i64))
    );
}

/// A locally deleted file propagates nothing: no delete op exists for this
/// kind, the winning pointer stays authoritative, and a mint whose bytes
/// vanish before a drain publishes nothing either.
#[tokio::test(flavor = "multi_thread")]
async fn local_file_deletion_publishes_nothing() {
    let sync_dir = tempfile::tempdir().unwrap();
    let device = device().await;
    connect(&device, sync_dir.path()).await;

    let path = library_path(&device, "book.epub").await;
    std::fs::write(&path, epub_v1()).unwrap();
    let _ = reconciler(&device).import_created(&path).await;
    let uid = uid_of(&device, "book.epub").await;
    let v2 = epub_v2();
    std::fs::write(&path, &v2).unwrap();
    bump_mtime(&path);
    reconciler(&device).handle_modified(&path).await;
    assert_eq!(file_version_dirty_rows(&device).await, 1);

    // The bytes vanish before the capture pass can stage them.
    std::fs::remove_file(&path).unwrap();
    run(&device).await;
    assert_eq!(file_version_ops(&device).await, 0, "no pointer published");
    assert_eq!(
        mirrored_version(&device, &uid).await,
        None,
        "nothing partial landed"
    );
    assert_eq!(file_version_dirty_rows(&device).await, 0);

    // And deleting an already-published book's file is a local disappearance,
    // not a shared delete: the winning pointer is untouched.
    std::fs::write(&path, epub_v1()).unwrap();
    let _ = reconciler(&device).import_created(&path).await;
    std::fs::write(&path, &v2).unwrap();
    bump_mtime(&path);
    reconciler(&device).handle_modified(&path).await;
    run(&device).await;
    assert_eq!(
        mirrored_version(&device, &uid).await,
        Some((sha(&v2), v2.len() as i64))
    );
    reconciler(&device).mark_removed(&path).await;
    run(&device).await;
    assert_eq!(file_version_ops(&device).await, 1, "no delete op exists");
    assert_eq!(
        mirrored_version(&device, &uid).await,
        Some((sha(&v2), v2.len() as i64)),
        "the last published version stays authoritative"
    );
}

/// A book over the 256 MiB cap records `book_blob_oversize` — human-required,
/// skipped by the auto-retry sweep — and publishes neither blob nor op. The
/// file is sparse: the cap is checked on the stat, so the bytes are never
/// written or read.
#[tokio::test(flavor = "multi_thread")]
async fn oversize_file_records_an_issue_and_publishes_nothing() {
    use tuxbooks_lib::sync::store::MAX_BOOK_BLOB_BYTES;

    let sync_dir = tempfile::tempdir().unwrap();
    let device = device().await;
    connect(&device, sync_dir.path()).await;

    let book = add_book(&device, "huge.epub", b"tiny").await;
    let uid = book_uid(&device, book).await;
    let path = library_path(&device, "huge.epub").await;
    // Swap in an oversize sparse file and freeze the snapshots so the
    // identity sweep never rehashes it mid-pass.
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(MAX_BOOK_BLOB_BYTES + 1).unwrap();
    drop(file);
    let metadata = std::fs::metadata(&path).unwrap();
    let mtime = metadata
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (hash, size): (String, i64) = sqlx::query_as(
        "SELECT content_hash, hashed_size FROM sync_book_bindings WHERE book_id = ?1",
    )
    .bind(book)
    .fetch_one(&device.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE books SET file_size = ?2, file_mtime = ?3 WHERE id = ?1")
        .bind(book)
        .bind(metadata.len() as i64)
        .bind(mtime)
        .execute(&device.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE sync_book_bindings SET hashed_size = ?2, hashed_mtime = ?3 WHERE book_id = ?1",
    )
    .bind(book)
    .bind(metadata.len() as i64)
    .bind(mtime)
    .execute(&device.pool)
    .await
    .unwrap();

    // Queue the mint the re-import path would have recorded.
    let payload = serde_json::json!({ "content_hash": hash, "size": size });
    sqlx::query(
        "INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
         VALUES ('file_version', ?1, 'upsert', NULL, ?2)",
    )
    .bind(&uid)
    .bind(payload.to_string())
    .execute(&device.pool)
    .await
    .unwrap();

    run(&device).await;

    let issues: Vec<String> = sqlx::query_scalar(
        "SELECT kind FROM sync_issues WHERE resolved_at IS NULL AND kind = 'book_blob_oversize'",
    )
    .fetch_all(&device.pool)
    .await
    .unwrap();
    assert_eq!(issues.len(), 1, "the oversize issue is open");
    assert_eq!(
        SyncIssueAction::for_kind("book_blob_oversize"),
        SyncIssueAction::CopyDetails,
        "human-required: no Retry action, so the auto-retry sweep skips it"
    );
    assert_eq!(
        staged_blob(sync_dir.path(), &hash, "epub"),
        None,
        "no blob staged"
    );
    assert_eq!(file_version_ops(&device).await, 0, "no op published");
    assert_eq!(
        mirrored_version(&device, &uid).await,
        None,
        "nothing partial landed"
    );
    assert_eq!(file_version_dirty_rows(&device).await, 0, "row settled");
}

/// Two devices converge on the newest pointer as one value: the newer HLC
/// wins the whole hash-and-size pair, nothing mixes, and the loser's blob
/// stays in the folder under its own hash.
#[tokio::test(flavor = "multi_thread")]
async fn newer_file_version_from_another_device_wins_as_one_value() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;

    // Device A imports and externally edits to v2; the pointer travels.
    let a_path = library_path(&a, "book.epub").await;
    std::fs::write(&a_path, epub_v1()).unwrap();
    let _ = reconciler(&a).import_created(&a_path).await;
    let v2 = epub_v2();
    std::fs::write(&a_path, &v2).unwrap();
    bump_mtime(&a_path);
    reconciler(&a).handle_modified(&a_path).await;
    run(&a).await;
    let uid = uid_of(&a, "book.epub").await;
    assert_eq!(
        mirrored_version(&a, &uid).await,
        Some((sha(&v2), v2.len() as i64))
    );

    // Device B has the same original bytes, imports them, sees A's pointer,
    // then externally edits to v3 — a genuinely newer version. B's clock
    // observed A's op, so the newer mint is strictly newer.
    connect(&b, sync_dir.path()).await;
    let b_path = library_path(&b, "book.epub").await;
    std::fs::write(&b_path, epub_v1()).unwrap();
    let _ = reconciler(&b).import_created(&b_path).await;
    run(&b).await;
    assert_eq!(
        mirrored_version(&b, canonical_uid(&b, &uid).await.as_str()).await,
        Some((sha(&v2), v2.len() as i64)),
        "B adopted A's pointer into its mirror"
    );

    let v3 = epub_v3();
    std::fs::write(&b_path, &v3).unwrap();
    bump_mtime(&b_path);
    reconciler(&b).handle_modified(&b_path).await;
    run(&b).await;
    let v3_hash = sha(&v3);
    assert_eq!(
        mirrored_version(&b, canonical_uid(&b, &uid).await.as_str()).await,
        Some((v3_hash.clone(), v3.len() as i64))
    );
    assert!(
        staged_blob(sync_dir.path(), &v3_hash, "epub").is_some(),
        "B staged its blob"
    );
    assert!(
        staged_blob(sync_dir.path(), &sha(&v2), "epub").is_some(),
        "the superseded blob stays under its own hash"
    );

    // A replays B's ops and converges: the whole pair, not a mix, under the
    // identity both devices merged onto.
    run(&a).await;
    let shared_uid = canonical_uid(&a, &uid).await;
    assert_eq!(
        mirrored_version(&a, shared_uid.as_str()).await,
        Some((v3_hash.clone(), v3.len() as i64)),
        "both sides converge on the newer pointer"
    );
    let (field_count, wall, dev): (i64, i64, String) = sqlx::query_as(
        "SELECT
             (SELECT COUNT(*) FROM sync_state_fields
              WHERE kind = 'file_version' AND entity_uid = ?1),
             hlc_wall, hlc_device
         FROM sync_state_entities WHERE kind = 'file_version' AND entity_uid = ?1",
    )
    .bind(&shared_uid)
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert_eq!(
        field_count, 2,
        "exactly the hash-size pair, nothing partial"
    );
    assert!(wall > 0, "the entity clock is the minting re-import's HLC");
    assert_eq!(dev, clock::device_id(&b.pool).await.unwrap(), "B wrote it");
}

/// The direct mint helper agrees with the reconciler path: no binding (a
/// failed hash) records nothing; a fresh binding records one row, and the
/// mirror only moves when a pass publishes.
#[tokio::test(flavor = "multi_thread")]
async fn mint_helper_is_silent_without_a_binding_or_before_publication() {
    let device = device().await;
    // No binding for this file id: nothing to mint.
    file_version::mint_after_reimport(&device.pool, 404)
        .await
        .unwrap();
    assert_eq!(file_version_dirty_rows(&device).await, 0);

    let book = add_book(&device, "book.epub", b"mint me").await;
    let file_id = file_row_id(&device, "book.epub").await;
    file_version::mint_after_reimport(&device.pool, file_id)
        .await
        .unwrap();
    assert_eq!(file_version_dirty_rows(&device).await, 1);
    let uid = book_uid(&device, book).await;
    assert_eq!(
        file_version::winning(&device.pool, &uid).await.unwrap(),
        None,
        "the mirror only moves when the capture pass publishes"
    );
}
