use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn connect_disconnect_and_rename_are_visible_in_status() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;

    let initial = a.service.status().await.unwrap();
    assert!(!initial.enabled);
    assert_eq!(initial.state, SyncState::Disabled);
    assert_eq!(initial.folder, None);

    let connected = a
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            Some("Desk".into()),
            None,
            false,
        )
        .await
        .unwrap();
    assert!(connected.mismatch.is_none());
    assert!(connected.status.enabled);
    assert_eq!(connected.status.state, SyncState::Idle);
    assert_eq!(connected.status.device_name.as_deref(), Some("Desk"));
    assert!(connected.status.library_id.is_some());
    let expected_folder = std::fs::canonicalize(sync_dir.path()).unwrap();
    assert_eq!(
        connected.status.folder.as_deref(),
        Some(expected_folder.to_string_lossy().as_ref())
    );

    let renamed = a.service.set_device_name("  Study  ").await.unwrap();
    assert_eq!(renamed.device_name.as_deref(), Some("Study"));
    let device_file = sync_dir
        .path()
        .join("TuxBooks/devices")
        .join(renamed.device_id.as_deref().unwrap())
        .join("device.json");
    let device_json: Value =
        serde_json::from_str(&std::fs::read_to_string(device_file).unwrap()).unwrap();
    assert_eq!(device_json["name"], "Study");

    let blank = a.service.set_device_name("   ").await.unwrap_err();
    assert!(matches!(blank, AppError::InvalidInput(_)), "got {blank:?}");
    let too_long = a
        .service
        .set_device_name(&"x".repeat(81))
        .await
        .unwrap_err();
    assert!(
        matches!(too_long, AppError::InvalidInput(_)),
        "got {too_long:?}"
    );

    let off = a.service.disconnect().await.unwrap();
    assert!(!off.enabled);
    assert_eq!(off.state, SyncState::Disabled);
    let after = a.service.sync_now().await.unwrap();
    assert!(!after.enabled);
    assert_eq!(after.state, SyncState::Disabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_rejects_bad_paths_names_and_read_only_folders() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;

    let relative = a
        .service
        .connect("relative/sync", None, None, false)
        .await
        .unwrap_err();
    assert!(
        matches!(relative, AppError::InvalidInput(_)),
        "got {relative:?}"
    );

    let missing = sync_dir.path().join("does-not-exist");
    let err = a
        .service
        .connect(missing.to_str().unwrap(), None, None, false)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");

    let empty_name = a
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            Some("   ".into()),
            None,
            false,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(empty_name, AppError::InvalidInput(_)),
        "got {empty_name:?}"
    );

    let long_name = a
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            Some("x".repeat(81)),
            None,
            false,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(long_name, AppError::InvalidInput(_)),
        "got {long_name:?}"
    );

    connect(&a, sync_dir.path()).await;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let root = sync_dir.path().join("TuxBooks");
        let original = std::fs::metadata(&root).unwrap().permissions();
        let mut read_only = original.clone();
        read_only.set_mode(0o555);
        std::fs::set_permissions(&root, read_only).unwrap();
        let still_writable = std::fs::write(root.join(".write-check"), b"x").is_ok();
        if still_writable {
            let _ = std::fs::remove_file(root.join(".write-check"));
        }
        let result = a
            .service
            .connect(sync_dir.path().to_str().unwrap(), None, None, false)
            .await;
        if still_writable {
            let connected = result.expect("a folder that is still writable connects");
            assert!(
                connected.status.enabled,
                "the folder was never actually read-only"
            );
        } else {
            let err = result.unwrap_err();
            assert!(err.to_string().contains("not writable"), "got {err}");
        }
        std::fs::set_permissions(&root, original).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_reports_syncing_then_idle_and_refreshes_aggregate_counts() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let book = add_book(&a, "status.epub", b"status book").await;
    let bookmark = add_bookmark(&a, book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "note").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    annotations::delete_annotation(&a.pool, bookmark)
        .await
        .unwrap();
    let op_dir = sync_dir.path().join("TuxBooks/ops").join("f".repeat(32));
    std::fs::create_dir_all(&op_dir).unwrap();
    std::fs::write(op_dir.join("broken.json"), b"{not json").unwrap();
    a.events.lock().unwrap().clear();

    run(&a).await;

    let states = emitted_states(&a);
    assert!(
        states.iter().any(|state| state == "syncing"),
        "the pass announces it is syncing: {states:?}"
    );
    assert_eq!(states.last().map(String::as_str), Some("idle"));

    let status = a.service.status().await.unwrap();
    assert_eq!(status.state, SyncState::Idle);
    assert_eq!(status.pending_local, 0);
    assert!(status.issues >= 1, "the corrupt file is counted");
    assert!(status.trash >= 1, "the deleted bookmark is counted");
    assert_eq!(
        status.issues as usize,
        a.service.issues().await.unwrap().len()
    );
    assert_eq!(
        status.trash as usize,
        a.service.trash().await.unwrap().len()
    );
    assert_eq!(
        status.waiting_books as usize,
        a.service.waiting_books().await.unwrap().len()
    );
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(status.conflicts, conflicts);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_does_nothing_when_disabled_or_the_folder_is_unset() {
    let a = device().await;

    a.service.run_pass().await.unwrap();
    assert_eq!(a.service.status().await.unwrap().state, SyncState::Disabled);

    clock::set_meta(&a.pool, clock::META_ENABLED, "1")
        .await
        .unwrap();
    a.service.run_pass().await.unwrap();
    let status = a.service.status().await.unwrap();
    assert!(status.enabled);
    assert_eq!(status.folder, None);
    assert_eq!(status.state, SyncState::Idle);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_or_corrupt_library_file_fails_the_pass_and_recovers() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let library = sync_dir.path().join("TuxBooks/library.json");
    let saved = std::fs::read(&library).unwrap();

    std::fs::remove_file(&library).unwrap();
    let missing = a.service.run_pass().await.unwrap_err();
    assert!(
        missing.to_string().contains("missing library.json"),
        "got {missing}"
    );
    let failed = a.service.status().await.unwrap();
    assert_eq!(failed.state, SyncState::Error);
    assert!(failed.last_error.is_some());
    assert!(failed.issues >= 1);
    assert!(a
        .service
        .issues()
        .await
        .unwrap()
        .iter()
        .any(|issue| issue.kind == "sync_failed"));

    std::fs::write(&library, b"{not json").unwrap();
    let corrupt = a.service.run_pass().await.unwrap_err();
    assert!(
        matches!(corrupt, AppError::InvalidInput(_)),
        "got {corrupt:?}"
    );

    std::fs::write(&library, saved).unwrap();
    run(&a).await;
    let recovered = a.service.status().await.unwrap();
    assert_eq!(recovered.state, SyncState::Idle);
    assert_eq!(recovered.last_error, None);
    assert!(
        a.service
            .issues()
            .await
            .unwrap()
            .iter()
            .all(|issue| issue.kind != "sync_failed"),
        "the recovered pass resolves its sync issue"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_issues_can_be_dismissed_only_when_they_are_informational() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;

    let op_dir = sync_dir.path().join("TuxBooks/ops").join("f".repeat(32));
    std::fs::create_dir_all(&op_dir).unwrap();
    std::fs::write(op_dir.join("one.json"), b"{not json").unwrap();
    std::fs::write(op_dir.join("two.json"), b"{still not json").unwrap();

    run(&a).await;
    let retryable = a.service.issues().await.unwrap();
    assert_eq!(
        retryable.len(),
        2,
        "one issue per rejected file: {retryable:?}"
    );
    assert!(retryable
        .iter()
        .all(|issue| issue.action == SyncIssueAction::Retry));
    assert!(
        a.service.dismiss_issue(retryable[0].id).await.is_err(),
        "a retryable row cannot be hidden with Dismiss"
    );

    for (key, kind) in [
        ("duplicate-book:abc:1", "duplicate_book"),
        ("dirty-kind:mystery", "invalid_dirty_kind"),
    ] {
        sqlx::query("INSERT INTO sync_issues (issue_key, kind, detail) VALUES (?1, ?2, 'info')")
            .bind(key)
            .bind(kind)
            .execute(&a.pool)
            .await
            .unwrap();
    }
    let informational = a
        .service
        .issues()
        .await
        .unwrap()
        .into_iter()
        .find(|issue| issue.kind == "duplicate_book")
        .expect("the informational row is listed");
    assert_eq!(informational.action, SyncIssueAction::CopyDetails);
    assert!(a.service.dismiss_issue(informational.id).await.unwrap());
    assert!(
        !a.service.dismiss_issue(informational.id).await.unwrap(),
        "an already dismissed issue is not dismissed twice"
    );

    assert_eq!(
        a.service.dismiss_all_issues().await.unwrap(),
        1,
        "only the remaining informational row is dismissed"
    );
    let left = a.service.issues().await.unwrap();
    assert_eq!(left.len(), 2, "the retryable rows stay: {left:?}");
    assert_eq!(a.service.status().await.unwrap().issues, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_rejects_a_folder_that_belongs_to_another_library() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;

    clock::set_meta(
        &a.pool,
        clock::META_LIBRARY_ID,
        "0123456789abcdef0123456789abcdef",
    )
    .await
    .unwrap();

    let err = a.service.run_pass().await.unwrap_err();
    assert!(err.to_string().contains("different library"), "got {err}");
    assert_eq!(a.service.status().await.unwrap().state, SyncState::Error);
}

#[tokio::test(flavor = "multi_thread")]
async fn service_debug_does_not_expose_its_internals() {
    let a = device().await;
    let text = format!("{:?}", a.service);
    assert!(text.starts_with("SyncService"), "got {text}");
    assert!(!text.contains("pool"), "got {text}");
    assert!(!text.contains("events"), "got {text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn service_helpers_work_before_connecting() {
    let a = device().await;
    assert_eq!(a.service.dismiss_all_issues().await.unwrap(), 0);
    let renamed = a.service.set_device_name("  Study  ").await.unwrap();
    assert_eq!(renamed.device_name.as_deref(), Some("Study"));
    assert!(!renamed.enabled);
    a.service.shutdown().await;
    assert!(!a.service.status().await.unwrap().enabled);
}

#[tokio::test(start_paused = true)]
async fn the_background_loop_starts_and_stops() {
    // Setup uses real time: sqlx pool acquisition has its own 30 s timer, and
    // an idle paused runtime would auto-advance straight into it.
    tokio::time::resume();
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("tuxbooks.db");
    let pool = init_pool(&db_path).await.unwrap();
    let events = EventEmitter::new(|_name: &'static str, _payload: Value| {});
    let service = Arc::new(SyncService::new(pool, &db_path, events).await.unwrap());
    let sync_dir = tempfile::tempdir().unwrap();
    service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();

    tokio::time::pause();
    service.start();
    service.wake();
    // Let the task reach its startup sleep, then release it.
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(2)).await;
    // Database work runs in real time; only the loop's timers are paused.
    tokio::time::resume();

    let mut first_sync = None;
    for _ in 0..1000 {
        let status = service.status().await.unwrap();
        if let Some(last_sync) = status.last_sync_at {
            first_sync = Some(last_sync);
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(first_sync.is_some(), "the background loop completed a pass");

    service.shutdown().await;
    let after_shutdown = service.status().await.unwrap().last_sync_at;
    assert!(
        after_shutdown.is_some(),
        "the shutdown flush records a sync time"
    );

    // The loop is gone, so waking it and passing the poll interval is inert.
    tokio::time::pause();
    service.wake();
    tokio::time::advance(Duration::from_secs(10)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    tokio::time::resume();
    let after = service.status().await.unwrap().last_sync_at;
    assert_eq!(
        after, after_shutdown,
        "shutdown stops the background loop from running another pass"
    );
    assert!(service.status().await.unwrap().enabled);
}
