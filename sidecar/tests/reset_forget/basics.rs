use crate::common::*;

/// Reset keeps the identity and file, and clears every user-owned surface.
#[tokio::test(flavor = "multi_thread")]
async fn reset_clears_state_and_keeps_the_book_and_file() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let source_title = book.title.clone();
    let uid = book.book_uid.clone().unwrap();
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(book.id, shelf).await;
    env.save_progress(book.id, 42.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.set_title_override(book.id, "Curated Reset Title").await;
    env.link_provider(&uid, "hardcover", "hc-reset").await;
    assert_eq!(env.effective_title(book.id).await, "Curated Reset Title");

    assert_eq!(
        env.rpc("reset_book_reading_data", json!({ "bookId": book.id }))
            .await,
        json!(true)
    );

    let library = env.books().await;
    assert_eq!(library.len(), 1, "the book stays in the library");
    assert_eq!(library[0].id, book.id, "Reset keeps the durable identity");
    assert_eq!(library[0].book_uid.as_deref(), Some(uid.as_str()));
    assert_eq!(library[0].path, path.to_string_lossy());
    assert_eq!(library[0].progress_percent, None);
    assert!(env.provider_links(&uid).await.is_empty());
    assert_eq!(env.annotation_count(book.id).await, 0);
    assert!(env.collection_book_ids(shelf).await.is_empty());
    assert_eq!(
        env.effective_title(book.id).await,
        source_title,
        "metadata falls back to the source file"
    );
    assert!(env.history().await.is_empty());
}

/// Forget with no file deletes the durable record and its hash aliases, so a
/// later import of the same bytes is a genuinely new book.
#[tokio::test(flavor = "multi_thread")]
async fn forget_without_a_file_deletes_the_record_and_its_aliases() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    let hash = env.content_hash(&old_uid).await;
    env.save_progress(book.id, 12.0).await;

    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    assert_eq!(env.history().await.len(), 1);

    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    assert!(outcome["replacementBookId"].is_null());
    assert_eq!(env.history().await.len(), 0);
    assert_eq!(env.durable_count().await, 0);
    assert_eq!(env.alias_count(&old_uid).await, 0);
    assert_eq!(env.trash().await.len(), 1);

    // Same bytes returning must not resurrect the forgotten identity.
    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let reimported = imported_book(&env).await;
    assert_ne!(reimported.id, book.id);
    assert_ne!(reimported.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(env.progress_percent(reimported.id).await, None);
    assert_ne!(
        env.alias_owner(&hash).await.as_deref(),
        Some(old_uid.as_str())
    );
}

/// A forgotten book with no file restores into Reading history with its
/// state intact, even when no fresh identity exists.
#[tokio::test(flavor = "multi_thread")]
async fn restore_without_a_file_returns_to_reading_history() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let uid = book.book_uid.clone().unwrap();
    env.save_progress(book.id, 31.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();

    let result = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(result["status"], json!("restored"));
    assert_eq!(result["bookId"].as_i64(), Some(book.id));
    assert_eq!(result["bookUid"].as_str(), Some(uid.as_str()));
    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["progressPercent"].as_f64(), Some(31.0));
    assert_eq!(history[0]["annotationCount"].as_i64(), Some(1));
}

/// Forget with a file keeps the library entry, rebinds it to a fresh identity,
/// moves the old state to the trash, re-points the hash alias, and unlinks
/// providers without touching remote history.
#[tokio::test(flavor = "multi_thread")]
async fn forget_with_a_file_rebinds_the_entry_and_moves_state_to_trash() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    let source_title = book.title.clone();
    let hash = env.content_hash(&old_uid).await;
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(book.id, shelf).await;
    env.save_progress(book.id, 44.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.set_title_override(book.id, "Curated Old Title").await;
    env.link_provider(&old_uid, "hardcover", "hc-forget").await;

    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let replacement_id = outcome["replacementBookId"]
        .as_i64()
        .expect("the file stays in the library");

    let library = env.books().await;
    assert_eq!(library.len(), 1, "the library entry never disappears");
    let fresh = &library[0];
    assert_eq!(fresh.id, replacement_id);
    assert_eq!(fresh.path, path.to_string_lossy());
    assert_ne!(fresh.id, book.id);
    assert_ne!(fresh.book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(fresh.progress_percent, None);
    assert_eq!(fresh.title, source_title, "the fresh identity starts fresh");
    assert!(fresh.provider_links.is_empty());

    assert_eq!(env.progress_percent(fresh.id).await, None);
    assert_eq!(env.annotation_count(fresh.id).await, 0);
    assert!(env.collection_book_ids(shelf).await.is_empty());
    assert!(env.provider_links(old_uid.as_str()).await.is_empty());
    assert_eq!(env.alias_count(&old_uid).await, 0);
    let fresh_uid = fresh.book_uid.clone().unwrap();
    assert_eq!(
        env.alias_owner(&hash).await.as_deref(),
        Some(fresh_uid.as_str()),
        "the current bytes point at the fresh identity"
    );

    let trash = env.trash().await;
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0]["bookUid"].as_str(), Some(old_uid.as_str()));
    assert_eq!(trash[0]["replacementBookId"].as_i64(), Some(fresh.id));
    assert_eq!(trash[0]["progressPercent"].as_f64(), Some(44.0));
    assert_eq!(trash[0]["annotationCount"].as_i64(), Some(1));

    // A re-import of the same path finds the fresh alias, not the old one.
    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let after = env.books().await;
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, fresh.id);
}

/// Restore with no new state rebinds the file to the old record silently.
#[tokio::test(flavor = "multi_thread")]
async fn restore_with_no_new_state_brings_back_the_old_identity() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    let hash = env.content_hash(&old_uid).await;
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(book.id, shelf).await;
    env.save_progress(book.id, 27.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.set_title_override(book.id, "Restored Title").await;
    env.link_provider(&old_uid, "hardcover", "hc-restore").await;

    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();

    let restored = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(restored["status"], json!("restored"));
    assert_eq!(restored["bookId"].as_i64(), Some(book.id));
    assert_eq!(restored["bookUid"].as_str(), Some(old_uid.as_str()));

    let library = env.books().await;
    assert_eq!(library.len(), 1);
    assert_eq!(library[0].id, book.id, "the old identity is back");
    assert_ne!(library[0].id, fresh_id);
    assert_eq!(library[0].book_uid.as_deref(), Some(old_uid.as_str()));
    assert_eq!(env.progress_percent(book.id).await, Some(27.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.collection_book_ids(shelf).await, vec![book.id]);
    assert_eq!(env.effective_title(book.id).await, "Restored Title");
    let links = env.provider_links(&old_uid).await;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["remoteId"], json!("hc-restore"));
    assert_eq!(
        env.alias_owner(&hash).await.as_deref(),
        Some(old_uid.as_str())
    );
    assert!(
        env.trash().await.is_empty(),
        "the entry leaves the open trash"
    );
    assert_eq!(env.durable_count().await, 1, "the fresh record is gone");
}

/// A fresh identity with new progress forces an explicit choice. Replace puts
/// the old state back and discards the new.
#[tokio::test(flavor = "multi_thread")]
async fn restore_reports_a_conflict_and_replace_restores_old_state() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 18.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();
    env.save_progress(fresh_id, 55.0).await;
    env.annotate(fresh_id, "epubcfi(/6/4!/4/2,/1:10,/1:18)")
        .await;
    assert_eq!(env.trash().await[0]["hasNewState"], json!(true));

    let conflict = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(conflict["status"], json!("conflict"));
    assert_eq!(conflict["conflict"]["progressPercent"].as_f64(), Some(55.0));
    assert_eq!(conflict["conflict"]["annotationCount"].as_i64(), Some(1));
    assert_eq!(
        env.progress_percent(fresh_id).await,
        Some(55.0),
        "asking for the choice changes nothing"
    );

    let replaced = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "mode": "replace" }),
        )
        .await;
    assert_eq!(replaced["status"], json!("restored"));
    assert_eq!(env.progress_percent(book.id).await, Some(18.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.books().await[0].id, book.id);
}

/// Keep discards the snapshot and leaves the fresh identity and its new state
/// exactly where the user left them.
#[tokio::test(flavor = "multi_thread")]
async fn restore_keep_keeps_the_current_book() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 10.0).await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();
    env.save_progress(fresh_id, 62.0).await;
    env.annotate(fresh_id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;

    let kept = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "mode": "keep" }),
        )
        .await;
    assert_eq!(kept["status"], json!("kept"));
    assert_eq!(kept["bookId"].as_i64(), Some(fresh_id));
    assert_eq!(env.books().await[0].id, fresh_id);
    assert_eq!(env.progress_percent(fresh_id).await, Some(62.0));
    assert_eq!(env.annotation_count(fresh_id).await, 1);
    assert!(env.trash().await.is_empty());
    assert_eq!(env.durable_count().await, 1);
}

/// Merge keeps the newer progress and unions annotations on the current
/// identity.
#[tokio::test(flavor = "multi_thread")]
async fn restore_merge_takes_newer_progress_and_both_annotations() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 20.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash = env.trash().await;
    let trash_id = trash[0]["id"].as_i64().unwrap();
    env.save_progress(fresh_id, 65.0).await;
    env.annotate(fresh_id, "epubcfi(/6/4!/4/2,/1:10,/1:18)")
        .await;

    let merged = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "mode": "merge" }),
        )
        .await;
    assert_eq!(merged["status"], json!("restored"));
    assert_eq!(merged["bookId"].as_i64(), Some(fresh_id));
    assert_eq!(
        env.progress_percent(fresh_id).await,
        Some(65.0),
        "the newer save wins"
    );
    assert_eq!(
        env.annotation_count(fresh_id).await,
        2,
        "both annotations survive the merge"
    );
    assert!(env.trash().await.is_empty());
}

/// Bulk Forget from Reading history applies the same local rebind to each
/// selected book and returns one trash entry per book.
#[tokio::test(flavor = "multi_thread")]
async fn bulk_forget_rebinds_every_selected_library_book() {
    let env = setup().await;
    env.write_book("minimal.epub", &minimal_epub());
    env.write_book("navigation.epub", &navigation_epub());
    env.scan().await;
    let before = env.books().await;
    assert_eq!(before.len(), 2);
    for book in &before {
        env.save_progress(book.id, 40.0).await;
    }

    let result = env
        .rpc(
            "forget_books",
            json!({ "bookIds": before.iter().map(|book| book.id).collect::<Vec<_>>() }),
        )
        .await;
    assert_eq!(result["forgotten"].as_i64(), Some(2));
    assert_eq!(result["trashIds"].as_array().unwrap().len(), 2);

    let after = env.books().await;
    assert_eq!(after.len(), 2, "both library entries survive");
    for (old, fresh) in before.iter().zip(after.iter()) {
        assert_ne!(fresh.id, old.id);
        assert_ne!(fresh.book_uid, old.book_uid);
        assert_eq!(env.progress_percent(fresh.id).await, None);
    }
    assert_eq!(env.trash().await.len(), 2);
    assert_eq!(env.durable_count().await, 2);
}
