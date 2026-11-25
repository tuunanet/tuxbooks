//! Restore-plus-attach with sync connected (tuxbooks-t9p.4). The mirror's
//! tombstone for the forgotten uid stays open until a pass publishes the
//! restore; the combined command must close it before the picked file's
//! hash is bound, or the file lands on a freshly minted identity.

use crate::common::*;
use sha2::{Digest, Sha256};

fn sha256_of(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap();
    format!("{:x}", Sha256::digest(&bytes))
}

fn pick_copy(env: &Env, name: &str, source: &Path) -> PathBuf {
    let picks = env._tmp.path().join("picks");
    std::fs::create_dir_all(&picks).unwrap();
    let path = picks.join(name);
    std::fs::copy(source, &path).unwrap();
    path
}

async fn connect_service(env: &mut Env) -> (Arc<SyncService>, TempDir) {
    let emitter = EventEmitter::new(|_name: &'static str, _payload: Value| {});
    let service = Arc::new(
        SyncService::new(env.pool.clone(), &env.db_path, emitter)
            .await
            .unwrap(),
    );
    env.sync = Some(Arc::clone(&service));
    let folder = tempfile::tempdir().unwrap();
    let connected = service
        .connect(folder.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    assert!(connected.mismatch.is_none());
    // No `service.start()`: passes run when the test (or the command) asks,
    // so the tombstone stays open exactly as long as production allows.
    (service, folder)
}

/// With sync on, restore with a picked file binds the hash to the restored
/// record's identity, publishes the restore, and closes the tombstone.
#[tokio::test(flavor = "multi_thread")]
async fn a_sync_connected_restore_binds_the_pick_to_the_restored_identity() {
    let mut env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    env.save_progress(book.id, 31.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    let (service, sync_dir) = connect_service(&mut env).await;
    service.run_pass().await.unwrap();

    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();
    service.run_pass().await.unwrap();

    let open: Option<String> = sqlx::query_scalar(
        "SELECT restored_at FROM sync_book_trash WHERE book_uid = ?1 AND restored_at IS NULL",
    )
    .bind(&old_uid)
    .fetch_optional(&env.pool)
    .await
    .unwrap();
    assert!(open.is_some(), "the mirror holds the tombstone open");

    let picked = pick_copy(&env, "restored.epub", &minimal_epub());
    let result = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": picked.to_string_lossy() }),
        )
        .await;
    assert_eq!(result["status"], json!("restored"));
    assert_eq!(result["bookUid"].as_str(), Some(old_uid.as_str()));

    // The publish pass can move the durable id; the response names the id
    // the record holds now.
    let live_id: i64 =
        sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
            .bind(&old_uid)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(result["bookId"].as_i64(), Some(live_id));

    let hash = sha256_of(&picked);
    assert_eq!(
        env.alias_owner(&hash).await.as_deref(),
        Some(old_uid.as_str()),
        "the picked bytes stay on the restored identity"
    );
    let bound: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_bindings WHERE content_hash = ?1")
            .bind(&hash)
            .fetch_optional(&env.pool)
            .await
            .unwrap();
    assert_eq!(
        bound.as_deref(),
        Some(old_uid.as_str()),
        "the binding names the restored record's uid"
    );
    let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(bindings, 1, "no fresh identity was minted");

    let restored = books::get_book(&env.pool, live_id).await.unwrap().unwrap();
    assert_eq!(restored.path, picked.to_string_lossy());
    assert_eq!(restored.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(env.progress_percent(live_id).await, Some(31.0));
    assert_eq!(env.annotation_count(live_id).await, 1);
    assert_eq!(env.durable_count().await, 1);
    assert!(env.trash().await.is_empty());

    let closed: Option<String> =
        sqlx::query_scalar("SELECT restored_at FROM sync_book_trash WHERE book_uid = ?1")
            .bind(&old_uid)
            .fetch_optional(&env.pool)
            .await
            .unwrap();
    assert!(closed.is_some(), "the tombstone is closed");
    // The restore reached the folder as a shared restore op, not a delete.
    let root = store::resolve_root(sync_dir.path()).unwrap();
    let restores: Vec<String> = store::scan_ops(&root)
        .unwrap()
        .into_iter()
        .map(|file| {
            let op = store::read_op(&file.path)
                .unwrap_or_else(|err| panic!("op {} is readable: {err}", file.relative_path));
            (op.kind, op.deleted, op.restore, op.entity_uid)
        })
        .filter_map(|(kind, deleted, restore, uid)| {
            (kind == EntityKind::Book && !deleted && restore && uid == old_uid)
                .then_some(uid)
        })
        .collect();
    assert_eq!(restores.len(), 1, "the restore was published to the folder");
}
