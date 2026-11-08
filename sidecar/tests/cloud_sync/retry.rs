use crate::common::*;
use crate::support::*;

#[tokio::test(flavor = "multi_thread")]
async fn a_corrupt_operation_is_retried_then_given_up() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let op_dir = sync_dir.path().join("TuxBooks/ops").join("f".repeat(32));
    std::fs::create_dir_all(&op_dir).unwrap();
    let op_path = op_dir.join("broken.json");

    // There is no backoff: every pass retries the file until FILE_RETRY_LIMIT
    // (5) is reached, then caches it as given up.
    std::fs::write(&op_path, b"{not json").unwrap();
    run(&a).await;
    let retrying = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "operation_retrying")
        .expect("the first failure is retried");
    assert!(retrying.detail.contains("attempt 1"), "{}", retrying.detail);

    // A changed file starts a fresh attempt count instead of carrying the
    // previous file's failures forward.
    std::fs::write(&op_path, b"{still not valid json").unwrap();
    run(&a).await;
    let reset = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "operation_retrying")
        .expect("the replacement file is retried");
    assert!(reset.detail.contains("attempt 1"), "{}", reset.detail);

    for _ in 0..4 {
        run(&a).await;
    }
    let issues = a.service.issues().await.unwrap();
    let rejected = issues
        .iter()
        .find(|issue| issue.kind == "operation_rejected")
        .expect("the file is given up after the retry limit");
    assert!(
        rejected.detail.contains("gave up after 5 attempts"),
        "{}",
        rejected.detail
    );

    // A given-up file is cached and no longer reported every pass.
    run(&a).await;
    assert_eq!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .filter(|issue| issue.file_name.as_deref()
                == Some("ops/ffffffffffffffffffffffffffffffff/broken.json"))
            .count(),
        1
    );
}

#[tokio::test]
async fn issue_actions_and_targets_are_computed_on_the_server() {
    let a = device().await;
    let book = add_book(&a, "target.epub", b"issue target bytes").await;
    let uid = book_uid(&a, book).await;
    let file_id = file_row_id(&a, "target.epub").await;

    let short = "0".repeat(32);
    let cases = [
        (
            format!("project-book:{file_id}"),
            "projection_failed",
            "retry",
            "target",
        ),
        (
            "project-book:999999".to_string(),
            "projection_failed",
            "retry",
            "Book 999999",
        ),
        (
            "project-book:not-an-id".to_string(),
            "projection_failed",
            "retry",
            "project-book:not-an-id",
        ),
        (
            format!("identity:{file_id}"),
            "identity_failed",
            "retry",
            "target",
        ),
        (
            format!("hash-failed:{book}"),
            "hash_failed",
            "retry",
            "target",
        ),
        (
            "hash-failed:999999".to_string(),
            "hash_failed",
            "retry",
            "Book 999999",
        ),
        (
            format!("reproject:{uid}"),
            "reprojection_failed",
            "retry",
            "target",
        ),
        (
            format!("reproject:{short}"),
            "reprojection_failed",
            "retry",
            "Book 00000000",
        ),
        (
            format!("book-lifecycle:{uid}"),
            "book_lifecycle_failed",
            "retry",
            "target",
        ),
        (
            format!("book-lifecycle:{short}"),
            "book_lifecycle_failed",
            "retry",
            "Book 00000000",
        ),
        ("sync-pass".to_string(), "sync_failed", "retry", "Sync pass"),
        (
            "file:ops/abc/one.json".into(),
            "operation_retrying",
            "retry",
            "ops/abc/one.json",
        ),
        (
            "file:ops/abc/bad.json".into(),
            "operation_rejected",
            "open_folder",
            "ops/abc/bad.json",
        ),
        (
            "cover-missing:0123456789abcdef.png".into(),
            "cover_missing",
            "retry",
            "0123456789abcdef.png",
        ),
        (
            "cover:0123456789abcdef.png".into(),
            "cover_blob_failed",
            "retry",
            "0123456789abcdef.png",
        ),
        (
            format!("duplicate-book:{uid}:{file_id}"),
            "duplicate_book",
            "copy_details",
            "target",
        ),
        (
            format!("duplicate-book:{short}:{file_id}"),
            "duplicate_book",
            "copy_details",
            "Book 00000000",
        ),
        (
            format!("restore-snapshot-missing:{uid}"),
            "book_snapshot_missing",
            "copy_details",
            "target",
        ),
        (
            format!("book-snapshot:{uid}"),
            "book_snapshot_invalid",
            "copy_details",
            "target",
        ),
        (
            "dirty-kind:mystery".into(),
            "invalid_dirty_kind",
            "dismiss",
            "mystery",
        ),
        (
            "future:value".into(),
            "future_kind",
            "copy_details",
            "value",
        ),
    ];
    for (key, kind, _, _) in &cases {
        insert_issue(&a, key, kind).await;
    }

    let issues = a.service.issues().await.unwrap();
    assert_eq!(issues.len(), cases.len());
    assert!(
        serde_json::to_value(&issues[0])
            .unwrap()
            .get("issueKey")
            .is_none(),
        "the internal key stays in the sidecar"
    );
    let ids: Vec<(i64, String)> = sqlx::query_as("SELECT id, issue_key FROM sync_issues")
        .fetch_all(&a.pool)
        .await
        .unwrap();
    for (key, kind, action, expected_target) in cases {
        let id = ids
            .iter()
            .find(|(_, issue_key)| issue_key == &key)
            .unwrap_or_else(|| panic!("missing issue {key}"))
            .0;
        let issue = issues
            .iter()
            .find(|issue| issue.id == id)
            .unwrap_or_else(|| panic!("missing DTO for {key}"));
        assert_eq!(issue.kind, kind);
        assert_eq!(
            serde_json::to_value(issue.action).unwrap(),
            Value::String(action.into()),
            "action for {kind}"
        );
        assert_eq!(issue.target, expected_target, "target for {kind}");
    }

    let informational = issues
        .iter()
        .find(|issue| issue.kind == "duplicate_book")
        .unwrap();
    assert!(
        a.service.retry_issue(informational.id).await.is_err(),
        "an informational row has no retry path"
    );
    assert!(!a.service.retry_issue(999_999).await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn retry_reports_rows_it_cannot_repair_and_closes_gone_targets() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;

    // A missing book row means the condition is gone.
    let gone = insert_issue(&a, "identity:999999", "identity_failed").await;
    assert!(a.service.retry_issue(gone).await.unwrap());

    // An existing row whose file is unavailable cannot be repaired now.
    let _book = add_book(&a, "unavailable.epub", b"unavailable retry bytes").await;
    let file_id = file_row_id(&a, "unavailable.epub").await;
    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    let unavailable = insert_issue(&a, &format!("identity:{file_id}"), "identity_failed").await;
    let err = a.service.retry_issue(unavailable).await.unwrap_err();
    assert!(err.to_string().contains("no available file"), "got {err}");

    // A malformed key is reported instead of guessed at.
    let malformed = insert_issue(&a, "project-book:not-a-number", "projection_failed").await;
    let err = a.service.retry_issue(malformed).await.unwrap_err();
    assert!(err.to_string().contains("cannot be retried"), "got {err}");
    let detail = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.id == malformed)
        .expect("the failed row stays open")
        .detail;
    assert!(detail.contains("retry failed"), "{detail}");

    // An orphaned reprojection target is already resolved.
    let orphan_uid = "e".repeat(32);
    let orphan = insert_issue(
        &a,
        &format!("reproject:{orphan_uid}"),
        "reprojection_failed",
    )
    .await;
    assert!(a.service.retry_issue(orphan).await.unwrap());

    // A cover publish failure retries from the local cover cache.
    let name = "abcdef0123456789.png";
    let covers = tuxbooks_lib::covers_dir(&a.db_path);
    std::fs::create_dir_all(&covers).unwrap();
    std::fs::write(covers.join(name), b"cover bytes").unwrap();
    let cover = insert_issue(&a, &format!("cover:{name}"), "cover_blob_failed").await;
    assert!(a.service.retry_issue(cover).await.unwrap());
    assert!(
        sync_dir
            .path()
            .join("TuxBooks/blobs/covers")
            .join(name)
            .exists(),
        "the retry published the cover blob"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_a_projection_reprojects_the_book_and_closes_the_row() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "retry-project.epub", b"retry projection bytes").await;
    let annotation = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let annotation_uid = annotation_sync_uid(&a, annotation).await;

    sqlx::query("DELETE FROM annotations WHERE sync_uid = ?1")
        .bind(&annotation_uid)
        .execute(&a.pool)
        .await
        .unwrap();
    let file_id = file_row_id(&a, "retry-project.epub").await;
    sqlx::query("UPDATE books SET book_uid = NULL WHERE id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    let issue = insert_issue(&a, &format!("project-book:{file_id}"), "projection_failed").await;

    assert!(a.service.retry_issue(issue).await.unwrap());
    assert_eq!(a.service.issues().await.unwrap().len(), 0);
    assert_eq!(
        annotation_count(&a, book).await,
        1,
        "the retry projected the shared annotation"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_identity_hashes_and_binds_the_book() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "retry-identity.epub", b"retry identity bytes").await;
    connect(&a, sync_dir.path()).await;
    let file_id = file_row_id(&a, "retry-identity.epub").await;
    sqlx::query("DELETE FROM sync_book_bindings WHERE book_id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    let issue = insert_issue(&a, &format!("identity:{file_id}"), "identity_failed").await;

    assert!(a.service.retry_issue(issue).await.unwrap());
    let bindings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_id)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(bindings, 1, "the retry rebound the book");
    assert_eq!(book_uid(&a, book).await.len(), 32);
    assert_eq!(a.service.issues().await.unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_a_hash_failure_hashes_the_book_and_closes_the_issue() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "retry-hash.epub", b"retry hash bytes").await;
    connect(&a, sync_dir.path()).await;
    let file_id = file_row_id(&a, "retry-hash.epub").await;
    // Keep the bytes readable so the retry has real work, but park the row in
    // a failure with attempts spent and a retry far in the future.
    sqlx::query(
        "UPDATE books SET hash_state = 'failed', hash_attempts = 2,
         hash_retry_at = '2999-01-01T00:00:00.000Z' WHERE id = ?1",
    )
    .bind(file_id)
    .execute(&a.pool)
    .await
    .unwrap();
    let issue = insert_issue(&a, &format!("hash-failed:{book}"), "hash_failed").await;
    assert_eq!(a.service.status().await.unwrap().issues, 1);

    assert!(a.service.retry_issue(issue).await.unwrap());
    let (state, attempts, retry_at): (String, i64, Option<String>) =
        sqlx::query_as("SELECT hash_state, hash_attempts, hash_retry_at FROM books WHERE id = ?1")
            .bind(file_id)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(state, "hashed");
    assert_eq!(attempts, 0, "a manual retry starts the budget over");
    assert_eq!(retry_at, None);
    assert_eq!(book_uid(&a, book).await.len(), 32);
    assert_eq!(a.service.issues().await.unwrap().len(), 0);
    assert_eq!(
        a.service.status().await.unwrap().issues,
        0,
        "the status count drops with the resolved row"
    );
}
