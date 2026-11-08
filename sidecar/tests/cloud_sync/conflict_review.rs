//! Conflict diagnostics (ADR 0017 D2): a race keeps the losing value in
//! `sync_conflicts`, nothing counts it or lists it to the user, and the lazy
//! sweep expires the rows and their paired legacy issues.

use crate::common::*;
use crate::support::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_note_edits_pick_one_winner_and_keep_the_loser() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"conflict book").await;
    let annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"conflict book").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    let b_annotation = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap()[0]
        .id;

    annotations::update_annotation(
        &a.pool,
        annotation,
        &AnnotationPatch {
            color: None,
            label: None,
            note: Some("A's note".into()),
        },
    )
    .await
    .unwrap();
    annotations::update_annotation(
        &b.pool,
        b_annotation,
        &AnnotationPatch {
            color: None,
            label: None,
            note: Some("B's note".into()),
        },
    )
    .await
    .unwrap();

    run(&b).await;
    run(&a).await;
    run(&a).await;
    run(&b).await;

    let a_note = annotations::list_annotations(&a.pool, book_id(&a, "same.epub").await)
        .await
        .unwrap()[0]
        .note
        .clone();
    let b_note = annotations::list_annotations(&b.pool, book_id(&b, "same.epub").await)
        .await
        .unwrap()[0]
        .note
        .clone();
    assert_eq!(a_note, b_note, "both devices converge");
    assert!(a_note.as_deref() == Some("A's note") || a_note.as_deref() == Some("B's note"));
    // The loser is kept as diagnostics on whichever device applied the losing
    // op first; with write-time clocks the true write order decides, so the
    // row can land on either side, but exactly one value is discarded.
    let a_conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&a.pool)
        .await
        .unwrap();
    let b_conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(
        a_conflicts + b_conflicts,
        1,
        "one raced field, one discarded value"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_discarded_value_is_recorded_with_both_values_devices_and_clocks() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "review.epub", b"conflict review bytes").await;
    let uid = book_uid(&a, book).await;
    let annotation = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let annotation_uid = annotation_sync_uid(&a, annotation).await;

    publish_op(
        sync_dir.path(),
        REVIEW_WALL + 20,
        &review_op(
            REVIEW_WALL + 20,
            EntityKind::Annotation,
            &annotation_uid,
            &uid,
            json!({ "note": "kept note" }),
        ),
        &[&a],
    )
    .await;
    publish_op(
        sync_dir.path(),
        REVIEW_WALL + 10,
        &review_op(
            REVIEW_WALL + 10,
            EntityKind::Annotation,
            &annotation_uid,
            &uid,
            json!({ "note": "discarded note" }),
        ),
        &[&a],
    )
    .await;

    let row: (String, String, String, i64, i64, String, i64, i64, String) = sqlx::query_as(
        "SELECT kind, field, loser_json, winner_wall, winner_count, winner_dev,
                loser_wall, loser_count, loser_dev
         FROM sync_conflicts WHERE entity_uid = ?1",
    )
    .bind(&annotation_uid)
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert_eq!(row.0, "annotation");
    assert_eq!(row.1, "note");
    assert_eq!(
        serde_json::from_str::<Value>(&row.2).unwrap(),
        json!("discarded note"),
        "the losing value is kept for support"
    );
    assert_eq!(
        (row.3, row.4, row.5.as_str()),
        (REVIEW_WALL + 20, 0, REVIEW_DEVICE)
    );
    assert_eq!(
        (row.6, row.7, row.8.as_str()),
        (REVIEW_WALL + 10, 0, REVIEW_DEVICE)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn diagnostics_rows_never_reach_the_user_surfaces() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "review.epub", b"quiet bytes").await;
    let uid = book_uid(&a, book).await;
    let annotation = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let annotation_uid = annotation_sync_uid(&a, annotation).await;

    publish_op(
        sync_dir.path(),
        REVIEW_WALL + 20,
        &review_op(
            REVIEW_WALL + 20,
            EntityKind::Annotation,
            &annotation_uid,
            &uid,
            json!({ "note": "kept note" }),
        ),
        &[&a],
    )
    .await;
    publish_op(
        sync_dir.path(),
        REVIEW_WALL + 10,
        &review_op(
            REVIEW_WALL + 10,
            EntityKind::Annotation,
            &annotation_uid,
            &uid,
            json!({ "note": "discarded note" }),
        ),
        &[&a],
    )
    .await;

    let row: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL")
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(row, 1, "the diagnostic row is open");

    let status = a.service.status().await.unwrap();
    let payload = serde_json::to_value(&status).unwrap();
    assert!(
        payload.get("conflicts").is_none(),
        "the status payload no longer carries a conflicts count: {payload}"
    );
    assert!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .all(|issue| issue.kind != "conflict"),
        "no review row reaches Sync issues"
    );
    assert_eq!(
        status.issues, 0,
        "the diagnostic row is not counted as an issue"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unread_conflicts_expire_after_thirty_days() {
    let a = device().await;
    let old = insert_review_conflict(
        &a,
        "annotation",
        &"a".repeat(32),
        "note",
        "2000-01-01T00:00:00.000Z",
    )
    .await;
    insert_review_state(&a, &"a".repeat(32)).await;
    insert_issue(
        &a,
        &format!("conflict:annotation:{}:note", "a".repeat(32)),
        "conflict",
    )
    .await;

    // A status refresh runs the reconcile/expire sweep: the expired row is
    // deleted and its paired legacy issue closes with it.
    a.service.status().await.unwrap();
    let remaining: Option<i64> = sqlx::query_scalar("SELECT id FROM sync_conflicts WHERE id = ?1")
        .bind(old)
        .fetch_optional(&a.pool)
        .await
        .unwrap();
    assert!(remaining.is_none(), "the expired row is gone");
    let open_issues: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_issues WHERE resolved_at IS NULL")
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(open_issues, 0, "its issue closes with it");
}
