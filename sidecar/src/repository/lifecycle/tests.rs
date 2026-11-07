use super::*;
use crate::db::connection::init_pool;
use crate::domain::RestoreStatus;
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// The portable shared snapshot shape: every field `BookSnapshot`
/// declares, exactly as a peer writes it (tuxbooks-5a1).
fn shared_json(uid: &str, title: &str) -> String {
    json!({
        "book_id": 7,
        "book": {
            "uid": uid,
            "created_at": "2026-11-04T00:00:00.000Z",
            "title": title,
            "subtitle": null,
            "author": "A. Author",
            "publisher": null,
            "language": null,
            "isbn": null,
            "description": null,
            "publication_date": null,
            "series": null,
            "series_index": null,
            "cover_path": null,
            "last_opened_at": null,
            "progress_percent": null,
            "annotation_count": 0,
            "metadata_state": "available"
        },
        "progress": null,
        "annotations": [],
        "collections": [],
        "overrides": null,
        "authors": [],
        "subjects": [],
        "providers": [],
        "aliases": []
    })
    .to_string()
}
async fn seed_record(pool: &SqlitePool, uid: &str) {
    sqlx::query(
        "INSERT INTO book_records (uid, title, metadata_state)
         VALUES (?1, 'Seed Title', 'available')",
    )
    .bind(uid)
    .execute(pool)
    .await
    .unwrap();
}
async fn issue_keys(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT issue_key FROM sync_issues ORDER BY issue_key")
        .fetch_all(pool)
        .await
        .unwrap()
}
/// The pending library reload, which the next sync pass flushes into one
/// `library-changed: reload` for the renderer.
async fn reload_marker(pool: &SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = ?1")
        .bind(crate::sync::clock::META_LIBRARY_RELOAD)
        .fetch_optional(pool)
        .await
        .unwrap()
}
/// A shared Forget and a shared restore both take a record away from the
/// renderer: the forgotten one, then the fresh identity the restore
/// replaces. Neither can be spelled as a per-book upsert, so both have to
/// leave the reload marker for the pass to flush (tuxbooks-jpj).
#[tokio::test(flavor = "multi_thread")]
async fn a_shared_forget_and_restore_ask_for_a_library_reload() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let uid = "b".repeat(32);
    seed_record(&pool, &uid).await;
    let shared = shared_json(&uid, "Reload Title");
    assert_eq!(
        reload_marker(&pool).await,
        None,
        "nothing asked for a reload yet"
    );
    apply_remote_forget(&pool, &uid, None, Some(&shared))
        .await
        .unwrap();
    assert_eq!(
        reload_marker(&pool).await.as_deref(),
        Some("1"),
        "the shared forget deletes an id the renderer may still hold"
    );
    apply_remote_restore(&pool, &uid, Some(&shared))
        .await
        .unwrap();
    assert_eq!(
        reload_marker(&pool).await.as_deref(),
        Some("1"),
        "the shared restore deletes the fresh identity's id"
    );
}
/// Mixed-version folders are the normal state during an upgrade: one
/// app writes a snapshot the other has never heard of. Unknown fields
/// must ride through both replay directions with the data intact.
#[tokio::test(flavor = "multi_thread")]
async fn snapshot_with_unknown_fields_still_applies() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let uid = "a".repeat(32);
    seed_record(&pool, &uid).await;
    let mut parsed: Value = serde_json::from_str(&shared_json(&uid, "Snapshot Title")).unwrap();
    parsed["future_top"] = json!(123);
    parsed["book"]["future_book"] = json!("written by a newer app");
    let shared = parsed.to_string();
    let forgotten = apply_remote_forget(&pool, &uid, None, Some(&shared))
        .await
        .unwrap();
    assert!(forgotten.is_none(), "no file, so no replacement");
    let record: Option<(i64,)> = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&uid)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(record.is_none(), "the delete applied");
    assert!(
        issue_keys(&pool).await.is_empty(),
        "unknown fields are not an error: {:?}",
        issue_keys(&pool).await
    );
    let restored = apply_remote_restore(&pool, &uid, Some(&shared))
        .await
        .unwrap()
        .expect("the shared restore recreates the book");
    assert!(restored > 0, "a real id, got {restored}");
    let (title, id): (String, i64) =
        sqlx::query_as("SELECT title, id FROM book_records WHERE uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title, "Snapshot Title", "the shared data flowed through");
    assert_eq!(id, restored, "the record carries the allocated id");
}
/// A snapshot missing a required field must degrade into a visible
/// issue on the forget path, with the delete still applied, and into an
/// Err on the restore path (the project layer turns that into
/// `book_lifecycle_failed`, pinned by tuxbooks-z67). Never a crash and
/// never a half-written row.
#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_missing_a_required_field_degrades_to_an_issue() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let uid = "b".repeat(32);
    seed_record(&pool, &uid).await;
    let mut broken: Value = serde_json::from_str(&shared_json(&uid, "Any")).unwrap();
    broken.as_object_mut().unwrap().remove("book_id");
    let broken = broken.to_string();
    let forgotten = apply_remote_forget(&pool, &uid, None, Some(&broken))
        .await
        .unwrap();
    assert!(forgotten.is_none(), "the delete applies regardless");
    let record: Option<(i64,)> = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&uid)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(record.is_none(), "the identity is gone");
    let open_trash: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM book_trash WHERE book_uid = ?1 AND restored_at IS NULL",
    )
    .bind(&uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(open_trash, 0, "no restore entry was built from garbage");
    let keys = issue_keys(&pool).await;
    assert!(
        keys.contains(&format!("forget-snapshot-invalid:{uid}")),
        "the unreadable snapshot is a visible issue: {keys:?}"
    );
    assert!(
        keys.contains(&format!("forget-snapshot:{uid}")),
        "the missing-restore fallback issue is recorded too: {keys:?}"
    );
    let err = apply_remote_restore(&pool, &uid, Some(&broken))
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("not readable"),
        "the restore path surfaces the parse failure: {err}"
    );
}
/// The 30-day promise (ADR 0014 D5): an expired entry leaves the
/// trash listing and cannot be restored by id, while a live entry
/// still restores (tuxbooks-9fk).
#[tokio::test(flavor = "multi_thread")]
async fn expired_trash_is_hidden_and_unrestorable() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let live_uid = "c".repeat(32);
    let expired_id: i64 = sqlx::query_scalar(
        "INSERT INTO book_trash (book_id, book_uid, snapshot_json, deleted_at, expires_at)
         VALUES (0, 'd', '{}', '2026-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')
         RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let live_id: i64 = sqlx::query_scalar(
        "INSERT INTO book_trash (book_id, book_uid, snapshot_json, deleted_at, expires_at)
         VALUES (0, ?1, ?2, '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
         RETURNING id",
    )
    .bind(&live_uid)
    .bind(shared_json(&live_uid, "Still Restorable"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let listed = list_trash(&pool).await.unwrap();
    assert_eq!(listed.len(), 1, "the expired entry is hidden");
    assert_eq!(listed[0].book_uid, live_uid);
    let refused = restore(&pool, expired_id, None).await.unwrap();
    assert_eq!(
        refused.status,
        RestoreStatus::NotFound,
        "an expired entry refuses restore by id"
    );
    assert!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM book_records")
            .fetch_one(&pool)
            .await
            .unwrap()
            == 0,
        "the refused restore wrote nothing"
    );
    let outcome = restore(&pool, live_id, None).await.unwrap();
    assert_eq!(outcome.status, RestoreStatus::Restored);
    let restored: (i64,) = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&live_uid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(restored.0 > 0, "the live entry restores under a real id");
}
