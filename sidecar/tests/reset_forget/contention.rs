use crate::common::*;

/// Bulk Forget rides through a writer that holds the database past the
/// pool's busy timeout: the sync engine's drain behaves exactly like this
/// while a large Reading history is being forgotten (tuxbooks-nj2). One
/// busy error must not abort the run.
#[tokio::test(flavor = "multi_thread")]
async fn bulk_forget_survives_writer_contention() {
    let env = setup().await;
    env.write_book("minimal.epub", &minimal_epub());
    env.write_book("navigation.epub", &navigation_epub());
    env.scan().await;
    let before = env.books().await;
    assert_eq!(before.len(), 2);
    for book in &before {
        env.save_progress(book.id, 40.0).await;
    }

    // Hold the write lock for 6 s: past the pool's 5 s busy timeout, so the
    // first book's forget returns busy and must be retried, then the lock
    // releases while the run continues.
    let db_path = env.db_path.clone();
    let holder = tokio::spawn(async move {
        let mut conn = sqlx::SqliteConnection::connect(&format!("sqlite://{}", db_path.display()))
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut conn)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        sqlx::query("COMMIT").execute(&mut conn).await.unwrap();
        let _ = conn.close().await;
    });

    let started = std::time::Instant::now();
    let result = env
        .rpc(
            "forget_books",
            json!({ "bookIds": before.iter().map(|book| book.id).collect::<Vec<_>>() }),
        )
        .await;
    let elapsed = started.elapsed();

    holder.await.unwrap();
    assert_eq!(
        result["forgotten"].as_i64(),
        Some(2),
        "both books land despite the contended write"
    );
    assert_eq!(result["trashIds"].as_array().unwrap().len(), 2);
    assert!(
        elapsed >= std::time::Duration::from_secs(5),
        "the run must have waited on the contended write: {:?}",
        elapsed
    );
    assert!(env.history().await.is_empty());
    assert_eq!(env.trash().await.len(), 2);
}

/// Entity uids of the book-delete ops in the sync folder: one fsync'd file
/// per forgotten book, written by the engine's capture drain under
/// `ops/{device_id}/`. Counted through the engine's own op rule — `scan_ops`
/// for the flat-read name filter, `read_op` for validation — so the count is
/// what a remote device would pull, never what a raw `read_dir` happens to
/// list (tuxbooks-a3y).
fn book_tombstones(folder: &Path, device_id: &str) -> Vec<String> {
    let prefix = format!("ops/{device_id}/");
    let root = store::resolve_root(folder).expect("sync folder resolves");
    let mut files = store::scan_ops(&root).expect("ops folder scans");
    files.retain(|file| file.relative_path.starts_with(&prefix));
    files
        .into_iter()
        .map(|file| {
            store::read_op(&file.path)
                .unwrap_or_else(|err| panic!("op {} is readable: {err}", file.relative_path))
        })
        .filter_map(|op| (op.kind == EntityKind::Book && op.deleted).then_some(op.entity_uid))
        .collect()
}

/// Bulk Forget rides through the engine draining its real queue mid-run,
/// not a synthetic lock: the pass loop captures the seeded progress backlog
/// plus the forgets' own dirty rows (one transaction per op) while
/// forget_books writes per book, which is the contention shape of the
/// reported install (tuxbooks-nj2, ticket tuxbooks-cd0). This test reaches
/// past the rpc seam for its acceptance facts only: the drained queue and
/// settled state come from the service's own status, the tombstones from
/// the ops folder, the trash from the command the renderer calls.
#[tokio::test(flavor = "multi_thread")]
async fn bulk_forget_survives_a_live_sync_drain() {
    let mut env = setup().await;
    const BOOKS: i64 = 100;
    let mut ids = Vec::new();
    for i in 0..BOOKS {
        let id = env
            .add_durable_book(&format!("book-{i:03}.epub"), &format!("tag-{i:03}"))
            .await;
        env.seed_progress(id, 25.0 + (i % 50) as f64).await;
        ids.push(id);
    }
    assert_eq!(env.durable_count().await, BOOKS);

    // Real sync against a real folder, with the pass loop running in the
    // background: it drains `sync_dirty` while the forget run writes.
    let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let emitter = EventEmitter::new(move |name: &'static str, payload: Value| {
        sink.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((name.to_string(), payload));
    });
    let sync_dir = tempfile::tempdir().unwrap();
    let service = Arc::new(
        SyncService::new(env.pool.clone(), &env.db_path, emitter)
            .await
            .unwrap(),
    );
    env.sync = Some(Arc::clone(&service));
    let connected = service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    assert!(connected.mismatch.is_none());
    service.start();

    // Hold the run until the loop is mid-pass on the seeded backlog, so the
    // forgets below contend with live drains and not just with the poll.
    let waited = Instant::now();
    loop {
        let passing = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|(name, payload)| name == "sync-status" && payload["state"] == json!("syncing"));
        if passing {
            break;
        }
        assert!(
            waited.elapsed() < Duration::from_secs(15),
            "the engine never started a pass"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let result = env.rpc("forget_books", json!({ "bookIds": ids })).await;
    assert_eq!(
        result["forgotten"].as_i64(),
        Some(BOOKS),
        "every book lands despite the engine draining concurrently"
    );
    assert_eq!(
        result["trashIds"].as_array().map(Vec::len),
        Some(BOOKS as usize)
    );

    // The queue must settle with nothing left for the renderer to see.
    // `pending_local` is the engine's own `COUNT(*) FROM sync_dirty`, so
    // this covers the drain the ticket asks for. A pass that loses a write
    // race mid-run records a `sync_failed` issue and an error status by
    // design; the loop's next pass clears both, so only the settled state
    // proves the run ended clean. `Idle` is part of the settle because a
    // pass still in flight reports a clean status while it works. Poll
    // rather than sleep: while dirty rows remain, the loop passes every
    // couple of seconds.
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        let status = service.status().await.unwrap();
        if status.pending_local == 0
            && status.state == SyncState::Idle
            && status.last_error.is_none()
            && status.issues == 0
        {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "sync never settled: state {:?}, pending {}, last_error {:?}, issues {}",
            status.state,
            status.pending_local,
            status.last_error,
            status.issues
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    };

    let device_id = status.device_id.expect("a connected device id");
    let tombstones = book_tombstones(sync_dir.path(), &device_id);
    assert_eq!(
        tombstones.len(),
        BOOKS as usize,
        "one tombstone op per forgotten book in the folder; got {tombstones:?}"
    );
    assert_eq!(
        tombstones.iter().collect::<HashSet<_>>().len(),
        BOOKS as usize,
        "every tombstone names a different book"
    );

    assert_eq!(env.trash().await.len(), BOOKS as usize);
    let after = env.books().await;
    assert_eq!(after.len(), BOOKS as usize, "library entries survive");
    for book in &after {
        assert!(
            !ids.contains(&book.id),
            "every entry carries a fresh identity"
        );
    }
}

/// A capture whose ledger write loses a transient contention race must not
/// leave its op file behind. The folder may only hold ops the ledger owns:
/// an orphan file makes the row's recapture mint a second op file for the
/// same write, which is the flaky 101-vs-100 tombstone count CI saw under
/// load (tuxbooks-a3y). The drain is driven directly because the engine loop
/// can only reach this interleave by racing its own 2 s poll against the
/// lock; here the lock is held before the one dirty row exists.
#[tokio::test(flavor = "multi_thread")]
async fn a_lost_ledger_write_leaves_no_orphan_tombstone() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    // Drop the library entry's file rows so the forget produces no
    // replacement identity: the dirty set is then the tombstone row alone,
    // and the lock lands on its own capture.
    sqlx::query("DELETE FROM books WHERE book_uid = (SELECT uid FROM book_records WHERE id = ?1)")
        .bind(book.id)
        .execute(&env.pool)
        .await
        .unwrap();
    let result = env
        .rpc("forget_books", json!({ "bookIds": [book.id] }))
        .await;
    assert_eq!(result["forgotten"].as_i64(), Some(1));
    let forgotten_uid: String = sqlx::query_scalar("SELECT book_uid FROM book_trash LIMIT 1")
        .fetch_one(&env.pool)
        .await
        .unwrap();

    let sync_dir = tempfile::tempdir().unwrap();
    let sync_root = store::resolve_root(sync_dir.path()).unwrap();
    let covers = tempfile::tempdir().unwrap();

    // Mint the device identity before the lock: the first capture under the
    // lock must fail on its ledger write, not on minting the device id.
    device_id(&env.pool).await.unwrap();

    // Hold the write lock past the pool's 5 s busy timeout, so the drain
    // publishes the op file and then fails on its ledger insert. The
    // readiness gate pins the lock before the drain starts.
    let (lock_ready, lock_held) = tokio::sync::oneshot::channel();
    let holder = tokio::spawn(hold_write_lock(env.db_path.clone(), 6, lock_ready));
    lock_held.await.unwrap();

    let first = capture::drain(&env.pool, &sync_root, covers.path(), 10).await;
    assert!(
        first.is_err(),
        "the locked ledger write must fail the drain"
    );
    holder.await.unwrap();

    // The row survives the failed attempt; the next pass recaptures it and
    // the folder must end with exactly one tombstone, no orphan.
    capture::drain(&env.pool, &sync_root, covers.path(), 10)
        .await
        .unwrap();
    let ops_device_id: String = sqlx::query_scalar("SELECT device_id FROM sync_ops LIMIT 1")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    let tombstones = book_tombstones(sync_dir.path(), &ops_device_id);
    assert_eq!(
        tombstones,
        vec![forgotten_uid],
        "exactly one tombstone per forgotten book, whatever the retries did"
    );

    // And the folder holds no unowned files: every published op is in the
    // ledger, on this device's recapture or not.
    let ledgered: HashSet<String> =
        sqlx::query_as::<_, (String,)>("SELECT file_name FROM sync_ops")
            .fetch_all(&env.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(name,)| name)
            .collect();
    let unowned: Vec<String> = store::scan_ops(&sync_root)
        .unwrap()
        .into_iter()
        .map(|file| file.relative_path)
        .filter(|path| !ledgered.contains(path))
        .collect();
    assert!(
        unowned.is_empty(),
        "every op file is ledgered; unowned: {unowned:?}"
    );
}

/// Hold the library database's write lock for `secs` — past the pool's 5 s
/// busy timeout, so writes issued while it is held fail busy — and report
/// readiness once `BEGIN IMMEDIATE` has landed (tuxbooks-ewu's contention
/// shape).
async fn hold_write_lock(db_path: PathBuf, secs: u64, ready: tokio::sync::oneshot::Sender<()>) {
    let mut conn = sqlx::SqliteConnection::connect(&format!("sqlite://{}", db_path.display()))
        .await
        .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .unwrap();
    let _ = ready.send(());
    tokio::time::sleep(Duration::from_secs(secs)).await;
    sqlx::query("COMMIT").execute(&mut conn).await.unwrap();
    let _ = conn.close().await;
}

/// Single-book Forget keeps its pre-nj2 scope: it aborts on transient
/// contention instead of retrying like the bulk run. Only Reading
/// history's bulk action rides through a busy database; the per-book
/// command surfaces the error to the renderer immediately, and whether to
/// retry is the user's decision. Pinning that so widening the scope later
/// is a deliberate choice (tuxbooks-nj2, ticket tuxbooks-ewu).
#[tokio::test(flavor = "multi_thread")]
async fn single_forget_aborts_on_transient_contention() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 30.0).await;

    // Hold the write lock for 6 s, past the pool's 5 s busy timeout, so
    // the forget's write fails busy.
    let (ready, _) = tokio::sync::oneshot::channel();
    let holder = tokio::spawn(hold_write_lock(env.db_path.clone(), 6, ready));

    let started = std::time::Instant::now();
    let response = env
        .rpc_raw("forget_book", json!({ "bookId": book.id }))
        .await;
    let elapsed = started.elapsed();
    holder.await.unwrap();

    let error = response
        .get("error")
        .unwrap_or_else(|| panic!("the forget must surface the contention: {response}"));
    let message = error["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        message.contains("lock") || message.contains("busy"),
        "the error names the contention: {message}"
    );
    assert!(
        elapsed < Duration::from_secs(20),
        "bounded, not a hang: {elapsed:?}"
    );

    // Nothing moved: the book, its state, and the trash are exactly as the
    // user left them.
    assert_eq!(env.books().await.len(), 1);
    assert_eq!(env.books().await[0].id, book.id);
    assert_eq!(env.progress_percent(book.id).await, Some(30.0));
    assert_eq!(env.trash().await.len(), 0);
    assert_eq!(env.durable_count().await, 1);
}
