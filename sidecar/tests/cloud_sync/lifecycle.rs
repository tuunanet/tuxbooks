use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn restored_bookmark_is_available_for_thirty_days() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let a_book = add_book(&a, "same.epub", b"trash book").await;
    let annotation_id = add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    annotations::delete_annotation(&a.pool, annotation_id)
        .await
        .unwrap();
    run(&a).await;
    let trash = a.service.trash().await.unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].kind, "annotation");

    assert!(a.service.restore(trash[0].id).await.unwrap());
    run(&a).await;
    assert_eq!(annotation_count(&a, a_book).await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn forget_on_one_machine_is_a_shared_delete_and_restores_on_the_other() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"book that will be forgotten";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    reading_progress::upsert_progress(
        &a.pool,
        a_book,
        &ProgressUpdate {
            chapter_href: Some("c1.xhtml".into()),
            progress_percent: Some(44.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    assert_eq!(progress_percent(&b, b_book).await, Some(44.0));
    // The two identities converge during the first trip; Forget acts on the
    // canonical uuid, not the one this device minted before meeting.
    run(&a).await;
    let a_book = book_id(&a, "same.epub").await;
    let old_uid = book_uid(&a, a_book).await;

    let outcome = lifecycle::forget(&a.pool, a_book).await.unwrap();
    let replacement = outcome.replacement_book_id.expect("file stays");
    assert!(!book_uid(&a, replacement).await.is_empty());

    run(&a).await;
    run(&b).await;
    run(&b).await;

    // B's old identity is gone, and the file is a fresh unread book.
    let b_fresh = book_id(&b, "same.epub").await;
    assert_ne!(book_uid(&b, b_fresh).await, old_uid);
    assert_eq!(annotation_count(&b, b_fresh).await, 0);
    assert_eq!(progress_percent(&b, b_fresh).await, None);
    let old_aliases: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(&old_uid)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(old_aliases, 0, "the forgotten identity owns no alias");

    let trash = lifecycle::list_trash(&b.pool).await.unwrap();
    let entry = trash
        .iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("the shared Forget appears in B's Reading history trash");
    let restored = lifecycle::restore(&b.pool, entry.id, None).await.unwrap();
    assert_eq!(restored.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(progress_percent(&b, b_book).await, Some(44.0));
    assert_eq!(annotation_count(&b, b_book).await, 1);

    run(&b).await;
    run(&a).await;
    run(&a).await;

    let a_restored = book_id(&a, "same.epub").await;
    assert_eq!(book_uid(&a, a_restored).await, old_uid);
    assert_eq!(progress_percent(&a, a_restored).await, Some(44.0));
    assert_eq!(annotation_count(&a, a_restored).await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_no_file_forget_still_propagates_and_restores_on_the_machine_with_the_file() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"forgotten from reading history";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    // Let A consume B's identity operation before capturing the canonical ids.
    run(&a).await;
    let a_book = book_id(&a, "same.epub").await;
    let old_uid = book_uid(&a, a_book).await;

    // A drops its membership, then forgets the book from Reading history.
    books::delete_book(&a.pool, a_book).await.unwrap();
    run(&a).await;
    let outcome = lifecycle::forget(&a.pool, a_book).await.unwrap();
    assert!(outcome.replacement_book_id.is_none());

    run(&a).await;
    run(&b).await;
    run(&b).await;

    // B still has the bytes, so it keeps a fresh unread entry and the old
    // identity moves to B's trash.
    let b_fresh = book_id(&b, "same.epub").await;
    assert_ne!(book_uid(&b, b_fresh).await, old_uid);
    assert_eq!(annotation_count(&b, b_fresh).await, 0);
    let trash = lifecycle::list_trash(&b.pool).await.unwrap();
    let entry = trash
        .iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("a remote Forget with no sender file is still restorable");
    let restored = lifecycle::restore(&b.pool, entry.id, None).await.unwrap();
    assert_eq!(restored.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(annotation_count(&b, b_book).await, 1);

    // A has no file, so the restore returns the book to A's Reading history.
    run(&b).await;
    run(&a).await;
    run(&a).await;
    let history = books::list_reading_history(&a.pool, None).await.unwrap();
    let restored_a = history
        .iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("A's reading history has the restored identity");
    assert_eq!(restored_a.annotation_count, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn unreadable_trash_entries_are_skipped_and_restore_refuses_them() {
    let a = device().await;

    assert!(!a.service.restore(999).await.unwrap());
    let unknown = insert_trash(&a, "not-a-kind", &"e".repeat(32), "{}").await;
    assert!(!a.service.restore(unknown).await.unwrap());
    let unreadable = insert_trash(&a, "annotation", &"f".repeat(32), "{not json").await;
    let err = a.service.restore(unreadable).await.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidInput(_)),
        "an unreadable entry is rejected: {err:?}"
    );
    let readable = insert_trash(&a, "annotation", &"a".repeat(32), "{}").await;
    let err = a.service.restore(readable).await.unwrap_err();
    assert!(err.to_string().contains("not connected"), "got {err}");

    let listed = a.service.trash().await.unwrap();
    assert!(listed.iter().any(|entry| entry.id == readable));
    assert!(listed
        .iter()
        .all(|entry| entry.id != unknown && entry.id != unreadable));
}

#[tokio::test(flavor = "multi_thread")]
async fn keep_resolution_closes_the_remote_trash_without_restoring_the_old_identity() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"keep the fresh book";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "old").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    run(&a).await;
    let a_book = book_id(&a, "same.epub").await;
    let old_uid = book_uid(&a, a_book).await;

    lifecycle::forget(&a.pool, a_book).await.unwrap();
    run(&a).await;
    run(&b).await;
    run(&b).await;

    let b_fresh = book_id(&b, "same.epub").await;
    let fresh_uid = book_uid(&b, b_fresh).await;
    reading_progress::upsert_progress(
        &b.pool,
        b_fresh,
        &ProgressUpdate {
            progress_percent: Some(12.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    let entry = lifecycle::list_trash(&b.pool)
        .await
        .unwrap()
        .into_iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("remote trash entry");
    let outcome = lifecycle::restore(&b.pool, entry.id, Some(RestoreMode::Keep))
        .await
        .unwrap();
    assert_eq!(outcome.status, RestoreStatus::Kept);

    run(&b).await;
    run(&a).await;
    run(&a).await;
    assert!(
        lifecycle::list_trash(&b.pool).await.unwrap().is_empty(),
        "Keep closes B's trash entry"
    );
    assert!(
        lifecycle::list_trash(&a.pool).await.unwrap().is_empty(),
        "Keep propagates and closes A's copy too"
    );
    assert_eq!(book_uid(&b, b_fresh).await, fresh_uid);
    assert_eq!(progress_percent(&b, b_fresh).await, Some(12.0));
    let old_records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(old_records, 0, "Keep never recreates the old identity");
}
