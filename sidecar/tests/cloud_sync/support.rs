//! Conflict-review and sync-issue fixtures shared across test modules.

use crate::common::*;

// Conflict review tests use manual operations with a clock far ahead of the
// wall clock, so ordering is explicit and a resolution's fresh clock is still
// newer than every seeded write.
pub const REVIEW_WALL: i64 = 9_000_000_000_000;
pub const REVIEW_DEVICE: &str = "cccccccccccccccccccccccccccccccc";

pub fn review_op(
    wall: i64,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: &str,
    fields: Value,
) -> Op {
    Op {
        schema: OP_SCHEMA,
        op_id: format!("{wall:032x}"),
        device_id: REVIEW_DEVICE.into(),
        hlc: Hlc {
            wall,
            counter: 0,
            device: REVIEW_DEVICE.into(),
        },
        kind,
        entity_uid: entity_uid.into(),
        book_uid: Some(book_uid.into()),
        deleted: false,
        restore: false,
        fields: fields.as_object().cloned().unwrap(),
        prior: None,
        created_at: "2026-10-30T00:00:00.000Z".into(),
    }
}

pub async fn publish_op(folder: &Path, wall: i64, op: &Op, devices: &[&Device]) {
    write_manual_op(folder, REVIEW_DEVICE, &format!("{wall}.json"), op);
    for device in devices {
        run(device).await;
    }
}

pub fn review_delete_op(
    wall: i64,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: &str,
    prior: Value,
) -> Op {
    Op {
        schema: OP_SCHEMA,
        op_id: format!("{wall:032x}"),
        device_id: REVIEW_DEVICE.into(),
        hlc: Hlc {
            wall,
            counter: 0,
            device: REVIEW_DEVICE.into(),
        },
        kind,
        entity_uid: entity_uid.into(),
        book_uid: Some(book_uid.into()),
        deleted: true,
        restore: false,
        fields: serde_json::Map::new(),
        prior: prior.as_object().cloned(),
        created_at: "2026-10-30T00:00:00.000Z".into(),
    }
}

pub fn review_restore_op(
    wall: i64,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: &str,
    fields: Value,
) -> Op {
    Op {
        schema: OP_SCHEMA,
        op_id: format!("{wall:032x}"),
        device_id: REVIEW_DEVICE.into(),
        hlc: Hlc {
            wall,
            counter: 0,
            device: REVIEW_DEVICE.into(),
        },
        kind,
        entity_uid: entity_uid.into(),
        book_uid: Some(book_uid.into()),
        deleted: false,
        restore: true,
        fields: fields.as_object().cloned().unwrap(),
        prior: None,
        created_at: "2026-10-30T00:00:00.000Z".into(),
    }
}

pub async fn open_trash(device: &Device) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_trash WHERE restored_at IS NULL")
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

pub async fn annotation_sync_uid(device: &Device, id: i64) -> String {
    sqlx::query_scalar("SELECT sync_uid FROM annotations WHERE id = ?1")
        .bind(id)
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

pub async fn collection_sync_uid(device: &Device, id: i64) -> String {
    sqlx::query_scalar("SELECT sync_uid FROM collections WHERE id = ?1")
        .bind(id)
        .fetch_one(&device.pool)
        .await
        .unwrap()
}

pub async fn insert_review_conflict(
    device: &Device,
    kind: &str,
    entity_uid: &str,
    field: &str,
    created_at: &str,
) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO sync_conflicts
            (kind, entity_uid, field, winner_json, loser_json,
             winner_wall, winner_count, winner_dev,
             loser_wall, loser_count, loser_dev, created_at)
         VALUES (?1, ?2, ?3, '\"kept\"', '\"dropped\"', 2, 0, ?4, 1, 0, ?4, ?5)
         RETURNING id",
    )
    .bind(kind)
    .bind(entity_uid)
    .bind(field)
    .bind("f".repeat(32))
    .bind(created_at)
    .fetch_one(&device.pool)
    .await
    .unwrap()
}

/// Every kind resolved to its losing value, on any device that ran a pass.
pub async fn assert_review_state(device: &Device) {
    let book = book_id(device, "review.epub").await;
    let note = annotations::list_annotations(&device.pool, book)
        .await
        .unwrap()[0]
        .note
        .clone();
    assert_eq!(note.as_deref(), Some("Loser note"));
    let row = books::get_book(&device.pool, book).await.unwrap().unwrap();
    assert_eq!(row.title, "Loser title");
    let shelves = collections::list_collection_summaries(&device.pool)
        .await
        .unwrap();
    assert_eq!(shelves.len(), 1);
    assert_eq!(shelves[0].name, "Loser shelf");
    assert_eq!(progress_percent(device, book).await, Some(20.0));
}

pub async fn insert_review_state(device: &Device, entity_uid: &str) {
    sqlx::query(
        "INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES ('annotation', ?1, 'note', '\"kept\"', 2, 0, ?2)",
    )
    .bind(entity_uid)
    .bind("f".repeat(32))
    .execute(&device.pool)
    .await
    .unwrap();
}

pub async fn insert_issue(device: &Device, key: &str, kind: &str) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO sync_issues (issue_key, kind, detail)
         VALUES (?1, ?2, 'test detail') RETURNING id",
    )
    .bind(key)
    .bind(kind)
    .fetch_one(&device.pool)
    .await
    .unwrap()
}

pub async fn open_issue_kinds(device: &Device) -> Vec<String> {
    sqlx::query_scalar("SELECT kind FROM sync_issues WHERE resolved_at IS NULL ORDER BY kind")
        .fetch_all(&device.pool)
        .await
        .unwrap()
}
