use crate::common::*;

/// A shared Forget replayed onto an already-forgotten durable book rebuilds
/// the local trash snapshot with book_id 0 (the record was absent at apply
/// time). Restoring that snapshot used to bind the 0 and insert rowid 0,
/// which the id policy rejects and which every later sync-replayed restore
/// collides against (tuxbooks-kcm). Restore must allocate a fresh id.
#[tokio::test(flavor = "multi_thread")]
async fn restored_sync_snapshot_allocates_a_fresh_record_id() {
    let env = setup().await;
    env.write_book("minimal.epub", &minimal_epub());
    env.scan().await;
    let book = &env.books().await[0];
    let uid = book
        .book_uid
        .clone()
        .expect("the imported book carries a durable uid");

    // Forget the durable identity: the record goes away (the file stays in
    // the library under a fresh one), a trash row carries the snapshot, and
    // the shared forget op lands in the sync folder.
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let old_record: Option<(i64,)> = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&uid)
        .fetch_optional(&env.pool)
        .await
        .unwrap();
    assert!(old_record.is_none(), "the forget deletes the old record");

    // The other device's forget op replays onto the already-forgotten book:
    // applying it rebuilds the local snapshot with book_id forced to 0.
    let shared_snapshot = json!({
        "book_id": 7,
        "book": {
            "uid": uid,
            "created_at": "2026-11-04T00:00:00.000Z",
            "title": "Sync Restored Zero",
            "subtitle": null,
            "author": "A. Author",
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
    lifecycle::apply_remote_forget(
        &env.pool,
        &uid,
        None,
        Some(shared_snapshot.to_string().as_str()),
    )
    .await
    .unwrap();

    // The rebuilt trash snapshot carries the poisoned book_id 0.
    let trash_json: String = sqlx::query_scalar(
        "SELECT snapshot_json FROM book_trash WHERE book_uid = ?1 AND restored_at IS NULL",
    )
    .bind(&uid)
    .fetch_one(&env.pool)
    .await
    .unwrap();
    assert!(trash_json.contains("\"book_id\":0"));

    let trash = env.rpc("list_book_trash", json!({})).await;
    let trash_id = trash[0]["id"].as_i64().unwrap();
    let outcome = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(outcome["status"], json!("restored"));

    let restored_id = outcome["bookId"]
        .as_i64()
        .expect("restore returns the book id");
    assert!(
        restored_id > 0,
        "the restored record must have a real id, got {restored_id}"
    );
    let row: (i64,) = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&uid)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(row.0, restored_id, "the record carries the allocated id");
}

/// Record ids at or below zero after a lifecycle step, the poisoned shape
/// this whole class of wedge produced (tuxbooks-kcm).
async fn assert_no_nonpositive_ids(env: &Env) {
    let zeros: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE id <= 0")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(zeros, 0, "no record may carry id 0 or less");
}

/// The open local trash row for one uid: (id, snapshot_json).
async fn open_trash_row(env: &Env, uid: &str) -> (i64, String) {
    sqlx::query_as(
        "SELECT id, snapshot_json FROM book_trash WHERE book_uid = ?1 AND restored_at IS NULL",
    )
    .bind(uid)
    .fetch_one(&env.pool)
    .await
    .unwrap()
}

/// Every record for one uid, ordered, so a step can prove the identity is
/// gone, alive once, or replaced under a fresh id.
async fn uid_record_ids(env: &Env, uid: &str) -> Vec<i64> {
    sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1 ORDER BY id")
        .bind(uid)
        .fetch_all(&env.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|(id,)| id)
        .collect()
}

/// The tuxbooks-kcm wedge class, replayed in full: shared lifecycle
/// projections applied onto books whose local state moved on, with the
/// poisoned snapshot shape (book_id 0) that `local_snapshot_json` rebuilds
/// when the record is absent. Forget and restore alternate through both
/// surfaces the app uses, the renderer command and the shared replay
/// (ticket tuxbooks-yf5). After every step every `book_records` id is
/// above zero, no UNIQUE collision fires, and the trash matches the last
/// transition; a poisoned shared mirror row still replays through Retry.
#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_projection_survives_restore_and_forget_churn() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = &env.books().await[0];
    let uid = book
        .book_uid
        .clone()
        .expect("the imported book carries a durable uid");
    let mut cur = book.id;

    let shared = json!({
        "book_id": 0,
        "book": {
            "uid": uid,
            "created_at": "2026-11-04T00:00:00.000Z",
            "title": "Churn Survivor",
            "subtitle": null,
            "author": "A. Author",
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
    })
    .to_string();

    for _round in 0..3 {
        // The local forget: the record leaves and the trash opens.
        env.rpc("forget_book", json!({ "bookId": cur })).await;
        assert!(uid_record_ids(&env, &uid).await.is_empty());
        assert_no_nonpositive_ids(&env).await;

        // The other device's shared forget replays onto the
        // already-forgotten book and rewrites the open trash snapshot with
        // the poisoned book_id 0.
        lifecycle::apply_remote_forget(&env.pool, &uid, None, Some(shared.as_str()))
            .await
            .unwrap();
        let (trash_id, trash_json) = open_trash_row(&env, &uid).await;
        assert!(
            trash_json.contains("\"book_id\":0"),
            "the replay poisons the open snapshot: {trash_json}"
        );
        assert!(uid_record_ids(&env, &uid).await.is_empty());
        assert_no_nonpositive_ids(&env).await;

        // The renderer restores the poisoned entry: the id must be
        // allocated, never bound to the snapshot's 0.
        let restored = env
            .rpc("restore_book", json!({ "trashId": trash_id }))
            .await;
        assert_eq!(restored["status"], json!("restored"));
        cur = restored["bookId"].as_i64().expect("restored book id");
        assert_eq!(uid_record_ids(&env, &uid).await, vec![cur]);
        assert!(cur > 0, "restored under a real id, got {cur}");
        assert_no_nonpositive_ids(&env).await;

        // The shared restore replays onto the book whose local state moved
        // on: the record is replaced under another fresh id and the trash
        // stays closed.
        let replayed = lifecycle::apply_remote_restore(&env.pool, &uid, Some(shared.as_str()))
            .await
            .unwrap()
            .expect("the shared restore recreates the book");
        assert!(
            replayed > 0,
            "replayed restore under a real id, got {replayed}"
        );
        assert_ne!(replayed, cur, "the replay replaces the record");
        cur = replayed;
        assert_eq!(uid_record_ids(&env, &uid).await, vec![cur]);
        let open: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_trash WHERE restored_at IS NULL")
                .fetch_one(&env.pool)
                .await
                .unwrap();
        assert_eq!(open, 0, "the restore closes the trash");
        assert_no_nonpositive_ids(&env).await;

        // Sync is off during the churn, so the capture markers the replays
        // fired would pile up and later replay as stale deletes; with sync
        // on, the engine drains them as they fire. The projection layer is
        // this test's subject, so drop the pile-up here.
        sqlx::query("DELETE FROM sync_dirty")
            .execute(&env.pool)
            .await
            .unwrap();
    }

    assert!(
        env.trash().await.is_empty(),
        "the last transition was a restore"
    );

    // The wedge's recorded issue, and the poisoned shared mirror row a
    // Retry replays: the snapshot carries book_id 0 and the transition says
    // restored. Retry must return true, keep the book under a real id, and
    // resolve the issue row.
    record_issue(
        &env.pool,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
        "could not apply the shared change for forgotten book {uid}",
        None,
    )
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, replacement_book_uid, snapshot_json, deleted_wall, deleted_count,
             deleted_dev, deleted_at, expires_at, restored_at)
         VALUES (?1, NULL, ?2, 1, 0, 'other-device', ?3, ?4, ?3)",
    )
    .bind(&uid)
    .bind(&shared)
    .bind("2026-11-04T00:00:00.000Z")
    // Far-future expiry: the entry must not age out mid-test.
    .bind("2999-01-01T00:00:00.000Z")
    .execute(&env.pool)
    .await
    .unwrap();

    let replayed = retry_book_lifecycle(&env.pool, &uid).await.unwrap();
    assert!(replayed, "the poisoned projection still replays");
    let ids = uid_record_ids(&env, &uid).await;
    assert_eq!(ids.len(), 1);
    // The message stays id-free: a failure message is a log write, and
    // CodeQL flags a uid-derived value reaching one (cleartext-logging).
    assert!(ids[0] > 0, "retry keeps a real id");
    assert_no_nonpositive_ids(&env).await;
    // The replay reads the mirror and applies it; it never rewrites the
    // mirror row, which stays the record of the last transition.
    let mirror: (Option<String>, i64) =
        sqlx::query_as("SELECT restored_at, discarded FROM sync_book_trash WHERE book_uid = ?1")
            .bind(&uid)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(
        mirror,
        (Some("2026-11-04T00:00:00.000Z".into()), 0),
        "the mirror still says restored"
    );

    // The Retry action runs against a connected device, so connect a real
    // service to a real folder: replaying the poisoned projection also runs
    // a pass, exactly as it does in the app.
    let sync_dir = tempfile::tempdir().unwrap();
    let service = SyncService::new(
        env.pool.clone(),
        &env.db_path,
        EventEmitter::new(|_: &'static str, _: Value| {}),
    )
    .await
    .unwrap();
    let connected = service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    assert!(connected.mismatch.is_none());
    let issue_id: i64 = sqlx::query_scalar(
        "SELECT id FROM sync_issues WHERE issue_key = ?1 AND resolved_at IS NULL",
    )
    .bind(format!("book-lifecycle:{uid}"))
    .fetch_one(&env.pool)
    .await
    .unwrap();
    let cleared = service.retry_issue(issue_id).await.unwrap();
    assert!(cleared, "the Retry action repairs the poisoned projection");
    let resolved: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sync_issues WHERE id = ?1 AND resolved_at IS NOT NULL")
            .bind(issue_id)
            .fetch_optional(&env.pool)
            .await
            .unwrap();
    assert!(resolved.is_some(), "the issue row closes");
    let ids = uid_record_ids(&env, &uid).await;
    assert_eq!(ids.len(), 1);
    assert!(ids[0] > 0);
    assert_no_nonpositive_ids(&env).await;
}
