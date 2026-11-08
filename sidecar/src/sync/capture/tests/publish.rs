use crate::sync::capture::publish::resolve_local_uid;

use super::support::pool_in;

#[tokio::test]
async fn resolve_local_uid_ignores_an_unsafe_snapshot_id() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let id: i64 =
        sqlx::query_scalar("INSERT INTO collections (name) VALUES ('Shelf') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();

    // A hostile or empty uid falls back to the local row, then mints one.
    let uid = resolve_local_uid(&pool, "collections", id, Some("../evil"), false)
        .await
        .unwrap()
        .expect("a local uid is minted");
    assert_eq!(uid.len(), 32);
    let stored: String = sqlx::query_scalar("SELECT sync_uid FROM collections WHERE id = ?1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, uid);

    // A delete with no portable uid cannot name the shared entity.
    assert!(resolve_local_uid(&pool, "collections", id, None, true)
        .await
        .unwrap()
        .is_none());
}
