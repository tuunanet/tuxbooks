//! Book identity merge tests: every piece of state follows the winner.

use super::*;

#[tokio::test]
async fn merging_two_identities_moves_every_piece_of_state() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (loser, winner) = two_durable_books(&pool, tmp.path()).await;

    let collection_id: i64 =
        sqlx::query_scalar("INSERT INTO collections (name) VALUES ('Shelf') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO annotations (book_uid, sync_uid, kind) VALUES (?1, ?2, 'bookmark')")
        .bind(&loser)
        .bind("a3".repeat(16))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO reading_progress (book_uid, progress_percent, updated_at)
         VALUES (?1, 80.0, '2026-02-01T00:00:00.000Z')",
    )
    .bind(&loser)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO reading_progress (book_uid, progress_percent, updated_at)
         VALUES (?1, 10.0, '2026-01-01T00:00:00.000Z')",
    )
    .bind(&winner)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO book_metadata_overrides (book_uid, title) VALUES (?1, 'Loser title')")
        .bind(&loser)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO book_collections (book_uid, collection_id) VALUES (?1, ?2)")
        .bind(&loser)
        .bind(collection_id)
        .execute(&pool)
        .await
        .unwrap();

    // Mirror state under both identities, with the loser's clocks newer.
    state_row(&pool, "progress", &loser, &loser, 200).await;
    state_field(&pool, "progress", &loser, "progress_percent", "80.0", 200).await;
    state_row(&pool, "progress", &winner, &winner, 100).await;
    state_field(&pool, "progress", &winner, "progress_percent", "10.0", 100).await;
    state_row(&pool, "opened", &loser, &loser, 50).await;
    state_field(
        &pool,
        "opened",
        &loser,
        "last_opened_at",
        "\"2026-02-01T00:00:00.000Z\"",
        50,
    )
    .await;
    state_row(&pool, "metadata", &loser, &loser, 0).await;
    state_field(&pool, "metadata", &loser, "title", "\"Loser title\"", 60).await;
    let membership = format!("collection-uid:{loser}");
    state_row(&pool, "membership", &membership, &loser, 70).await;
    sqlx::query(
        "INSERT INTO sync_trash
            (kind, entity_uid, book_uid, prior_json, deleted_wall, deleted_count,
             deleted_dev, deleted_at, expires_at)
         VALUES ('annotation', 'gone', ?1, '{}', 1, 0, 'other',
                 '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')",
    )
    .bind(&loser)
    .execute(&pool)
    .await
    .unwrap();

    merge_book_identity(&pool, &loser, &winner).await.unwrap();

    let old_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&loser)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(old_exists, 0, "the losing durable record is folded in");
    let (percent, annotations): (Option<f64>, i64) = sqlx::query_as(
        "SELECT progress_percent, annotation_count FROM book_records WHERE uid = ?1",
    )
    .bind(&winner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(percent, Some(80.0), "the newer locator wins");
    assert_eq!(annotations, 1);
    let annotation_owner: String = sqlx::query_scalar("SELECT book_uid FROM annotations LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(annotation_owner, winner);
    let progress: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM reading_progress WHERE book_uid = ?1")
            .bind(&loser)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(progress, 0, "the loser's progress row is deleted");
    let override_owner: String =
        sqlx::query_scalar("SELECT book_uid FROM book_metadata_overrides LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(override_owner, winner);
    let shelf: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2",
    )
    .bind(&winner)
    .bind(collection_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(shelf, 1, "memberships are unioned");
    let membership_owner: String = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities WHERE kind = 'membership' LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(membership_owner, format!("collection-uid:{winner}"));
    let trash_owner: String = sqlx::query_scalar("SELECT book_uid FROM sync_trash LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(trash_owner, winner);
    let (state, deleted) =
        crate::sync::merge::load_state(&pool, crate::sync::model::EntityKind::Progress, &winner)
            .await
            .unwrap();
    assert!(!deleted);
    assert_eq!(
        state.get("progress_percent"),
        Some(&serde_json::json!(80.0))
    );
    let loser_state: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_state_fields WHERE kind = 'progress' AND entity_uid = ?1",
    )
    .bind(&loser)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(loser_state, 0);
}

#[tokio::test]
async fn merging_identities_declines_when_forgotten_or_already_equal() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (a, b) = two_durable_books(&pool, tmp.path()).await;

    merge_book_identity(&pool, &a, &a).await.unwrap();
    let merges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_merges")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(merges, 0, "the same identity needs no merge");

    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, snapshot_json, deleted_wall, deleted_count, deleted_dev,
             deleted_at, expires_at)
         VALUES (?1, NULL, 1, 0, 'other', '2026-01-01T00:00:00.000Z',
                 '2999-01-01T00:00:00.000Z')",
    )
    .bind(&b)
    .execute(&pool)
    .await
    .unwrap();
    merge_book_identity(&pool, &a, &b).await.unwrap();
    let merges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_merges")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        merges, 0,
        "a forgotten identity is not resurrected by a merge"
    );
    let still_there: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(still_there, 1);
}

#[tokio::test]
async fn merging_identities_keeps_the_newer_entity_clock() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (loser, winner) = two_durable_books(&pool, tmp.path()).await;
    state_row(&pool, "progress", &loser, &loser, 100).await;
    state_field(&pool, "progress", &loser, "progress_percent", "10.0", 100).await;
    state_row(&pool, "progress", &winner, &winner, 200).await;
    state_field(&pool, "progress", &winner, "progress_percent", "20.0", 200).await;

    merge_book_identity(&pool, &loser, &winner).await.unwrap();

    let (state, _) =
        crate::sync::merge::load_state(&pool, crate::sync::model::EntityKind::Progress, &winner)
            .await
            .unwrap();
    assert_eq!(
        state.get("progress_percent"),
        Some(&serde_json::json!(20.0)),
        "the winner's newer locator survives"
    );
    let loser_fields: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_state_fields WHERE kind = 'progress' AND entity_uid = ?1",
    )
    .bind(&loser)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(loser_fields, 0);
}

#[tokio::test]
async fn merging_identities_keeps_the_newer_membership_entity() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (loser, winner) = two_durable_books(&pool, tmp.path()).await;
    let collection = "c2".repeat(16);
    state_row(
        &pool,
        "membership",
        &format!("{collection}:{loser}"),
        &loser,
        300,
    )
    .await;
    state_field(
        &pool,
        "membership",
        &format!("{collection}:{loser}"),
        "present",
        "true",
        300,
    )
    .await;
    state_row(
        &pool,
        "membership",
        &format!("{collection}:{winner}"),
        &winner,
        100,
    )
    .await;
    state_field(
        &pool,
        "membership",
        &format!("{collection}:{winner}"),
        "present",
        "false",
        100,
    )
    .await;

    merge_book_identity(&pool, &loser, &winner).await.unwrap();

    let (state, deleted) = crate::sync::merge::load_state(
        &pool,
        crate::sync::model::EntityKind::Membership,
        &format!("{collection}:{winner}"),
    )
    .await
    .unwrap();
    assert!(!deleted);
    assert_eq!(
        state.get("present"),
        Some(&serde_json::json!(true)),
        "the newer membership record wins"
    );
}
