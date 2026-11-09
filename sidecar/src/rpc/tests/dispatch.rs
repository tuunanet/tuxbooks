//! Method-table tests: each pins a command's wiring through `dispatch`.

use serde_json::json;

use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn ping_answers_pong() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let result = dispatch(&state, &test_events(), "ping", json!({}))
        .await
        .unwrap();
    assert_eq!(result, json!("pong"));
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_methods_are_method_not_found() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let err = dispatch(&state, &test_events(), "nope", json!({}))
        .await
        .unwrap_err();
    assert_eq!(err.code, -32601);
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_progress_emits_library_changed_with_the_updated_book() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let id = seed_book(&state, "Progress Book").await;
    let (events, fired) = capturing_events();

    dispatch(
        &state,
        &events,
        "save_reading_progress",
        json!({"bookId": id, "progress": {"progressPercent": 42.5}}),
    )
    .await
    .unwrap();

    let fired = fired.lock().unwrap();
    assert_eq!(fired.len(), 1, "one event per persisted save");
    let (name, payload) = &fired[0];
    assert_eq!(*name, "library-changed");
    assert_eq!(payload["kind"], "changed");
    assert_eq!(payload["book"]["id"], json!(id));
    assert_eq!(payload["book"]["progressPercent"], json!(42.5));
}

#[tokio::test(flavor = "multi_thread")]
async fn marking_finished_emits_library_changed_with_full_progress() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let id = seed_book(&state, "Finished Book").await;
    let (events, fired) = capturing_events();

    dispatch(&state, &events, "mark_book_finished", json!({"bookId": id}))
        .await
        .unwrap();

    let fired = fired.lock().unwrap();
    assert_eq!(fired.len(), 1);
    let (name, payload) = &fired[0];
    assert_eq!(*name, "library-changed");
    assert_eq!(payload["kind"], "changed");
    assert_eq!(payload["book"]["progressPercent"], json!(100.0));
}

#[tokio::test(flavor = "multi_thread")]
async fn marking_opened_stamps_last_opened_and_emits_library_changed() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let id = seed_book(&state, "Opened Book").await;
    let (events, fired) = capturing_events();
    let book = crate::repository::books::get_book(&state.db, id)
        .await
        .unwrap()
        .unwrap();
    assert!(book.last_opened_at.is_none(), "seed starts unopened");

    dispatch(&state, &events, "mark_book_opened", json!({"bookId": id}))
        .await
        .unwrap();

    let book = crate::repository::books::get_book(&state.db, id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        book.last_opened_at.is_some(),
        "lastOpenedAt must be stamped"
    );
    let fired = fired.lock().unwrap();
    assert_eq!(fired.len(), 1);
    let (name, payload) = &fired[0];
    assert_eq!(*name, "library-changed");
    assert_eq!(payload["kind"], "changed");
    assert_eq!(payload["book"]["id"], json!(id));
    assert!(payload["book"]["lastOpenedAt"].as_str().is_some());
}

/// The reader-session registry arms (ADR 0018 D5): both route on the bookId
/// wire shape, answer null, and persist nothing — the registry is in-memory
/// engine state, unit-tested on `SyncService` itself.
#[tokio::test(flavor = "multi_thread")]
async fn reader_opened_and_closed_answer_null_and_persist_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let id = seed_book(&state, "Deferred Book").await;

    for method in ["reader_opened", "reader_closed"] {
        let result = dispatch(&state, &test_events(), method, json!({"bookId": id}))
            .await
            .unwrap();
        assert_eq!(result, Value::Null, "{method} answers null");
    }
    // Even a stale id routes: the arms are best-effort by contract.
    dispatch(
        &state,
        &test_events(),
        "reader_closed",
        json!({"bookId": 987654}),
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_issues")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(count, 0, "the registry arms record nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn import_paths_streams_batched_progress_events() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Batch Book</dc:title><dc:language>en</dc:language></metadata>
<manifest/><spine/></package>"#;
    for name in ["one.epub", "two.epub"] {
        crate::epub::parser::tests_support::write_zip(
            &lib.join(name),
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", opf.as_bytes()),
            ],
        );
    }
    let state = test_state(tmp.path()).await;
    let (events, fired) = capturing_events();

    let result = dispatch(
        &state,
        &events,
        "import_paths",
        json!({"paths": [lib.to_string_lossy()]}),
    )
    .await
    .unwrap();

    assert_eq!(result["imported"], json!(2));
    let fired = fired.lock().unwrap();
    let progress: Vec<_> = fired
        .iter()
        .filter(|(name, _)| *name == "import-progress")
        .collect();
    assert!(
        !progress.is_empty(),
        "the import streams progress to the UI"
    );
    // How the batches split is timing: the batcher flushes after
    // EVENT_BATCH_WINDOW_MS (250ms) or EVENT_BATCH_BOOKS books, and a
    // first parse that outlasts the window lands the two books in two
    // events. The contract worth pinning is the stream itself: every
    // imported book appears exactly once across the batches, each
    // payload well-formed.
    let mut ids = Vec::new();
    for (name, payload) in &progress {
        assert_eq!(*name, "import-progress");
        let books = payload["books"].as_array().expect("payload.books array");
        for book in books {
            let id = book["id"].as_i64().expect("book id");
            assert!(id > 0, "batched books carry real ids");
            ids.push(id);
        }
    }
    ids.sort_unstable();
    assert_eq!(
        ids.len(),
        2,
        "each imported book lands exactly once across the batches"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn get_storage_stats_reports_in_flight_scan_status() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let busy = tmp.path().join("busy");
    std::fs::create_dir(&busy).unwrap();
    let busy = busy.to_string_lossy().into_owned();
    crate::repository::library_locations::add_location(&state.db, &busy)
        .await
        .unwrap();

    let run = state.importing.start(&busy).unwrap();
    let result = dispatch(&state, &test_events(), "get_storage_stats", json!({}))
        .await
        .unwrap();
    assert_eq!(result["locations"][0]["status"], json!("importing"));

    run.mark_refreshing();
    let result = dispatch(&state, &test_events(), "get_storage_stats", json!({}))
        .await
        .unwrap();
    assert_eq!(result["locations"][0]["status"], json!("refreshing"));

    run.finish();
    state.importing.finish(&busy);
    let result = dispatch(&state, &test_events(), "get_storage_stats", json!({}))
        .await
        .unwrap();
    assert_eq!(result["locations"][0]["status"], json!("idle"));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_storage_stats_reports_the_wire_shape() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let result = dispatch(&state, &test_events(), "get_storage_stats", json!({}))
        .await
        .unwrap();
    assert_eq!(result["locations"], json!([]));
    assert_eq!(result["bookTotalBytes"], json!(0));
    assert_eq!(
        result["catalog"],
        json!({
            "books": 0,
            "authors": 0,
            "collections": 0,
            "annotations": 0,
            "readingProgress": 0,
        })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn get_storage_stats_serves_the_missing_from_disk_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let present = tmp.path().join("present");
    std::fs::create_dir(&present).unwrap();
    let gone = tmp.path().join("gone");
    crate::repository::library_locations::add_location(&state.db, present.to_str().unwrap())
        .await
        .unwrap();
    crate::repository::library_locations::add_location(&state.db, gone.to_str().unwrap())
        .await
        .unwrap();

    let result = dispatch(&state, &test_events(), "get_storage_stats", json!({}))
        .await
        .unwrap();
    let locations = result["locations"].as_array().expect("locations array");
    assert_eq!(locations.len(), 2);
    assert_eq!(locations[0]["path"], json!(present.to_str().unwrap()));
    assert_eq!(locations[0]["missingFromDisk"], json!(false));
    assert_eq!(locations[1]["path"], json!(gone.to_str().unwrap()));
    assert_eq!(locations[1]["missingFromDisk"], json!(true));
}

/// The library payload carries the file-version state (ADR 0018 D3): a copy
/// behind its book's winning pointer reports newerVersionAvailable, and the
/// flag clears once the binding matches the pointer again.
#[tokio::test(flavor = "multi_thread")]
async fn list_books_reports_a_newer_file_version_until_settled() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let file_id = seed_book(&state, "Versioned").await;
    let hash_v1 = "a".repeat(64);
    let hash_v2 = "b".repeat(64);
    crate::sync::identity::bind_hash(&state.db, file_id, &hash_v1, 100, 1)
        .await
        .unwrap()
        .expect("bound");
    let uid: String = sqlx::query_scalar("SELECT book_uid FROM books WHERE id = ?1")
        .bind(file_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sync_state_entities (kind, entity_uid, book_uid) VALUES ('file_version', ?1, ?1)")
        .bind(&uid)
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_state_fields (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES ('file_version', ?1, 'content_hash', ?2, 1, 0, 'remote'),
                ('file_version', ?1, 'size', '2', 1, 0, 'remote')",
    )
    .bind(&uid)
    .bind(format!("\"{hash_v2}\""))
    .execute(&state.db)
    .await
    .unwrap();

    let result = dispatch(&state, &test_events(), "list_books", json!({}))
        .await
        .unwrap();
    assert_eq!(result[0]["newerVersionAvailable"], json!(true));

    // Settled: the pointer names the bytes the binding already proved.
    sqlx::query(
        "UPDATE sync_state_fields SET value_json = ?3
         WHERE kind = 'file_version' AND entity_uid = ?1 AND field = 'content_hash'",
    )
    .bind(&uid)
    .bind(&hash_v1)
    .bind(format!("\"{hash_v1}\""))
    .execute(&state.db)
    .await
    .unwrap();
    let result = dispatch(&state, &test_events(), "list_books", json!({}))
        .await
        .unwrap();
    assert_eq!(result[0]["newerVersionAvailable"], json!(false));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_startup_recovery_is_null_for_a_healthy_database() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let result = dispatch(&state, &test_events(), "get_startup_recovery", json!({}))
        .await
        .unwrap();
    assert_eq!(result, json!(null));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_startup_recovery_reports_the_quarantine_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let mut recovered = (*state).clone();
    recovered.startup_recovery = Some(crate::domain::StartupRecovery {
        from: "/data/tuxbooks.db".into(),
        to: "/data/tuxbooks.db.corrupt-20260922T080000.000Z".into(),
    });
    let recovered = Arc::new(recovered);

    let result = dispatch(
        &recovered,
        &test_events(),
        "get_startup_recovery",
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(result["from"], json!("/data/tuxbooks.db"));
    assert_eq!(
        result["to"],
        json!("/data/tuxbooks.db.corrupt-20260922T080000.000Z")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn embed_book_metadata_accepts_the_form_param() {
    // The bridge sends `{bookId, form}`; a bad shape would fail param
    // parsing (-32602). The seeded row has no file on disk, so the call
    // reaches the service and fails there (-32000) — proving the method
    // and its form argument are wired.
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let id = seed_book(&state, "Embed Book").await;
    let err = dispatch(
        &state,
        &test_events(),
        "embed_book_metadata",
        json!({
            "bookId": id,
            "form": {
                "title": "Embed Book",
                "subtitle": null,
                "publisher": null,
                "language": null,
                "isbn": null,
                "description": null,
                "publicationDate": null,
                "series": null,
                "seriesIndex": null,
                "authors": ["Author"],
                "subjects": []
            }
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, -32000, "reached the service, not param parsing");
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_collection_takes_the_bridge_wire_param() {
    // The bridge has always sent `collectionId` (the Tauri-era camelCase
    // param); the method table must keep accepting exactly that shape —
    // a bare `id` here silently breaks collection deletion client-side.
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let events = test_events();
    let created = dispatch(&state, &events, "create_collection", json!({"name": "Q"}))
        .await
        .unwrap();
    let id = created["id"].as_i64().unwrap();

    let deleted = dispatch(
        &state,
        &events,
        "delete_collection",
        json!({"collectionId": id}),
    )
    .await
    .unwrap();
    assert_eq!(deleted, json!(true));

    let malformed = dispatch(&state, &events, "delete_collection", json!({"id": id}))
        .await
        .unwrap_err();
    assert_eq!(malformed.code, -32602);
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_collection_returns_the_updated_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let events = test_events();
    let created = dispatch(&state, &events, "create_collection", json!({"name": "Q"}))
        .await
        .unwrap();
    let id = created["id"].as_i64().unwrap();
    dispatch(
        &state,
        &events,
        "create_collection",
        json!({"name": "Other"}),
    )
    .await
    .unwrap();

    let renamed = dispatch(
        &state,
        &events,
        "rename_collection",
        json!({"collectionId": id, "name": "  Shelf  "}),
    )
    .await
    .unwrap();
    assert_eq!(renamed["id"], json!(id));
    assert_eq!(renamed["name"], json!("Shelf"));
    assert_eq!(renamed["bookIds"], json!([]));

    // A duplicate name reaches the UNIQUE constraint and comes back as an
    // app error, which the dialog shows inline.
    let duplicate = dispatch(
        &state,
        &events,
        "rename_collection",
        json!({"collectionId": id, "name": "Other"}),
    )
    .await
    .unwrap_err();
    assert_eq!(duplicate.code, -32000);

    let malformed = dispatch(
        &state,
        &events,
        "rename_collection",
        json!({"id": id, "name": "Shelf"}),
    )
    .await
    .unwrap_err();
    assert_eq!(malformed.code, -32602);
}
