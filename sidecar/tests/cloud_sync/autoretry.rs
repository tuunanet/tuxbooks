//! The sync-issue auto-retry sweep (ADR 0017 D4): due rows retry through the
//! same paths as the Retry button, on a bounded backoff, with a kill switch.

use crate::common::*;

/// Any time in the past: a row seeded with this is due for the sweep.
const DUE: &str = "2020-01-01T00:00:00.000Z";

/// Seed one retryable row with a chosen budget state.
async fn insert_retry_row(
    device: &Device,
    key: &str,
    kind: &str,
    detail: &str,
    attempts: i64,
    next: Option<&str>,
) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO sync_issues (issue_key, kind, detail, auto_attempts, next_auto_retry_at)
         VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
    )
    .bind(key)
    .bind(kind)
    .bind(detail)
    .bind(attempts)
    .bind(next)
    .fetch_one(&device.pool)
    .await
    .unwrap()
}

async fn retry_state(device: &Device, id: i64) -> (i64, Option<String>, String) {
    sqlx::query_as(
        "SELECT auto_attempts, next_auto_retry_at, detail FROM sync_issues WHERE id = ?1",
    )
    .bind(id)
    .fetch_one(&device.pool)
    .await
    .unwrap()
}

/// The persisted kill switch, read straight from sync_meta. A missing key
/// means on, mirroring the engine's default.
async fn auto_retry_setting(device: &Device) -> bool {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'auto_retry'")
            .fetch_optional(&device.pool)
            .await
            .unwrap();
    stored.as_deref() != Some("0")
}

async fn row_is_open(device: &Device, id: i64) -> bool {
    let row: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM sync_issues WHERE id = ?1 AND resolved_at IS NULL")
            .bind(id)
            .fetch_optional(&device.pool)
            .await
            .unwrap();
    row.is_some()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sweep_retries_a_due_row_and_closes_it_on_success() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-close.epub", b"sweep close bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;

    // A reprojection row stays open while the book exists, and no pass
    // touches it: only the sweep can close this one.
    let issue = insert_retry_row(
        &a,
        &format!("reproject:{uid}"),
        "reprojection_failed",
        "test detail",
        0,
        None,
    )
    .await;

    // A whole pass runs end-to-end with a due row present. The sweep
    // dispatches through the retry_locked arms while run_pass still holds
    // pass_lock; reaching for retry_issue here would deadlock on that same
    // lock, so this passing at all is the structural no-deadlock proof.
    run(&a).await;

    assert!(!row_is_open(&a, issue).await, "the sweep closed the row");
    assert_eq!(a.service.issues().await.unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_exhausted_row_gives_up_stays_open_and_stops_being_retried() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-cap.epub", b"sweep cap bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;

    // A lifecycle row with nothing in the mirror to replay fails on every
    // attempt. Seed one short of its cap (3) and due, so the sweep spends
    // the last one.
    let issue = insert_retry_row(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
        "test detail",
        2,
        Some(DUE),
    )
    .await;
    run(&a).await;

    let (attempts, next, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 3);
    assert_eq!(next, None, "a given-up row stops scheduling");
    assert!(detail.contains("gave up after 3 auto-retries"), "{detail}");
    assert!(row_is_open(&a, issue).await, "exhaustion stays visible");

    run(&a).await;
    let (attempts, _, _) = retry_state(&a, issue).await;
    assert_eq!(attempts, 3, "the sweep stopped trying");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_attempt_waits_out_the_backoff_before_the_next_try() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    add_book(&a, "sweep-backoff.epub", b"sweep backoff bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    // A missing cover blob fails on every attempt, on the default budget.
    let issue = insert_retry_row(
        &a,
        "cover-missing:deadbeefdeadbeef.png",
        "cover_missing",
        "test detail",
        0,
        None,
    )
    .await;
    let t0 = clock::now_rfc3339();
    run(&a).await;

    let (attempts, next, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 1);
    assert!(detail.contains("auto-retry 1/5"), "{detail}");
    let next = next.expect("the next attempt is scheduled");
    let waited = chrono::DateTime::parse_from_rfc3339(&next).unwrap()
        - chrono::DateTime::parse_from_rfc3339(&t0).unwrap();
    assert!(
        (55..=65).contains(&waited.num_seconds()),
        "the first schedule entry is 60s after the attempt, got {waited}"
    );

    // The row is not due again yet: another pass spends nothing.
    run(&a).await;
    let (attempts, next_after, _) = retry_state(&a, issue).await;
    assert_eq!(attempts, 1, "not due: skipped without spending budget");
    assert_eq!(next_after, Some(next), "the backoff clock did not move");

    // The payload carries the state so the UI can show it without changing
    // attention semantics.
    let listed_id = issue_id(&a, "cover-missing:deadbeefdeadbeef.png").await;
    let dto = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.id == listed_id)
        .expect("the row is listed");
    assert_eq!(dto.auto_attempts, 1);
    assert_eq!(dto.next_auto_retry_at, next_after);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disconnected_engine_skips_folder_dependent_rows_without_spending_budget() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-offline.epub", b"sweep offline bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;
    let issue = insert_retry_row(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
        "test detail",
        0,
        Some(DUE),
    )
    .await;

    a.service.disconnect().await.unwrap();
    run(&a).await;

    let (attempts, next, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 0, "a skip is not an attempt");
    assert_eq!(next.as_deref(), Some(DUE), "the backoff clock did not move");
    assert_eq!(detail, "test detail");

    // The paused row stays in flight: enabled and under the cap, so it
    // waits for the folder without driving attention.
    let status = a.service.status().await.unwrap();
    assert_eq!(status.issues, 0, "a paused row is not attention");
    assert_eq!(
        a.service.issues().await.unwrap().len(),
        1,
        "the list keeps the paused row visible"
    );

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let (attempts, _, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 1, "the budget is back in play when connected");
    assert!(detail.contains("auto-retry 1/3"), "{detail}");
}

#[tokio::test(flavor = "multi_thread")]
async fn hash_failed_rows_are_never_swept() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-hash.epub", b"sweep hash bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    // Park the book in a failed hash with its own retry clock far out, so
    // the open row stays open for the duration: the backfill loop, not the
    // sweep, is the schedule for this kind.
    let file_id = file_row_id(&a, "sweep-hash.epub").await;
    sqlx::query(
        "UPDATE books SET hash_state = 'failed', hash_attempts = 2,
         hash_retry_at = '2999-01-01T00:00:00.000Z' WHERE id = ?1",
    )
    .bind(file_id)
    .execute(&a.pool)
    .await
    .unwrap();
    let issue = insert_retry_row(
        &a,
        &format!("hash-failed:{book}"),
        "hash_failed",
        "test detail",
        0,
        Some(DUE),
    )
    .await;
    run(&a).await;

    let (attempts, next, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 0);
    assert_eq!(next.as_deref(), Some(DUE));
    // The hash sweep rewrites this row's detail, so assert on the sweep's
    // marker instead: the auto-retry sweep never touched the row.
    assert!(!detail.contains("auto-retry"), "{detail}");
    assert!(row_is_open(&a, issue).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manual_retry_grants_a_fresh_budget_and_revives_an_exhausted_row() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-revive.epub", b"sweep revive bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;

    let issue = insert_retry_row(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
        "test detail (gave up after 3 auto-retries)",
        3,
        None,
    )
    .await;

    assert!(
        !a.service.retry_issue(issue).await.unwrap(),
        "nothing in the mirror to replay: the row stays open"
    );
    let (attempts, next, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 0, "the press granted a fresh budget");
    assert_eq!(next, None);
    assert!(!detail.contains("gave up"), "{detail}");
    assert!(
        detail.contains("retry did not clear this condition"),
        "{detail}"
    );

    // Revived: the sweep picks the row up again on its own budget.
    run(&a).await;
    let (attempts, _, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 1, "the exhausted row is back in the schedule");
    assert!(detail.contains("auto-retry 1/3"), "{detail}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_in_flight_row_is_work_in_progress_and_exhaustion_flips_attention() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-attention.epub", b"sweep attention bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;

    // A stuck operation file keeps a human-required row open: the file
    // exists, so no status sweep closes it, and the kind is not sweep-owned.
    let stuck = sync_dir
        .path()
        .join("TuxBooks")
        .join("ops")
        .join("stuck.json");
    std::fs::create_dir_all(stuck.parent().unwrap()).unwrap();
    std::fs::write(&stuck, b"not an operation").unwrap();
    insert_retry_row(
        &a,
        "file:ops/stuck.json",
        "operation_rejected",
        "test detail",
        0,
        None,
    )
    .await;

    // An in-flight row: the sweep owns it and the budget is under the cap.
    // Work in progress is not attention, whatever the timestamp says.
    insert_retry_row(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
        "test detail",
        1,
        Some(DUE),
    )
    .await;

    let status = a.service.status().await.unwrap();
    assert!(status.auto_retry, "the toggle rides the status payload");
    assert_eq!(status.issues, 1, "only the human-required row counts");

    // The kill switch ends the exclusion at once: the machine is off, so
    // even the mid-flight row becomes attention — the rows are the user's
    // job now.
    a.service.set_auto_retry(false).await.unwrap();
    let status = a.service.status().await.unwrap();
    assert!(!status.auto_retry);
    assert_eq!(status.issues, 2, "with the sweep off every open row counts");

    // Back on, the under-budget row returns to the sweep.
    a.service.set_auto_retry(true).await.unwrap();
    let status = a.service.status().await.unwrap();
    assert_eq!(status.issues, 1, "the sweep resumes the in-flight row");

    // Exhaust the sweep-owned row: the budget is spent, the machine gave
    // up, and that is attention again.
    sqlx::query(
        "UPDATE sync_issues SET auto_attempts = 3, next_auto_retry_at = NULL
         WHERE kind = 'book_lifecycle_failed' AND resolved_at IS NULL",
    )
    .execute(&a.pool)
    .await
    .unwrap();
    let status = a.service.status().await.unwrap();
    assert_eq!(status.issues, 2, "exhaustion is attention");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_row_is_in_flight_while_enabled_and_attention_when_disabled() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-fresh.epub", b"sweep fresh bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;

    // Fresh: nothing spent, nothing scheduled. While the sweep owns the
    // kind and the budget is under the cap the row is work in progress,
    // not indefinite attention.
    let issue = insert_retry_row(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
        "test detail",
        0,
        None,
    )
    .await;
    let status = a.service.status().await.unwrap();
    assert_eq!(status.issues, 0, "a fresh owned row is not attention");
    assert_eq!(
        a.service.issues().await.unwrap().len(),
        1,
        "the list keeps the in-flight row visible"
    );

    // Kill switch off: the exclusion ends at once and the row is attention.
    a.service.set_auto_retry(false).await.unwrap();
    let status = a.service.status().await.unwrap();
    assert_eq!(
        status.issues, 1,
        "with the sweep off the row is the user's job"
    );

    // On again: back in flight, and the sweep spends the budget itself.
    a.service.set_auto_retry(true).await.unwrap();
    run(&a).await;
    let (attempts, _, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 1, "the sweep resumed the fresh row");
    assert!(detail.contains("auto-retry 1/3"), "{detail}");
    let status = a.service.status().await.unwrap();
    assert_eq!(status.issues, 0, "still under the cap after the attempt");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_kill_switch_disables_and_reenables_the_sweep() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "sweep-switch.epub", b"sweep switch bytes").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    let uid = book_uid(&a, book).await;
    let issue = insert_retry_row(
        &a,
        &format!("book-lifecycle:{uid}"),
        "book_lifecycle_failed",
        "test detail",
        0,
        Some(DUE),
    )
    .await;

    assert!(auto_retry_setting(&a).await, "auto-retry is default-on");

    a.service.set_auto_retry(false).await.unwrap();
    assert!(!auto_retry_setting(&a).await);
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'auto_retry'")
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(stored.as_deref(), Some("0"), "the setting persists");

    run(&a).await;
    let (attempts, _, _) = retry_state(&a, issue).await;
    assert_eq!(attempts, 0, "the sweep did not run");

    a.service.set_auto_retry(true).await.unwrap();
    run(&a).await;
    let (attempts, _, detail) = retry_state(&a, issue).await;
    assert_eq!(attempts, 1);
    assert!(detail.contains("auto-retry 1/3"), "{detail}");
}

/// A row's `issue_key` is internal, but tests seed rows by key and then read
/// them back by id.
async fn issue_id(device: &Device, key: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM sync_issues WHERE issue_key = ?1 AND resolved_at IS NULL")
        .bind(key)
        .fetch_one(&device.pool)
        .await
        .unwrap()
}
