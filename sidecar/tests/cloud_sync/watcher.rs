//! ADR 0018 D5: the sync-folder watcher wakes the engine when remote files
//! land, so a remote change is consumed at provider latency plus a quiet
//! period instead of waiting for the 10 s pass interval.

use crate::common::*;
use crate::support::*;
use serde_json::json;
use std::future::Future;
use std::time::{Duration, Instant};

/// Poll until `check` turns true or the bound lapses. Real time: the
/// watcher thread's quiet period is a std thread timer, unaffected by any
/// tokio clock. The 8 s bound keeps comfortable margin over the happy
/// path — the watcher's 2 s quiet period (ADR 0018 D5) plus a pass in the
/// low seconds lands near 5 s — while staying inside the loop's 10 s
/// PASS_INTERVAL, so a broken watcher fails the test instead of being
/// silently rescued by the interval.
async fn wait_for<Fut>(mut check: impl FnMut() -> Fut, limit: Duration, what: &'static str)
where
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + limit;
    while !check().await {
        assert!(Instant::now() < deadline, "timed out waiting: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn syncing_emissions(device: &Device) -> usize {
    emitted_states(device)
        .iter()
        .filter(|state| state.as_str() == "syncing")
        .count()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_remote_op_wakes_the_engine_without_the_pass_interval() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"the exact same book bytes";

    // The third-party device folder exists before B's watch is registered,
    // so the recursive watch covers it from the start and the file event
    // below cannot be lost to a watch registered a moment too late.
    let remote_dir = sync_dir
        .path()
        .join("TuxBooks")
        .join("ops")
        .join(REVIEW_DEVICE);
    std::fs::create_dir_all(&remote_dir).unwrap();

    let _a_book = add_book(&a, "same.epub", bytes).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    run(&a).await;

    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 0);
    let shared_uid = book_uid(&b, b_book).await;

    // Connecting started B's watcher (the sync root became known). Start the
    // loop and wait out its startup sleep plus first pass, so no pass is in
    // flight or imminent when the remote file lands.
    b.service.start();
    let before = syncing_emissions(&b);
    wait_for(
        || async { syncing_emissions(&b) > before },
        Duration::from_secs(5),
        "the loop's first pass",
    )
    .await;

    // Now the folder gains an operation this device has never seen. The
    // loop's schedule is empty: its first pass just reset the 10 s interval,
    // nothing is dirty, so inside the wait bound below only a watcher wake
    // can run the pass that consumes it.
    let entity_uid = "1".repeat(32);
    write_manual_op(
        sync_dir.path(),
        REVIEW_DEVICE,
        "wake.json",
        &review_op(
            REVIEW_WALL,
            EntityKind::Annotation,
            &entity_uid,
            &shared_uid,
            json!({
                "kind": "highlight",
                "cfi": "epubcfi(/6/4!/4/2,/1:0,/1:8)",
                "chapter_href": "chapter1.xhtml",
                "text": "woken",
            }),
        ),
    );

    wait_for(
        || async { annotation_count(&b, b_book).await == 1 },
        Duration::from_secs(8),
        "the watcher to wake the engine",
    )
    .await;

    // Shutdown joins both the loop and the watcher thread; a leaked or
    // wedged watcher would hang here and fail the test.
    b.service.shutdown().await;
}
