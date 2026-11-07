use crate::common::*;

/// The incident trigger (tuxbooks-z67): the folder held operations from an
/// older device identity, and a reconnect replayed them as remote changes
/// onto books whose local state had moved on. Stale identities are expected
/// to keep accumulating in the folder (no pruning exists today), so the
/// replay has to stay harmless: the stale forget and restore land with real
/// ids, a stale restore whose snapshot cannot be read surfaces as a
/// book_lifecycle_failed issue that leaves the book untouched and whose
/// Retry resolves once the data reads, and B's own captured operations
/// never re-apply to itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_stale_identity_replay_after_reconnect_stays_harmless() {
    let sync_dir = tempfile::tempdir().unwrap();
    let stale = device().await;
    let b = device().await;
    let bytes = b"stale identity replay book";
    let other_bytes = b"stale identity second book";
    let stale_book = add_book(&stale, "shared.epub", bytes).await;
    add_bookmark(&stale, stale_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    let stale_other = add_book(&stale, "other.epub", other_bytes).await;
    add_bookmark(&stale, stale_other, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;

    // Both machines meet while both are live: the identities converge on
    // one canonical uid per book.
    connect(&stale, sync_dir.path()).await;
    run(&stale).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "shared.epub", bytes).await;
    let _b_other = add_book(&b, "other.epub", other_bytes).await;
    run(&b).await;
    run(&b).await;
    run(&stale).await;
    run(&b).await;
    let stale_book = book_id(&stale, "shared.epub").await;
    let stale_other = book_id(&stale, "other.epub").await;
    let old_uid = book_uid(&stale, stale_book).await;
    let other_uid = book_uid(&stale, stale_other).await;
    let b_book = book_id(&b, "shared.epub").await;
    let b_other = book_id(&b, "other.epub").await;
    assert_eq!(
        book_uid(&b, b_book).await,
        old_uid,
        "one canonical identity"
    );
    assert_eq!(book_uid(&b, b_other).await, other_uid);

    // B's second book moves on locally; the stale replay below must leave
    // it alone.
    seed_progress(&b, b_other, 55.0).await;

    // The stale identity forgets its book; the tombstone lands in the
    // folder under the stale device directory.
    let outcome = lifecycle::forget(&stale.pool, stale_book).await.unwrap();
    outcome
        .replacement_book_id
        .expect("the file stays on the stale machine");
    run(&stale).await;

    // B applies the stale forget: the old identity leaves B's library and
    // its state stays restorable from B's local trash.
    run(&b).await;
    run(&b).await;
    let b_fresh = book_id(&b, "shared.epub").await;
    assert_ne!(
        book_uid(&b, b_fresh).await,
        old_uid,
        "the old identity is gone"
    );
    assert_eq!(
        annotation_count(&b, b_fresh).await,
        0,
        "the fresh identity starts unread"
    );
    let old_record: Option<(i64,)> = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_optional(&b.pool)
        .await
        .unwrap();
    assert!(
        old_record.is_none(),
        "the forgotten identity leaves B's library"
    );
    let trash = lifecycle::list_trash(&b.pool).await.unwrap();
    assert!(
        trash.iter().any(|entry| entry.book_uid == old_uid),
        "B can still restore the stale forget"
    );
    seed_progress(&b, b_fresh, 71.0).await;

    // The stale identity restores the book. Replaying that restore onto the
    // moved-on library must recreate the record under a real id.
    let stale_trash = lifecycle::list_trash(&stale.pool).await.unwrap();
    let stale_entry = stale_trash
        .iter()
        .find(|entry| entry.book_uid == old_uid)
        .expect("the stale machine still holds its own trash");
    let restored = lifecycle::restore(&stale.pool, stale_entry.id, None)
        .await
        .unwrap();
    assert_eq!(restored.book_uid.as_deref(), Some(old_uid.as_str()));
    run(&stale).await;
    run(&b).await;
    run(&b).await;

    let restored_record: (i64,) = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert!(
        restored_record.0 > 0,
        "the replayed restore allocates a real id"
    );
    // The restore wins over the moved-on local state: the library entry
    // joins the restored identity again, the snapshot's bookmark returns,
    // and the local progress that lost shows up as a review conflict
    // instead of vanishing silently.
    let restored_entry = book_id(&b, "shared.epub").await;
    assert_eq!(
        book_uid(&b, restored_entry).await,
        old_uid,
        "the restored identity owns the entry again"
    );
    assert_eq!(restored_entry, restored_record.0);
    assert_eq!(
        annotation_count(&b, restored_entry).await,
        1,
        "the snapshot's bookmark returns"
    );
    let conflict_kinds: Vec<String> = b
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.kind)
        .collect();
    assert!(
        conflict_kinds.contains(&"restore_conflict".to_string()),
        "the lost local progress is visible as a conflict: {conflict_kinds:?}"
    );
    assert_eq!(
        progress_percent(&b, book_id(&b, "other.epub").await).await,
        Some(55.0),
        "the untouched book keeps its state"
    );
    let zeros: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE id <= 0")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(zeros, 0, "no id-0 row from the stale replay");

    // A stale restore op for the second book, carrying a snapshot nothing
    // can read: a genuine projection conflict. The replay must fail
    // visibly and leave the book exactly where it was. The clock beats
    // every real op written earlier.
    const STALE_WALL: i64 = 3_000_000_000_000;
    let stale_device = stale
        .service
        .status()
        .await
        .unwrap()
        .device_id
        .expect("the stale device has an identity");
    let conflict_op = Op {
        schema: OP_SCHEMA,
        op_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
        device_id: stale_device.clone(),
        hlc: Hlc {
            wall: STALE_WALL,
            counter: 0,
            device: stale_device.clone(),
        },
        kind: EntityKind::Book,
        entity_uid: other_uid.clone(),
        book_uid: Some(other_uid.clone()),
        deleted: false,
        restore: true,
        fields: serde_json::json!({ "snapshot": "not a readable snapshot" })
            .as_object()
            .cloned()
            .unwrap(),
        prior: None,
        created_at: "2026-11-04T00:00:00.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &stale_device,
        "stale-restore.json",
        &conflict_op,
    );
    run(&b).await;

    let issues = b.service.issues().await.unwrap();
    let issue = issues
        .iter()
        .find(|row| row.kind == "book_lifecycle_failed")
        .expect("the unreadable replay surfaces as a lifecycle issue");
    assert_eq!(
        b_other,
        book_id(&b, "other.epub").await,
        "the failed replay changes no ids"
    );
    assert_eq!(
        progress_percent(&b, b_other).await,
        Some(55.0),
        "the failed replay moves no state"
    );

    // Retry with the snapshot still unreadable fails honestly and keeps
    // the row open.
    assert!(
        b.service.retry_issue(issue.id).await.is_err(),
        "Retry cannot repair unreadable data"
    );
    let still_open = b.service.issues().await.unwrap();
    assert!(
        still_open.iter().any(|row| row.id == issue.id),
        "the row stays open while the data is broken"
    );

    // Once the snapshot reads, Retry replays the restore and closes the
    // row; the recreated book carries a real id.
    let readable = serde_json::json!({
        "book_id": 0,
        "book": {
            "uid": other_uid,
            "created_at": "2026-11-04T00:00:00.000Z",
            "title": "Recovered Stale Book",
            "subtitle": null,
            "author": null,
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
    });
    sqlx::query("UPDATE sync_book_trash SET snapshot_json = ?2 WHERE book_uid = ?1")
        .bind(&other_uid)
        .bind(readable.to_string())
        .execute(&b.pool)
        .await
        .unwrap();
    assert!(
        b.service.retry_issue(issue.id).await.unwrap(),
        "Retry resolves once the snapshot reads"
    );
    let closed: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sync_issues WHERE id = ?1 AND resolved_at IS NOT NULL")
            .bind(issue.id)
            .fetch_optional(&b.pool)
            .await
            .unwrap();
    assert!(closed.is_some(), "the lifecycle issue closes");
    let recovered: (i64,) = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&other_uid)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert!(recovered.0 > 0, "the recovered identity gets a real id");

    // B's own captured operations must not re-apply to B: the applied-ops
    // ledger holds them off, so further passes leave the library alone.
    let ledgered: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_applied_ops")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert!(ledgered > 0, "B ledgered its own operations");
    let before: (Vec<(i64, String)>, usize) = (
        sqlx::query_as("SELECT id, uid FROM book_records ORDER BY id")
            .fetch_all(&b.pool)
            .await
            .unwrap(),
        lifecycle::list_trash(&b.pool).await.unwrap().len(),
    );
    run(&b).await;
    run(&b).await;
    let after: (Vec<(i64, String)>, usize) = (
        sqlx::query_as("SELECT id, uid FROM book_records ORDER BY id")
            .fetch_all(&b.pool)
            .await
            .unwrap(),
        lifecycle::list_trash(&b.pool).await.unwrap().len(),
    );
    assert_eq!(after, before, "B's own ops do not replay onto B");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stale_alias_or_edit_cannot_resurrect_a_forgotten_identity() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"forget then replay stale ops";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
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
    let fresh_uid = book_uid(&b, book_id(&b, "same.epub").await).await;
    assert_ne!(fresh_uid, old_uid);

    // A device that had not seen the Forget yet replays an old identity alias
    // and a stale progress edit with a newer clock.
    let manual_device = "e".repeat(32);
    let stale_hash = "f".repeat(64);
    let identity = Op {
        schema: OP_SCHEMA,
        op_id: "1".repeat(32),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall: 9_000_000_000_000,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::BookIdentity,
        entity_uid: old_uid.clone(),
        book_uid: Some(old_uid.clone()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({ "content_hash": stale_hash })
            .as_object()
            .cloned()
            .unwrap(),
        prior: None,
        created_at: "2026-10-01T00:00:00.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &manual_device,
        "00000000000000000001.json",
        &identity,
    );
    let edit = Op {
        schema: OP_SCHEMA,
        op_id: "2".repeat(32),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall: 9_000_000_000_001,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::Progress,
        entity_uid: old_uid.clone(),
        book_uid: Some(old_uid.clone()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({ "progress_percent": 99.0 })
            .as_object()
            .cloned()
            .unwrap(),
        prior: None,
        created_at: "2026-10-01T00:00:01.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &manual_device,
        "00000000000000000002.json",
        &edit,
    );
    run(&b).await;
    run(&b).await;

    let old_records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(old_records, 0, "the forgotten identity stays deleted");
    let alias_owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&stale_hash)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(
        alias_owner, fresh_uid,
        "a stale alias resolves to the fresh identity, never the old one"
    );
    let fresh = book_id(&b, "same.epub").await;
    assert_eq!(progress_percent(&b, fresh).await, None);
    assert_eq!(annotation_count(&b, fresh).await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_identity_sweep_binds_new_books_and_skips_unreadable_ones() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    add_book(&a, "sweep.epub", b"sweep me").await;
    add_book(&a, "gone.epub", b"gone bytes").await;
    for name in ["sweep.epub", "gone.epub"] {
        let file = file_row_id(&a, name).await;
        sqlx::query("DELETE FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file)
            .execute(&a.pool)
            .await
            .unwrap();
    }
    let gone = a.db_path.parent().unwrap().join("library/gone.epub");
    std::fs::remove_file(gone).unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let bindings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_row_id(&a, "sweep.epub").await)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(bindings, 1, "the readable book gets its identity back");
    let gone_bindings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_row_id(&a, "gone.epub").await)
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(
        gone_bindings, 0,
        "a vanished file is skipped instead of aborting the pass"
    );
}
