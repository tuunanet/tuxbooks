use crate::common::*;
use crate::support::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn applying_the_loser_for_each_kind_converges_on_the_second_device() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "review.epub", b"apply loser bytes").await;
    let uid = book_uid(&a, a_book).await;
    let a_annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    let a_collection = collections::create_collection(&a.pool, "Shelf")
        .await
        .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let annotation_uid = annotation_sync_uid(&a, a_annotation).await;
    let collection_uid = collection_sync_uid(&a, a_collection).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "review.epub", b"apply loser bytes").await;
    run(&b).await;
    run(&b).await;

    let winners = [
        review_op(
            REVIEW_WALL + 40,
            EntityKind::Annotation,
            &annotation_uid,
            &uid,
            json!({ "note": "Winner note" }),
        ),
        review_op(
            REVIEW_WALL + 30,
            EntityKind::Metadata,
            &uid,
            &uid,
            json!({ "title": "Winner title" }),
        ),
        review_op(
            REVIEW_WALL + 20,
            EntityKind::Collection,
            &collection_uid,
            &uid,
            json!({ "name": "Winner shelf" }),
        ),
        review_op(
            REVIEW_WALL + 10,
            EntityKind::Progress,
            &uid,
            &uid,
            json!({ "progress_percent": 80.0 }),
        ),
    ];
    for op in winners {
        publish_op(sync_dir.path(), op.hlc.wall, &op, &[&a, &b]).await;
    }
    let losers = [
        review_op(
            REVIEW_WALL + 35,
            EntityKind::Annotation,
            &annotation_uid,
            &uid,
            json!({ "note": "Loser note" }),
        ),
        review_op(
            REVIEW_WALL + 25,
            EntityKind::Metadata,
            &uid,
            &uid,
            json!({ "title": "Loser title" }),
        ),
        review_op(
            REVIEW_WALL + 15,
            EntityKind::Collection,
            &collection_uid,
            &uid,
            json!({ "name": "Loser shelf" }),
        ),
        review_op(
            REVIEW_WALL + 5,
            EntityKind::Progress,
            &uid,
            &uid,
            json!({ "progress_percent": 20.0 }),
        ),
    ];
    for op in losers {
        publish_op(sync_dir.path(), op.hlc.wall, &op, &[&a, &b]).await;
    }

    let conflicts = a.service.list_conflicts().await.unwrap();
    assert_eq!(conflicts.len(), 3, "progress is never shown: {conflicts:?}");
    assert!(conflicts.iter().all(|conflict| conflict.kind != "progress"));
    let progress_issues: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues
         WHERE resolved_at IS NULL AND issue_key LIKE 'conflict:progress:%'",
    )
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert_eq!(progress_issues, 0, "progress never opens a review issue");
    for (kind, field) in [
        ("annotation", "note"),
        ("metadata", "title"),
        ("collection", "name"),
    ] {
        let conflict = conflicts
            .iter()
            .find(|conflict| conflict.kind == kind && conflict.field == field)
            .unwrap_or_else(|| panic!("missing {kind} {field} conflict"));
        assert!(conflict.can_apply_loser, "{kind} can be re-applied");
        assert!(
            a.service
                .resolve_conflict(conflict.id, "apply_loser")
                .await
                .unwrap(),
            "{kind} resolves"
        );
    }

    // Progress is settled without a prompt, so it is not reachable from the
    // list. Resolve it the same way the module can.
    let progress_id: i64 = sqlx::query_scalar(
        "SELECT id FROM sync_conflicts WHERE kind = 'progress' AND resolved_at IS NULL",
    )
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert!(a
        .service
        .resolve_conflict(progress_id, "apply_loser")
        .await
        .unwrap());

    assert_review_state(&a).await;

    run(&b).await;
    run(&b).await;
    assert_review_state(&b).await;
    assert!(a.service.list_conflicts().await.unwrap().is_empty());
    assert!(
        b.service.list_conflicts().await.unwrap().is_empty(),
        "device B settles the conflicts it replayed"
    );
    let b_open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues
         WHERE kind = 'conflict' AND resolved_at IS NULL",
    )
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert_eq!(b_open, 0, "B closes the shared conflict issues");
    assert_eq!(b.service.status().await.unwrap().conflicts, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delete_that_discarded_an_edit_can_be_restored_from_the_review() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "review.epub", b"restore edit bytes").await;
    let annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    a.service.set_device_name("Study").await.unwrap();
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    b.service.set_device_name("Desktop").await.unwrap();
    add_book(&b, "review.epub", b"restore edit bytes").await;
    run(&b).await;
    run(&b).await;

    // A deletes; B edits before it receives the tombstone.
    annotations::delete_annotation(&a.pool, annotation)
        .await
        .unwrap();
    run(&a).await;

    let b_book = book_id(&b, "review.epub").await;
    let b_annotation = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap()[0]
        .id;
    annotations::update_annotation(
        &b.pool,
        b_annotation,
        &AnnotationPatch {
            color: None,
            label: None,
            note: Some("edited after the delete".into()),
        },
    )
    .await
    .unwrap();
    run(&b).await;

    run(&a).await;
    let conflicts = a.service.list_conflicts().await.unwrap();
    let conflict = conflicts
        .iter()
        .find(|conflict| conflict.field == "__deleted__")
        .unwrap_or_else(|| panic!("no delete conflict: {conflicts:?}"));
    assert_eq!(conflict.field_label, Some("delete versus edit"));
    assert_eq!(conflict.winner, json!("deleted"));
    assert_eq!(conflict.loser["note"], json!("edited after the delete"));
    assert_eq!(
        conflict.loser_device_id,
        clock::device_id(&b.pool).await.unwrap(),
        "the losing edit names the device that made it"
    );
    assert_eq!(conflict.loser_device_name, "Desktop");
    assert!(conflict.loser_wall > 0, "the losing edit has a real time");
    assert_eq!(open_trash(&a).await, 1);
    assert_eq!(open_trash(&b).await, 1);
    assert_eq!(a.service.status().await.unwrap().trash, 1);

    assert!(a
        .service
        .resolve_conflict(conflict.id, "apply_loser")
        .await
        .unwrap());

    for device in [&a, &b] {
        run(device).await;
    }
    for device in [&a, &b] {
        let book = book_id(device, "review.epub").await;
        let restored = annotations::list_annotations(&device.pool, book)
            .await
            .unwrap();
        assert_eq!(restored.len(), 1, "the annotation is back");
        assert_eq!(
            restored[0].note.as_deref(),
            Some("edited after the delete"),
            "with the edit that lost to the tombstone"
        );
        assert_eq!(
            open_trash(device).await,
            0,
            "the restore closes Recently deleted"
        );
        assert_eq!(device.service.status().await.unwrap().trash, 0);
    }
    assert!(a.service.list_conflicts().await.unwrap().is_empty());
    assert!(
        b.service.list_conflicts().await.unwrap().is_empty(),
        "the replaying device settles its copy of the conflict"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lost_restore_can_be_applied_as_the_loser() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "review.epub", b"lost restore bytes").await;
    let uid = book_uid(&a, a_book).await;
    let a_annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let annotation_uid = annotation_sync_uid(&a, a_annotation).await;
    connect(&b, sync_dir.path()).await;
    add_book(&b, "review.epub", b"lost restore bytes").await;
    run(&b).await;
    run(&b).await;

    let state = json!({
        "kind": "bookmark",
        "cfi": "epubcfi(/6/4!/4/2,/1:0,/1:8)",
        "chapter_href": "chapter1.xhtml"
    });
    // Delete, then a restore that arrives with an older clock.
    let delete = review_delete_op(
        REVIEW_WALL + 60,
        EntityKind::Annotation,
        &annotation_uid,
        &uid,
        state.clone(),
    );
    publish_op(sync_dir.path(), delete.hlc.wall, &delete, &[&a, &b]).await;
    let restore = review_restore_op(
        REVIEW_WALL + 50,
        EntityKind::Annotation,
        &annotation_uid,
        &uid,
        state,
    );
    publish_op(sync_dir.path(), restore.hlc.wall, &restore, &[&a, &b]).await;

    let conflicts = a.service.list_conflicts().await.unwrap();
    let conflict = conflicts
        .iter()
        .find(|conflict| conflict.field == "__restore__")
        .unwrap_or_else(|| panic!("no lost restore conflict: {conflicts:?}"));
    assert_eq!(conflict.field_label, Some("restore that lost"));
    assert_eq!(conflict.winner, json!("deleted"));
    assert_eq!(open_trash(&a).await, 1);
    assert_eq!(open_trash(&b).await, 1);

    assert!(a
        .service
        .resolve_conflict(conflict.id, "apply_loser")
        .await
        .unwrap());
    run(&b).await;

    for device in [&a, &b] {
        let book = book_id(device, "review.epub").await;
        assert_eq!(
            annotation_count(device, book).await,
            1,
            "the restore now wins"
        );
        assert_eq!(open_trash(device).await, 0);
        assert_eq!(device.service.status().await.unwrap().trash, 0);
        assert!(device.service.list_conflicts().await.unwrap().is_empty());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_losing_edits_share_one_issue_until_the_last_is_resolved() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "review.epub", b"shared issue bytes").await;
    let uid = book_uid(&a, book).await;
    let annotation = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let annotation_uid = annotation_sync_uid(&a, annotation).await;

    publish_op(
        sync_dir.path(),
        REVIEW_WALL + 30,
        &review_op(
            REVIEW_WALL + 30,
            EntityKind::Annotation,
            &annotation_uid,
            &uid,
            json!({ "note": "kept note" }),
        ),
        &[&a],
    )
    .await;
    for wall in [REVIEW_WALL + 20, REVIEW_WALL + 10] {
        publish_op(
            sync_dir.path(),
            wall,
            &review_op(
                wall,
                EntityKind::Annotation,
                &annotation_uid,
                &uid,
                json!({ "note": format!("loser {wall}") }),
            ),
            &[&a],
        )
        .await;
    }

    let conflicts = a.service.list_conflicts().await.unwrap();
    assert_eq!(conflicts.len(), 2, "two losing edits");
    let shared: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues
         WHERE kind = 'conflict' AND resolved_at IS NULL",
    )
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert_eq!(shared, 1, "they share one issue");
    assert!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .all(|issue| issue.kind != "conflict"),
        "the review owns conflict rows"
    );

    assert!(a
        .service
        .resolve_conflict(conflicts[0].id, "keep_winner")
        .await
        .unwrap());
    let still_open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues WHERE kind = 'conflict' AND resolved_at IS NULL",
    )
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert_eq!(still_open, 1, "the shared issue stays open");

    assert!(a
        .service
        .resolve_conflict(conflicts[1].id, "keep_winner")
        .await
        .unwrap());
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues WHERE kind = 'conflict' AND resolved_at IS NULL",
    )
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert_eq!(open, 0, "the last resolution closes the issue");
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
    let fresh = insert_review_conflict(
        &a,
        "annotation",
        &"b".repeat(32),
        "note",
        &clock::now_rfc3339(),
    )
    .await;
    insert_review_state(&a, &"b".repeat(32)).await;
    sqlx::query(
        "INSERT INTO sync_issues (issue_key, kind, detail)
         VALUES ('conflict:annotation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:note',
                 'conflict', 'old')",
    )
    .execute(&a.pool)
    .await
    .unwrap();

    let status = a.service.status().await.unwrap();
    assert_eq!(status.conflicts, 1, "the expired row leaves the count");
    let listed = a.service.list_conflicts().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, fresh);
    let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE id = ?1")
        .bind(old)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(open, 0, "the expired row is gone");
    assert!(
        a.service.issues().await.unwrap().is_empty(),
        "its issue closes with it"
    );
}
