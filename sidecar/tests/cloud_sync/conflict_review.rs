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
async fn conflicts_list_the_book_values_devices_and_clocks() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "review.epub", b"conflict review bytes").await;
    let uid = book_uid(&a, book).await;
    let annotation = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let annotation_uid = annotation_sync_uid(&a, annotation).await;

    // The writing device has a readable name in the folder.
    let device_dir = sync_dir.path().join("TuxBooks/devices").join(REVIEW_DEVICE);
    std::fs::create_dir_all(&device_dir).unwrap();
    std::fs::write(
        device_dir.join("device.json"),
        serde_json::to_vec(&json!({
            "schema": 1,
            "device_id": REVIEW_DEVICE,
            "name": "Other machine",
            "created_at": "2026-10-30T00:00:00.000Z"
        }))
        .unwrap(),
    )
    .unwrap();

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

    let conflicts = a.service.list_conflicts().await.unwrap();
    assert_eq!(conflicts.len(), 1, "one losing note: {conflicts:?}");
    let review = &conflicts[0];
    assert_eq!(review.kind, "annotation");
    assert_eq!(review.entity_uid, annotation_uid);
    assert_eq!(review.book_uid.as_deref(), Some(uid.as_str()));
    assert_eq!(review.book_title.as_deref(), Some("review"));
    assert_eq!(review.book_author.as_deref(), Some("Author"));
    assert_eq!(review.field, "note");
    assert_eq!(review.field_label, None);
    assert_eq!(review.winner, json!("kept note"));
    assert_eq!(review.loser, json!("discarded note"));
    assert_eq!(review.winner_device_id, REVIEW_DEVICE);
    assert_eq!(review.winner_device_name, "Other machine");
    assert_eq!(review.loser_device_name, "Other machine");
    assert_eq!(
        (review.winner_wall, review.winner_counter),
        (REVIEW_WALL + 20, 0)
    );
    assert_eq!(
        (review.loser_wall, review.loser_counter),
        (REVIEW_WALL + 10, 0)
    );
    assert!(review.can_apply_loser);
    assert_eq!(a.service.status().await.unwrap().conflicts, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeping_the_winner_resolves_the_row_and_issue_without_touching_state() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "review.epub", b"keep winner bytes").await;
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

    let conflict = a.service.list_conflicts().await.unwrap().remove(0);
    assert!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .all(|issue| issue.kind != "conflict"),
        "conflicts stay in the review list, not Sync issues"
    );
    assert_eq!(a.service.status().await.unwrap().conflicts, 1);
    assert_eq!(
        a.service.status().await.unwrap().issues,
        0,
        "conflicts are counted by the review, not as Sync issues"
    );
    assert!(a
        .service
        .resolve_conflict(conflict.id, "keep_winner")
        .await
        .unwrap());
    assert!(a.service.list_conflicts().await.unwrap().is_empty());
    assert!(
        a.service.issues().await.unwrap().is_empty(),
        "the issue closes"
    );
    assert_eq!(a.service.status().await.unwrap().conflicts, 0);

    let book_row = book_id(&a, "review.epub").await;
    let note = annotations::list_annotations(&a.pool, book_row)
        .await
        .unwrap()[0]
        .note
        .clone();
    assert_eq!(
        note.as_deref(),
        Some("kept note"),
        "the winner stays applied"
    );

    assert!(
        !a.service
            .resolve_conflict(conflict.id, "keep_winner")
            .await
            .unwrap(),
        "an already resolved conflict is not resolved twice"
    );
    assert!(matches!(
        a.service
            .resolve_conflict(conflict.id, "apply_winner")
            .await,
        Err(AppError::InvalidInput(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn conflicts_still_list_with_device_ids_when_sync_is_off_or_the_folder_is_gone() {
    let off = device().await;
    let id = insert_review_conflict(
        &off,
        "annotation",
        &"d".repeat(32),
        "note",
        &clock::now_rfc3339(),
    )
    .await;
    insert_review_state(&off, &"d".repeat(32)).await;
    let listed = off.service.list_conflicts().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].winner_device_name, "f".repeat(32));
    assert_eq!(listed[0].loser_device_name, "f".repeat(32));

    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let vanished = insert_review_conflict(
        &a,
        "annotation",
        &"e".repeat(32),
        "note",
        &clock::now_rfc3339(),
    )
    .await;
    insert_review_state(&a, &"e".repeat(32)).await;
    std::fs::remove_dir_all(sync_dir.path()).unwrap();
    let listed = a.service.list_conflicts().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, vanished);
    assert_eq!(listed[0].winner_device_name, "f".repeat(32));
}
