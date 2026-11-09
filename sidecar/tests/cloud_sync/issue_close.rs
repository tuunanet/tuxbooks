use crate::common::*;
use crate::support::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_operation_closes_when_it_is_applied_or_removed() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "ops-retry.epub", b"operation retry bytes").await;
    let uid = book_uid(&a, book).await;
    connect(&a, sync_dir.path()).await;
    let device_id = "f".repeat(32);
    let op_dir = sync_dir.path().join("TuxBooks/ops").join(&device_id);
    std::fs::create_dir_all(&op_dir).unwrap();
    std::fs::write(op_dir.join("one.json"), b"{not json").unwrap();
    std::fs::write(op_dir.join("two.json"), b"{still not json").unwrap();
    run(&a).await;
    assert_eq!(
        open_issue_kinds(&a).await,
        vec![
            "operation_retrying".to_string(),
            "operation_retrying".to_string()
        ]
    );

    // Fix one file: the next pass applies it and the current cache row closes
    // the issue without an explicit dismiss.
    let fixed = review_op(
        30,
        EntityKind::Metadata,
        &uid,
        &uid,
        json!({ "title": "Fixed operation" }),
    );
    write_manual_op(sync_dir.path(), &device_id, "one.json", &fixed);
    run(&a).await;
    let kinds = open_issue_kinds(&a).await;
    assert_eq!(
        kinds,
        vec!["operation_retrying".to_string()],
        "the applied file closes its issue"
    );

    // Remove the other file: nothing is left to retry.
    std::fs::remove_file(op_dir.join("two.json")).unwrap();
    assert_eq!(a.service.status().await.unwrap().issues, 0);
    assert!(open_issue_kinds(&a).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_a_still_broken_operation_keeps_the_issue_open() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let device_id = "f".repeat(32);
    let op_dir = sync_dir.path().join("TuxBooks/ops").join(&device_id);
    std::fs::create_dir_all(&op_dir).unwrap();
    std::fs::write(op_dir.join("broken.json"), b"{not json").unwrap();
    run(&a).await;
    let issue = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "operation_retrying")
        .expect("the broken file is listed");

    assert!(
        !a.service.retry_issue(issue.id).await.unwrap(),
        "a still broken file is not resolved"
    );
    let kept = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.id == issue.id)
        .expect("the row stays open");
    assert!(kept.detail.contains("attempt"), "{}", kept.detail);
    assert!(
        kept.detail.contains("retry did not clear"),
        "{}",
        kept.detail
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_operation_issue_ignores_a_stale_applied_row() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "stale-op.epub", b"stale operation bytes").await;
    let uid = book_uid(&a, book).await;
    connect(&a, sync_dir.path()).await;
    let device_id = "f".repeat(32);
    let op_dir = sync_dir.path().join("TuxBooks/ops").join(&device_id);
    std::fs::create_dir_all(&op_dir).unwrap();

    let first = review_op(
        40,
        EntityKind::Metadata,
        &uid,
        &uid,
        json!({ "title": "First operation" }),
    );
    write_manual_op(sync_dir.path(), &device_id, "same.json", &first);
    run(&a).await;
    assert!(open_issue_kinds(&a).await.is_empty());
    let applied: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_applied_ops WHERE file_name = ?1")
            .bind(format!("ops/{device_id}/same.json"))
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(applied, 1, "the first version applied");

    // The same path is rewritten and corrupt: the old applied row must not
    // close the fresh issue.
    std::fs::write(op_dir.join("same.json"), b"{corrupt rewrite").unwrap();
    run(&a).await;
    assert_eq!(
        open_issue_kinds(&a).await,
        vec!["operation_retrying".to_string()],
        "a stale applied-op row cannot hide the fresh failure"
    );
    // The row is the sweep's work in progress (ADR 0017 D4): listed above,
    // but outside the attention count until the attempts run out.
    assert_eq!(a.service.status().await.unwrap().issues, 0);

    let second = review_op(
        41,
        EntityKind::Metadata,
        &uid,
        &uid,
        json!({ "title": "Second operation" }),
    );
    write_manual_op(sync_dir.path(), &device_id, "same.json", &second);
    run(&a).await;
    assert!(
        open_issue_kinds(&a).await.is_empty(),
        "the fixed file closes"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_natural_projection_repairs_a_current_binding() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "natural-project.epub", b"natural project bytes").await;
    let uid = book_uid(&a, book).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let file_id = file_row_id(&a, "natural-project.epub").await;

    // Shared state is waiting for a projection that failed after identity was
    // already current. The open issue must make the next sweep project even
    // though the binding did not change.
    let annotation_uid = "c".repeat(32);
    sqlx::query(
        "INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
         VALUES ('annotation', ?1, ?2)",
    )
    .bind(&annotation_uid)
    .bind(&uid)
    .execute(&a.pool)
    .await
    .unwrap();
    insert_issue(&a, &format!("project-book:{file_id}"), "projection_failed").await;

    run(&a).await;
    assert!(
        !open_issue_kinds(&a)
            .await
            .iter()
            .any(|kind| kind == "projection_failed"),
        "the current binding projected and closed the issue"
    );
    let projected: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE sync_uid = ?1")
        .bind(&annotation_uid)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(projected, 1, "the shared annotation was projected");
}

#[tokio::test(flavor = "multi_thread")]
async fn natural_repairs_close_identity_and_reprojection_issues() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "natural-repair.epub", b"natural repair bytes").await;
    let uid = book_uid(&a, book).await;
    connect(&a, sync_dir.path()).await;
    let file_id = file_row_id(&a, "natural-repair.epub").await;

    // A missing binding makes the next identity sweep hash and bind again.
    sqlx::query("DELETE FROM sync_book_bindings WHERE book_id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    insert_issue(&a, &format!("identity:{file_id}"), "identity_failed").await;
    insert_issue(&a, &format!("reproject:{uid}"), "reprojection_failed").await;
    sqlx::query("INSERT INTO sync_reproject (book_uid) VALUES (?1)")
        .bind(&uid)
        .execute(&a.pool)
        .await
        .unwrap();

    run(&a).await;
    assert!(
        open_issue_kinds(&a).await.is_empty(),
        "a natural pass closes both: {:?}",
        open_issue_kinds(&a).await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn conflicts_are_never_dismissed() {
    let a = device().await;
    let uid = "a".repeat(32);
    let device = "f".repeat(32);
    sqlx::query(
        "INSERT INTO sync_state_fields
             (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES ('annotation', ?1, 'note', '\"kept\"', 2, 0, ?2)",
    )
    .bind(&uid)
    .bind(&device)
    .execute(&a.pool)
    .await
    .unwrap();
    insert_review_conflict(&a, "annotation", &uid, "note", "2026-10-30T00:00:00.000Z").await;
    let conflict = insert_issue(&a, &format!("conflict:annotation:{uid}:note"), "conflict").await;
    let informational = insert_issue(&a, "dirty-kind:mystery", "invalid_dirty_kind").await;

    assert!(
        !a.service.dismiss_issue(conflict).await.unwrap(),
        "a conflict is not dismissible"
    );
    assert_eq!(
        a.service.dismiss_all_issues().await.unwrap(),
        1,
        "Dismiss all closes only the informational row"
    );
    let conflict_open: Option<String> =
        sqlx::query_scalar("SELECT resolved_at FROM sync_issues WHERE id = ?1")
            .bind(conflict)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert!(conflict_open.is_none(), "the live conflict stays open");
    let info_open: Option<String> =
        sqlx::query_scalar("SELECT resolved_at FROM sync_issues WHERE id = ?1")
            .bind(informational)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert!(info_open.is_some(), "the informational row is dismissed");
}
