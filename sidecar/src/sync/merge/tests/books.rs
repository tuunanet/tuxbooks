//! Whole-book lifecycle: Forget, restore, discard, and the portable identity
//! ops that re-key book rows.

use serde_json::{json, Map};

use super::support::{create_book, forget_book, op, rand_id};
use crate::error::AppError;
use crate::sync::merge::apply_op;
use crate::sync::model::EntityKind;

#[tokio::test]
async fn an_identity_op_requires_a_hash_and_respects_a_forgotten_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;

    let missing = op(EntityKind::BookIdentity, &book, &book, json!({}));
    let err = apply_op(&pool, &missing, "a.json").await.unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");

    // Forgotten without a replacement: never republish the alias.
    let dead = "1".repeat(32);
    forget_book(&pool, &dead, None).await;
    let op_dead = op(
        EntityKind::BookIdentity,
        &dead,
        &dead,
        json!({"content_hash": "d".repeat(64)}),
    );
    assert!(apply_op(&pool, &op_dead, "b.json")
        .await
        .unwrap()
        .is_empty());
    let aliases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(aliases, 0);

    // Forgotten with a replacement: the alias follows the live identity.
    let old = "2".repeat(32);
    let fresh = "3".repeat(32);
    forget_book(&pool, &old, Some(&fresh)).await;
    let hash = "e".repeat(64);
    let op_live = op(
        EntityKind::BookIdentity,
        &old,
        &old,
        json!({"content_hash": hash}),
    );
    let affected = apply_op(&pool, &op_live, "c.json").await.unwrap();
    assert_eq!(affected.len(), 1);
    assert_eq!(affected[0].entity_uid, fresh);
    let owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, fresh);
}

#[tokio::test]
async fn a_book_forget_restore_and_discard_move_the_aliases_and_respect_older_clocks() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let uid = "4".repeat(32);
    let replacement = "5".repeat(32);
    let old_hash = "a".repeat(64);
    let new_hash = "b".repeat(64);
    let snapshot = json!({"aliases": [old_hash.clone()]}).to_string();

    let mut forget = op(EntityKind::Book, &uid, &uid, json!({}));
    forget.deleted = true;
    forget.fields = Map::new();
    forget.hlc.wall = 100;
    forget.prior = Some(
        json!({
            "snapshot": snapshot,
            "replacement_book_uid": replacement,
            "discarded": null,
        })
        .as_object()
        .cloned()
        .unwrap(),
    );
    let affected = apply_op(&pool, &forget, "a.json").await.unwrap();
    assert_eq!(affected.len(), 1);
    let (restored, discarded): (Option<String>, i64) =
        sqlx::query_as("SELECT restored_at, discarded FROM sync_book_trash WHERE book_uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(restored.is_none());
    assert_eq!(discarded, 0);
    let owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&old_hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        owner, replacement,
        "the snapshot alias moves to the fresh id"
    );

    // A stale Forget loses to the one already recorded.
    let mut stale_forget = forget.clone();
    stale_forget.op_id = format!("{:032x}", rand_id());
    stale_forget.hlc.wall = 99;
    assert!(apply_op(&pool, &stale_forget, "b.json")
        .await
        .unwrap()
        .is_empty());

    // Restore clears the tombstone and brings the snapshot aliases back.
    let mut restore = op(EntityKind::Book, &uid, &uid, json!({}));
    restore.fields = json!({
        "snapshot": json!({"aliases": [new_hash.clone()]}).to_string(),
        "replacement_book_uid": replacement,
        "discarded": false,
    })
    .as_object()
    .cloned()
    .unwrap();
    restore.hlc.wall = 300;
    apply_op(&pool, &restore, "c.json").await.unwrap();
    let (restored, deleted): (Option<String>, i64) = sqlx::query_as(
        "SELECT t.restored_at, e.deleted FROM sync_book_trash t
         JOIN sync_state_entities e ON e.kind = 'book' AND e.entity_uid = t.book_uid
         WHERE t.book_uid = ?1",
    )
    .bind(&uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(restored.is_some());
    assert_eq!(deleted, 0);
    let fresh_aliases: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(&replacement)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(fresh_aliases, 0, "the replacement's aliases are dropped");
    let owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&new_hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, uid);

    // An older restore loses to the restored clock.
    let mut stale_restore = restore.clone();
    stale_restore.op_id = format!("{:032x}", rand_id());
    stale_restore.hlc.wall = 200;
    assert!(apply_op(&pool, &stale_restore, "d.json")
        .await
        .unwrap()
        .is_empty());

    // Discard keeps the identity forgotten and closes the trash entry.
    let mut discard = op(EntityKind::Book, &uid, &uid, json!({}));
    discard.fields = json!({"discarded": true, "snapshot": null})
        .as_object()
        .cloned()
        .unwrap();
    discard.hlc.wall = 400;
    apply_op(&pool, &discard, "e.json").await.unwrap();
    let (restored, discarded, deleted): (Option<String>, i64, i64) = sqlx::query_as(
        "SELECT t.restored_at, t.discarded, e.deleted FROM sync_book_trash t
         JOIN sync_state_entities e ON e.kind = 'book' AND e.entity_uid = t.book_uid
         WHERE t.book_uid = ?1",
    )
    .bind(&uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(restored.is_some());
    assert_eq!(discarded, 1);
    assert_eq!(deleted, 1);
}

#[tokio::test]
async fn a_restore_without_a_snapshot_is_reported_instead_of_claimed() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let uid = "6".repeat(32);
    let mut restore = op(EntityKind::Book, &uid, &uid, json!({}));
    restore.fields = json!({"discarded": false, "snapshot": null})
        .as_object()
        .cloned()
        .unwrap();
    restore.hlc.wall = 100;
    apply_op(&pool, &restore, "a.json").await.unwrap();
    let key: String = sqlx::query_scalar(
        "SELECT issue_key FROM sync_issues WHERE kind = 'book_snapshot_missing'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(key.starts_with("restore-snapshot-missing:"), "{key}");
    let discarded: i64 =
        sqlx::query_scalar("SELECT discarded FROM sync_book_trash WHERE book_uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(discarded, 1);
}

#[tokio::test]
async fn a_second_forget_after_a_restore_is_ignored() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let uid = "f1".repeat(16);
    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, snapshot_json, deleted_wall, deleted_count, deleted_dev,
             deleted_at, expires_at, restored_at, restored_wall, restored_count,
             restored_dev)
         VALUES (?1, NULL, 50, 0, 'other', '2026-01-01T00:00:00.000Z',
                 '2999-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 500, 0,
                 'other')",
    )
    .bind(&uid)
    .execute(&pool)
    .await
    .unwrap();

    let mut forget = op(EntityKind::Book, &uid, &uid, json!({}));
    forget.deleted = true;
    forget.fields = Map::new();
    forget.hlc.wall = 100;
    let affected = apply_op(&pool, &forget, "a.json").await.unwrap();
    assert!(
        affected.is_empty(),
        "a delayed Forget cannot undo a completed restore"
    );
    let restored: Option<String> =
        sqlx::query_scalar("SELECT restored_at FROM sync_book_trash WHERE book_uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(restored.is_some());
}

#[tokio::test]
async fn a_restore_older_than_the_tombstone_is_ignored() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let uid = "f2".repeat(16);
    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, snapshot_json, deleted_wall, deleted_count, deleted_dev,
             deleted_at, expires_at)
         VALUES (?1, NULL, 500, 0, 'other', '2026-01-01T00:00:00.000Z',
                 '2999-01-01T00:00:00.000Z')",
    )
    .bind(&uid)
    .execute(&pool)
    .await
    .unwrap();

    let mut restore = op(EntityKind::Book, &uid, &uid, json!({}));
    restore.fields = json!({"discarded": false, "snapshot": null})
        .as_object()
        .cloned()
        .unwrap();
    restore.hlc.wall = 400;
    let affected = apply_op(&pool, &restore, "a.json").await.unwrap();
    assert!(affected.is_empty());
    let restored: Option<String> =
        sqlx::query_scalar("SELECT restored_at FROM sync_book_trash WHERE book_uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(restored.is_none(), "the newer tombstone still stands");
}

#[tokio::test]
async fn apply_identity_resolves_a_forgotten_alias_owner() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    // The old alias owner has a replacement: the alias follows it.
    let hash = "d1".repeat(32);
    let dead = "d2".repeat(16);
    let fresh = "d3".repeat(16);
    forget_book(&pool, &dead, Some(&fresh)).await;
    sqlx::query("INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)")
        .bind(&hash)
        .bind(&dead)
        .execute(&pool)
        .await
        .unwrap();
    let incoming = "d4".repeat(16);
    let identity = op(
        EntityKind::BookIdentity,
        &incoming,
        &incoming,
        json!({"content_hash": hash}),
    );
    let affected = apply_op(&pool, &identity, "a.json").await.unwrap();
    assert_eq!(affected[0].entity_uid, fresh);
    let owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, fresh);

    // The old alias owner was forgotten with no replacement: the incoming
    // identity owns the hash.
    let orphan_hash = "d5".repeat(32);
    let orphan = "d6".repeat(16);
    forget_book(&pool, &orphan, None).await;
    sqlx::query("INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)")
        .bind(&orphan_hash)
        .bind(&orphan)
        .execute(&pool)
        .await
        .unwrap();
    let orphan_incoming = "a0".repeat(16);
    let identity = op(
        EntityKind::BookIdentity,
        &orphan_incoming,
        &orphan_incoming,
        json!({"content_hash": orphan_hash}),
    );
    apply_op(&pool, &identity, "b.json").await.unwrap();
    let owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&orphan_hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, orphan_incoming);
}
