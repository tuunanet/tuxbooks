use crate::sync::capture::drain;
use crate::sync::store;

use super::support::{dirty_count, durable_book, insert_dirty, pool_in};

/// The dirty row carries the clock its write transaction minted
/// (migration 0030, ADR 0017 D3), and the capture pass must publish
/// exactly that clock even when the stored clock has moved on.
#[tokio::test]
async fn a_dirty_row_publishes_the_clock_its_write_minted() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let annotation_uid = "ab".repeat(16);
    // The local write: the trigger chain stamps the dirty row inside the
    // same transaction.
    sqlx::query(
        "INSERT INTO annotations (book_uid, sync_uid, kind, text)
         VALUES (?1, ?2, 'bookmark', 'written while offline')",
    )
    .bind(&book_uid)
    .bind(&annotation_uid)
    .execute(&pool)
    .await
    .unwrap();
    let (wall, counter): (i64, i64) =
        sqlx::query_as("SELECT hlc_wall, hlc_counter FROM sync_dirty WHERE kind = 'annotation'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        wall > 0,
        "the write minted a clock, got ({wall}, {counter})"
    );

    // The pass drains much later and the stored clock has moved on; the
    // published op must still carry the write-time clock.
    crate::sync::clock::set_meta(&pool, crate::sync::clock::META_HLC, "9999999999999:0")
        .await
        .unwrap();
    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 1);
    let published: (i64, i64) =
        sqlx::query_as("SELECT hlc_wall, hlc_counter FROM sync_ops WHERE entity_uid = ?1")
            .bind(&annotation_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        published,
        (wall, counter),
        "the op carries the write-time clock, not a publish-time mint"
    );
    assert_eq!(dirty_count(&pool).await, 0);
}

/// A row written before migration 0030 has no clock (simulated by
/// clearing it). Those keep the old behavior: the op mints at publish.
#[tokio::test]
async fn a_clockless_legacy_row_still_mints_at_publish() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let annotation_uid = "cd".repeat(16);
    insert_dirty(
        &pool,
        "annotation",
        "1",
        "upsert",
        None,
        Some(&format!(
            r#"{{"book_uid":"{book_uid}","sync_uid":"{annotation_uid}","kind":"bookmark"}}"#
        )),
    )
    .await;
    sqlx::query("UPDATE sync_dirty SET hlc_wall = NULL, hlc_counter = NULL")
        .execute(&pool)
        .await
        .unwrap();
    crate::sync::clock::set_meta(&pool, crate::sync::clock::META_HLC, "9999999999999:0")
        .await
        .unwrap();

    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 1);
    let (wall, counter): (i64, i64) =
        sqlx::query_as("SELECT hlc_wall, hlc_counter FROM sync_ops WHERE entity_uid = ?1")
            .bind(&annotation_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        wall, 9_999_999_999_999,
        "minted at publish, after the stored clock"
    );
    assert_eq!(counter, 1);
}

/// Two writes that land in one millisecond must not share a clock: the
/// trigger mints once per row, so the counter keeps the rows apart.
#[tokio::test]
async fn two_dirty_writes_in_one_millisecond_never_share_a_clock() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    // A frozen wall forces every mint into the same millisecond, which is
    // the only case where two clocks could collide.
    crate::sync::clock::set_meta(&pool, crate::sync::clock::META_HLC, "9999999999999:0")
        .await
        .unwrap();
    insert_dirty(&pool, "progress", "1", "upsert", None, Some("{}")).await;
    insert_dirty(&pool, "progress", "2", "upsert", None, Some("{}")).await;

    let mut clocks: Vec<(i64, i64)> =
        sqlx::query_as("SELECT hlc_wall, hlc_counter FROM sync_dirty ORDER BY entity_key")
            .fetch_all(&pool)
            .await
            .unwrap();
    clocks.sort();
    assert_eq!(clocks[0].0, 9_999_999_999_999, "the frozen wall is kept");
    assert_ne!(clocks[0], clocks[1], "the counter separates the two writes");
    assert_eq!(
        clocks[1].1,
        clocks[0].1 + 1,
        "the second write follows the first"
    );
}
