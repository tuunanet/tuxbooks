use crate::sync::capture::{drain, write_and_apply};
use crate::sync::model::Op;
use crate::sync::store;

use super::support::{dirty_count, durable_book, insert_dirty, op_count, pool_in};

/// A capture whose apply lost a prior contention race is already published
/// and ledgered: the recapture reaches this seam with a twin op (fresh
/// op_id, same device, entity, and write-time clock). The seam must re-drive
/// the recorded op instead of writing a second file for the same write —
/// two files for one tombstone is the flaky 101-vs-100 count CI saw under
/// load (tuxbooks-a3y).
#[tokio::test]
async fn a_republished_write_reuses_its_recorded_op() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    insert_dirty(
        &pool,
        "book",
        &book_uid,
        "delete",
        Some(r#"{"snapshot_json":null,"replacement_book_uid":null}"#),
        None,
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();

    let prior_file: String =
        sqlx::query_scalar("SELECT file_name FROM sync_ops WHERE entity_uid = ?1")
            .bind(&book_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    let prior = store::read_op(&root.join(&prior_file)).unwrap();

    // The recapture mints a fresh op_id but carries the same write.
    let twin = Op {
        op_id: "twin-op-id".into(),
        ..prior.clone()
    };
    write_and_apply(&pool, &root, &twin).await.unwrap();

    let files = store::scan_ops(&root).unwrap();
    assert_eq!(
        files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect::<Vec<_>>(),
        vec![prior_file.as_str()],
        "the recorded op is the only published file"
    );
    assert_eq!(op_count(&pool).await, 1);
    assert_eq!(dirty_count(&pool).await, 0);
}
