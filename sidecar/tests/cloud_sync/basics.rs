use crate::common::*;
use crate::support::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn annotation_written_on_one_machine_appears_on_the_other() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"the exact same book bytes").await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"the exact same book bytes").await;
    run(&b).await;
    run(&b).await;

    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    let listed = annotations::list_annotations(&b.pool, b_book)
        .await
        .unwrap();
    assert_eq!(
        listed[0].cfi.as_deref(),
        Some("epubcfi(/6/4!/4/2,/1:0,/1:8)")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn two_machines_that_import_the_same_book_before_meeting_converge() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"an independently imported but identical file";
    let a_book = add_book(&a, "same.epub", bytes).await;
    let b_book = add_book(&b, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "a").await;
    add_bookmark(&b, b_book, "epubcfi(/6/4!/4/2,/1:0,/1:9)", "b").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;

    run(&a).await;
    run(&b).await;
    run(&a).await;

    let a_book = book_id(&a, "same.epub").await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(
        annotation_count(&a, a_book).await,
        2,
        "A sees both bookmarks"
    );
    assert_eq!(
        annotation_count(&b, b_book).await,
        2,
        "B sees both bookmarks"
    );
}

/// Joining an existing library re-keys this device's imported book to the
/// shared uuid, which changes its public id. The renderer cannot patch that
/// from a per-book upsert, so the engine must ask it to reload the list.
#[tokio::test(flavor = "multi_thread")]
async fn an_identity_merge_asks_the_renderer_to_reload_the_library() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"a book already imported on both machines";
    let _a_book = add_book(&a, "same.epub", bytes).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    // Publish a canonical uuid smaller than either device's random one, so
    // the merge deterministically replaces B's public id.
    let low_uid = "00000000000000000000000000000001";
    let hash = format!("{:x}", Sha256::digest(bytes));
    write_manual_op(
        sync_dir.path(),
        REVIEW_DEVICE,
        "identity.json",
        &review_op(
            REVIEW_WALL,
            EntityKind::BookIdentity,
            low_uid,
            low_uid,
            json!({ "content_hash": hash }),
        ),
    );

    let _b_book = add_book(&b, "same.epub", bytes).await;
    let before = book_id(&b, "same.epub").await;
    b.events.lock().unwrap().clear();

    connect(&b, sync_dir.path()).await;
    run(&b).await;

    let after = book_id(&b, "same.epub").await;
    assert_ne!(before, after, "the merge must re-key the public book id");
    assert_eq!(
        books::list_books(&b.pool).await.unwrap().len(),
        1,
        "the shared identity collapses to one library entry"
    );
    let reloaded = b.events.lock().unwrap().iter().any(|(name, payload)| {
        *name == "library-changed" && payload["kind"].as_str() == Some("reload")
    });
    assert!(
        reloaded,
        "the renderer must be told to refetch after an identity merge"
    );
    let marker: Option<String> =
        sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'library_reload_pending'")
            .fetch_optional(&b.pool)
            .await
            .unwrap();
    assert_eq!(
        marker.as_deref(),
        Some("0"),
        "the reload marker is cleared after it emits"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_moves_as_one_locator_and_the_later_write_wins() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"progress book").await;

    reading_progress::upsert_progress(
        &a.pool,
        a_book,
        &ProgressUpdate {
            chapter_href: Some("c1.xhtml".into()),
            progress_percent: Some(10.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"progress book").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(progress_percent(&b, b_book).await, Some(10.0));

    reading_progress::upsert_progress(
        &b.pool,
        b_book,
        &ProgressUpdate {
            chapter_href: Some("c2.xhtml".into()),
            progress_percent: Some(55.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    run(&b).await;
    run(&a).await;
    run(&a).await;

    let a_book = book_id(&a, "same.epub").await;
    assert_eq!(progress_percent(&a, a_book).await, Some(55.0));
    let progress = reading_progress::get_progress(&a.pool, a_book)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(progress.chapter_href.as_deref(), Some("c2.xhtml"));
}

/// The ADR 0017 D3 acceptance case: A edits at T1 while offline, B edits at
/// T2 (T1 < T2) while A is still offline, and A only publishes on reconnect.
/// A's op must carry its write-time clock, so B's newer write wins even
/// though A published last.
#[tokio::test(flavor = "multi_thread")]
async fn an_edit_written_offline_loses_to_a_write_that_happened_while_it_was_offline() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"offline clock book").await;

    seed_progress(&a, a_book, 10.0).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"offline clock book").await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(progress_percent(&b, b_book).await, Some(10.0));

    // A goes offline and edits. The dirty row now carries the clock of this
    // write transaction, not the time the capture pass eventually runs.
    reading_progress::upsert_progress(
        &a.pool,
        a_book,
        &ProgressUpdate {
            progress_percent: Some(20.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    let (t1_wall, t1_counter): (i64, i64) =
        sqlx::query_as("SELECT hlc_wall, hlc_counter FROM sync_dirty WHERE kind = 'progress'")
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert!(t1_wall > 0, "the write minted its clock");

    // B writes at T2, strictly after T1: its clock starts a minute past it.
    clock::set_meta(&b.pool, clock::META_HLC, &format!("{}:0", t1_wall + 60_000))
        .await
        .unwrap();
    reading_progress::upsert_progress(
        &b.pool,
        b_book,
        &ProgressUpdate {
            progress_percent: Some(55.0),
            ..ProgressUpdate::default()
        },
    )
    .await
    .unwrap();
    run(&b).await;
    assert_eq!(progress_percent(&b, b_book).await, Some(55.0));

    // A reconnects much later and only now publishes the T1 edit.
    run(&a).await;
    run(&a).await;

    // The op A published is the one its write transaction minted.
    let published: Option<(i64, i64)> = sqlx::query_as(
        "SELECT hlc_wall, hlc_counter FROM sync_ops
         WHERE kind = 'progress' AND hlc_wall = ?1 AND hlc_counter = ?2",
    )
    .bind(t1_wall)
    .bind(t1_counter)
    .fetch_optional(&a.pool)
    .await
    .unwrap();
    assert_eq!(
        published,
        Some((t1_wall, t1_counter)),
        "the op carries the write-time clock despite the late publish"
    );

    // And B wins: its write happened after A's, whatever the publish order.
    let a_book = book_id(&a, "same.epub").await;
    assert_eq!(progress_percent(&a, a_book).await, Some(55.0));
}
