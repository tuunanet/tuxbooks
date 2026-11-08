//! Silent race resolution (ADR 0017 D1): every race has a pre-decided winner,
//! the loser becomes a diagnostic row, and no review issue opens. Legacy rows
//! and their paired issues are retired by the lazy reconcile/expire sweep.

use crate::common::*;
use crate::support::*;
use serde_json::json;

async fn open_conflict_issues(device: &Device) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues WHERE kind = 'conflict' AND resolved_at IS NULL",
    )
    .fetch_one(&device.pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_edit_arriving_after_a_delete_is_discarded_with_one_diagnostic_and_no_issue() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "races.epub", b"edit vs delete bytes").await;
    let annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "races.epub", b"edit vs delete bytes").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "races.epub").await;
    let b_annotation = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap()[0]
        .id;

    // A deletes; B edits the still-live annotation before seeing the
    // tombstone.
    annotations::delete_annotation(&a.pool, annotation)
        .await
        .unwrap();
    run(&a).await;
    annotations::update_annotation(
        &b.pool,
        b_annotation,
        &AnnotationPatch {
            color: None,
            label: None,
            note: Some("edited elsewhere".into()),
        },
    )
    .await
    .unwrap();
    // B's pass publishes the edit first, then applies the delete; the
    // tombstone wins without a row. A's pass diverts the arriving edit.
    // Two devices: exactly one row, recorded by the one device that applies
    // the edit against the tombstone. At N devices the same race leaves N-1
    // rows, one per device that applies delete-then-edit; only the editing
    // device stays quiet.
    run(&b).await;
    run(&a).await;

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
        "two devices, one row: only A applies the edit against the tombstone"
    );
    let (a_issues, b_issues) = (
        open_conflict_issues(&a).await,
        open_conflict_issues(&b).await,
    );
    assert_eq!(a_issues + b_issues, 0, "no review row opens for the race");
    let loser: Option<String> = sqlx::query_scalar(
        "SELECT loser_json FROM sync_conflicts WHERE field = '__deleted__' LIMIT 1",
    )
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&loser.unwrap()).unwrap()["note"],
        json!("edited elsewhere"),
        "the discarded text is kept as diagnostics"
    );

    for device in [&a, &b] {
        run(device).await;
        let book = book_id(device, "races.epub").await;
        assert_eq!(
            annotation_count(device, book).await,
            0,
            "remove-wins: the tombstone stands on every device"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restore_with_a_newer_clock_than_the_delete_wins_silently() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "races.epub", b"restore vs delete bytes").await;
    let annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "races.epub", b"restore vs delete bytes").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "races.epub").await;
    let b_annotation = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap()[0]
        .id;
    let annotation_uid = annotation_sync_uid(&b, b_annotation).await;

    annotations::delete_annotation(&a.pool, annotation)
        .await
        .unwrap();
    run(&a).await;
    run(&b).await;

    // B restores from Recently deleted. Its clock minted after it observed
    // the delete, so the restore is the pre-decided winner.
    let trash_id: i64 = sqlx::query_scalar(
        "SELECT id FROM sync_trash WHERE entity_uid = ?1 AND restored_at IS NULL",
    )
    .bind(&annotation_uid)
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert!(b.service.restore(trash_id).await.unwrap());
    run(&b).await;
    run(&a).await;

    for device in [&a, &b] {
        let book = book_id(device, "races.epub").await;
        assert_eq!(
            annotation_count(device, book).await,
            1,
            "the newer restore wins everywhere"
        );
        assert_eq!(open_trash(device).await, 0, "the restore closes the trash");
    }
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
        0,
        "restore versus delete never records a diagnostic when the clock decides"
    );
    let issues = open_conflict_issues(&a).await + open_conflict_issues(&b).await;
    assert_eq!(issues, 0, "and it never opens review");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_edit_of_a_tombstoned_annotation_is_dropped_silently() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "races.epub", b"local edit bytes").await;
    let annotation = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "races.epub", b"local edit bytes").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "races.epub").await;
    let b_annotation = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap()[0]
        .id;
    let annotation_uid = annotation_sync_uid(&b, b_annotation).await;

    // B receives the tombstone, then a stale local write (a UI holding the
    // old row) touches the deleted entity.
    annotations::delete_annotation(&a.pool, annotation)
        .await
        .unwrap();
    run(&a).await;
    run(&b).await;
    let book_uid = book_uid(&b, b_book).await;
    sqlx::query(
        "INSERT INTO annotations (book_uid, sync_uid, kind, cfi, note)
         VALUES (?1, ?2, 'highlight', 'epubcfi(/6/4)', 'late edit')",
    )
    .bind(&book_uid)
    .bind(&annotation_uid)
    .execute(&b.pool)
    .await
    .unwrap();
    let stale = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.note.as_deref() == Some("late edit"))
        .unwrap()
        .id;
    annotations::update_annotation(
        &b.pool,
        stale,
        &AnnotationPatch {
            color: None,
            label: None,
            note: Some("later edit".into()),
        },
    )
    .await
    .unwrap();
    run(&b).await;
    run(&a).await;

    let row: (String, String) =
        sqlx::query_as("SELECT field, loser_json FROM sync_conflicts WHERE entity_uid = ?1")
            .bind(&annotation_uid)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(row.0, "__deleted__");
    assert_eq!(
        serde_json::from_str::<Value>(&row.1).unwrap()["note"],
        json!("later edit"),
        "the losing text is kept as diagnostics"
    );
    let b_conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    let a_conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(b_conflicts, 1);
    assert_eq!(a_conflicts, 0, "the dropped edit never travels");
    assert_eq!(open_conflict_issues(&b).await, 0, "no review row opens");
    let book = book_id(&a, "races.epub").await;
    assert_eq!(
        annotation_count(&a, book).await,
        0,
        "the tombstone still wins on the deleting device"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_legacy_conflict_row_and_its_issue_expire_together() {
    let a = device().await;
    let uid = "d".repeat(32);
    let id = insert_review_conflict(&a, "annotation", &uid, "note", &clock::now_rfc3339()).await;
    insert_review_state(&a, &uid).await;
    insert_issue(&a, &format!("conflict:annotation:{uid}:note"), "conflict").await;
    assert_eq!(
        open_conflict_issues(&a).await,
        1,
        "the legacy issue is open"
    );
    let stale = insert_review_conflict(
        &a,
        "annotation",
        &"e".repeat(32),
        "note",
        "2000-01-01T00:00:00.000Z",
    )
    .await;
    insert_review_state(&a, &"e".repeat(32)).await;
    insert_issue(
        &a,
        &format!("conflict:annotation:{}:note", "e".repeat(32)),
        "conflict",
    )
    .await;

    // No settle path exists anymore: the sweep is the only retirement, and a
    // status refresh runs it. The fresh row and its issue stay; the stale pair
    // is gone.
    a.service.status().await.unwrap();
    let fresh_open: Option<i64> = sqlx::query_scalar("SELECT id FROM sync_conflicts WHERE id = ?1")
        .bind(id)
        .fetch_optional(&a.pool)
        .await
        .unwrap();
    assert!(fresh_open.is_some(), "the fresh diagnostic row survives");
    let stale_open: Option<i64> = sqlx::query_scalar("SELECT id FROM sync_conflicts WHERE id = ?1")
        .bind(stale)
        .fetch_optional(&a.pool)
        .await
        .unwrap();
    assert!(stale_open.is_none(), "the stale row expired");
    let stale_issue: Option<String> = sqlx::query_scalar(
        "SELECT resolved_at FROM sync_issues
         WHERE issue_key = ?1",
    )
    .bind(format!("conflict:annotation:{}:note", "e".repeat(32)))
    .fetch_optional(&a.pool)
    .await
    .unwrap();
    assert!(stale_issue.is_some(), "the stale paired issue closed");
    assert_eq!(
        open_conflict_issues(&a).await,
        1,
        "only the fresh row's issue remains"
    );
}
