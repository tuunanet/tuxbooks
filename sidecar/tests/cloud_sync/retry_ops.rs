use crate::common::*;
use crate::support::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_hash_retry_keeps_the_issue_open_and_the_sweep_adds_it() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-hash.epub", b"sweep hash bytes").await;
    connect(&a, sync_dir.path()).await;
    let file_id = file_row_id(&a, "sweep-hash.epub").await;
    // The file disappears while the row still looks available: the retry has
    // nothing to read and must report that instead of closing the row.
    let path = books::get_book(&a.pool, book).await.unwrap().unwrap().path;
    std::fs::remove_file(&path).unwrap();
    // Drop the cached binding too: without it the pass must read the missing
    // file instead of trusting the old snapshot.
    sqlx::query("DELETE FROM sync_book_bindings WHERE book_id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE books SET hash_state = 'failed', hash_attempts = 1,
         hash_retry_at = '2999-01-01T00:00:00.000Z' WHERE id = ?1",
    )
    .bind(file_id)
    .execute(&a.pool)
    .await
    .unwrap();

    // A status refresh gives the already-failed book its row.
    assert_eq!(a.service.status().await.unwrap().issues, 1);
    let issue = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "hash_failed")
        .expect("the failed hash is listed");
    assert_eq!(issue.action, SyncIssueAction::Retry);
    assert_eq!(issue.target, "sweep-hash");
    assert_eq!(
        a.service.issues().await.unwrap().len(),
        1,
        "the sweep does not duplicate the row"
    );

    assert!(
        !a.service.retry_issue(issue.id).await.unwrap(),
        "a retry that still cannot read the file leaves the row open"
    );
    let (state, attempts, _): (String, i64, Option<String>) =
        sqlx::query_as("SELECT hash_state, hash_attempts, hash_retry_at FROM books WHERE id = ?1")
            .bind(file_id)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(state, "failed");
    assert_eq!(
        attempts, 1,
        "the retry reset the budget, then this attempt was counted"
    );
    assert_eq!(a.service.issues().await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pending_hash_keeps_its_issue_open_on_a_status_refresh() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "pending-hash.epub", b"pending hash bytes").await;
    connect(&a, sync_dir.path()).await;
    let file_id = file_row_id(&a, "pending-hash.epub").await;
    sqlx::query("UPDATE books SET hash_state = 'pending' WHERE id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    let issue = insert_issue(&a, &format!("hash-failed:{book}"), "hash_failed").await;

    // `pending` is the claimed state during a long automatic attempt. A status
    // refresh must not close the row just because the hash is in progress.
    assert_eq!(a.service.status().await.unwrap().issues, 1);
    let open = a.service.issues().await.unwrap();
    assert!(
        open.iter()
            .any(|row| row.id == issue && row.kind == "hash_failed"),
        "the pending attempt keeps the same row: {open:?}"
    );

    // A failure keeps it as well.
    sqlx::query("UPDATE books SET hash_state = 'failed' WHERE id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    assert_eq!(a.service.status().await.unwrap().issues, 1);
    assert!(a
        .service
        .issues()
        .await
        .unwrap()
        .iter()
        .any(|row| row.id == issue));

    // Only a fully hashed book clears it.
    sqlx::query("UPDATE books SET hash_state = 'hashed' WHERE id = ?1")
        .bind(file_id)
        .execute(&a.pool)
        .await
        .unwrap();
    assert_eq!(a.service.status().await.unwrap().issues, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_a_reprojection_restores_the_projected_state() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "retry-reproject.epub", b"retry reproject bytes").await;
    let annotation = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;
    let annotation_uid = annotation_sync_uid(&a, annotation).await;
    sqlx::query("DELETE FROM annotations WHERE sync_uid = ?1")
        .bind(&annotation_uid)
        .execute(&a.pool)
        .await
        .unwrap();
    let issue = insert_issue(&a, &format!("reproject:{uid}"), "reprojection_failed").await;

    assert!(a.service.retry_issue(issue).await.unwrap());
    assert_eq!(annotation_count(&a, book).await, 1);
    assert_eq!(a.service.issues().await.unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_a_lifecycle_failure_applies_the_forget() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "retry-lifecycle.epub", b"retry lifecycle bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;

    sqlx::query(
        "INSERT INTO sync_book_trash
             (book_uid, deleted_wall, deleted_count, deleted_dev, deleted_at, expires_at)
         VALUES (?1, 10, 0, ?2, '2026-10-30T00:00:00.000Z', '2026-11-29T00:00:00.000Z')",
    )
    .bind(&uid)
    .bind("f".repeat(32))
    .execute(&a.pool)
    .await
    .unwrap();
    let issue = insert_issue(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
    )
    .await;

    assert!(a.service.retry_issue(issue).await.unwrap());
    let records: Vec<String> = sqlx::query_scalar("SELECT uid FROM book_records")
        .fetch_all(&a.pool)
        .await
        .unwrap();
    assert!(
        !records.contains(&uid),
        "the retry applied the shared Forget and erased the old identity: {records:?}"
    );
    let file_uid: Option<String> = sqlx::query_scalar("SELECT book_uid FROM books WHERE id = ?1")
        .bind(file_row_id(&a, "retry-lifecycle.epub").await)
        .fetch_optional(&a.pool)
        .await
        .unwrap()
        .flatten();
    assert_ne!(
        file_uid.as_deref(),
        Some(uid.as_str()),
        "the file keeps its content under a fresh identity"
    );
    let remaining = open_issue_kinds(&a).await;
    assert!(
        !remaining.iter().any(|kind| kind == "book_lifecycle_failed"),
        "the lifecycle row closes: {remaining:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lifecycle_retry_without_a_mirror_row_keeps_the_issue_open() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "lifecycle-empty.epub", b"empty lifecycle bytes").await;
    let uid = book_uid(&a, book).await;
    connect(&a, sync_dir.path()).await;
    let issue = insert_issue(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
    )
    .await;

    assert!(
        !a.service.retry_issue(issue).await.unwrap(),
        "a replay with nothing to apply is not a repair"
    );
    let kept = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.id == issue)
        .expect("the row stays open");
    assert!(
        kept.detail.contains("retry did not clear"),
        "{}",
        kept.detail
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_a_failed_pass_clears_its_issue() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let library = sync_dir.path().join("TuxBooks/library.json");
    let saved = std::fs::read(&library).unwrap();
    std::fs::remove_file(&library).unwrap();
    assert!(a.service.run_pass().await.is_err());

    let issue = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "sync_failed")
        .expect("the failed pass is an issue");
    std::fs::write(&library, saved).unwrap();

    assert!(a.service.retry_issue(issue.id).await.unwrap());
    assert_eq!(a.service.status().await.unwrap().state, SyncState::Idle);
    assert!(open_issue_kinds(&a).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn retrying_a_missing_cover_reports_until_the_blob_arrives() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "cover-retry.epub", b"cover retry bytes").await;
    let uid = book_uid(&a, book).await;
    connect(&a, sync_dir.path()).await;
    let name = "0123456789abcdef.png";
    let mut op = review_op(
        20,
        EntityKind::Metadata,
        &uid,
        &uid,
        json!({ "title": "Cover retry", "cover_path": name }),
    );
    op.book_uid = Some(uid.clone());
    write_manual_op(sync_dir.path(), &"f".repeat(32), "cover.json", &op);
    run(&a).await;

    let issue = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "cover_missing")
        .expect("the missing cover is listed");
    assert!(
        a.service.retry_issue(issue.id).await.is_err(),
        "nothing to apply while the blob is absent"
    );
    let retried = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.id == issue.id)
        .expect("the row stays open");
    assert!(
        retried.detail.contains("retry failed"),
        "the failure updates the detail: {}",
        retried.detail
    );

    let blob_dir = sync_dir.path().join("TuxBooks/blobs/covers");
    std::fs::create_dir_all(&blob_dir).unwrap();
    std::fs::write(blob_dir.join(name), b"\x89PNG\r\n\x1a\ncover retry bytes").unwrap();
    assert!(a.service.retry_issue(issue.id).await.unwrap());
    assert!(open_issue_kinds(&a).await.is_empty());
    let applied = books::get_book(&a.pool, book_id(&a, "cover-retry.epub").await)
        .await
        .unwrap()
        .unwrap();
    assert!(
        applied.cover_path.is_some(),
        "the retry set the cover on the book"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cover_issue_closes_only_after_the_cover_is_applied() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "cover-apply.epub", b"cover apply bytes").await;
    let uid = book_uid(&a, book).await;
    connect(&a, sync_dir.path()).await;
    let name = "fedcba9876543210.png";
    let mut op = review_op(
        20,
        EntityKind::Metadata,
        &uid,
        &uid,
        json!({ "title": "Cover apply", "cover_path": name }),
    );
    op.book_uid = Some(uid.clone());
    write_manual_op(sync_dir.path(), &"f".repeat(32), "cover.json", &op);
    run(&a).await;

    assert!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .any(|issue| issue.kind == "cover_missing"),
        "the missing cover is listed"
    );
    let blob_dir = sync_dir.path().join("TuxBooks/blobs/covers");
    std::fs::create_dir_all(&blob_dir).unwrap();

    std::fs::write(blob_dir.join(name), b"not an image").unwrap();
    assert!(
        a.service.status().await.unwrap().issues >= 1,
        "corrupt blob cannot clear the row"
    );

    let oversized = std::fs::File::create(blob_dir.join(name)).unwrap();
    oversized.set_len(16 * 1024 * 1024 + 1).unwrap();
    assert!(
        a.service.status().await.unwrap().issues >= 1,
        "an oversized blob cannot clear the row"
    );

    std::fs::write(blob_dir.join(name), b"\x89PNG\r\n\x1a\ncover apply bytes").unwrap();
    assert!(
        a.service.status().await.unwrap().issues >= 1,
        "a blob in the folder is not an applied cover"
    );

    // The normal projection path copies the blob into the cache and points the
    // book at it. Only then does the row close.
    let covers = tuxbooks_lib::covers_dir(&a.db_path);
    std::fs::create_dir_all(&covers).unwrap();
    std::fs::copy(blob_dir.join(name), covers.join(name)).unwrap();
    sqlx::query("UPDATE book_records SET cover_path = ?2 WHERE uid = ?1")
        .bind(&uid)
        .bind(covers.join(name).to_string_lossy().into_owned())
        .execute(&a.pool)
        .await
        .unwrap();
    assert_eq!(a.service.status().await.unwrap().issues, 0);
    assert!(open_issue_kinds(&a).await.is_empty());
}
