//! Restore with a picked file (tuxbooks-t9p.2): the command validates the
//! pick before anything is written, restores onto the library book that owns
//! the picked path, and asks Replace / Keep / Merge whenever that book holds
//! any of the six kinds of user state.

use crate::common::*;

/// A copy of the book's bytes, outside every watched folder.
fn pick_copy(env: &Env, name: &str, source: &Path) -> PathBuf {
    let picks = env._tmp.path().join("picks");
    std::fs::create_dir_all(&picks).unwrap();
    let path = picks.join(name);
    std::fs::copy(source, &path).unwrap();
    path
}

/// A matching pick restores the record with the file attached: the book is
/// back in the library with its reading data and the trash entry is consumed.
#[tokio::test(flavor = "multi_thread")]
async fn a_matching_pick_restores_with_the_file_attached() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    env.save_progress(book.id, 31.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();

    let picked = pick_copy(&env, "restored.epub", &minimal_epub());
    let result = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": picked.to_string_lossy() }),
        )
        .await;
    assert_eq!(result["status"], json!("restored"));
    assert_eq!(result["bookId"].as_i64(), Some(book.id));
    assert_eq!(result["bookUid"].as_str(), Some(old_uid.as_str()));

    let library = env.books().await;
    assert_eq!(library.len(), 1, "the book is in the library again");
    assert_eq!(library[0].id, book.id);
    assert_eq!(library[0].path, picked.to_string_lossy());
    assert_eq!(env.progress_percent(book.id).await, Some(31.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert!(env.trash().await.is_empty(), "the trash entry is consumed");
    assert_eq!(env.durable_count().await, 1);
}

/// Validation runs before anything is written: a pick that is missing or not
/// a readable book reports why and leaves the trash entry untouched.
#[tokio::test(flavor = "multi_thread")]
async fn an_unusable_pick_leaves_the_trash_untouched() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 12.0).await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();

    let missing = env._tmp.path().join("picks").join("gone.epub");
    let err = env
        .rpc_raw(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": missing.to_string_lossy() }),
        )
        .await;
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no file exists"),
        "a missing pick names the reason: {err}"
    );

    let not_a_book = pick_copy(&env, "notes.txt", &minimal_epub());
    let err = env
        .rpc_raw(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": not_a_book.to_string_lossy() }),
        )
        .await;
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not a readable book"),
        "an unreadable pick names the reason: {err}"
    );

    assert_eq!(env.trash().await.len(), 1, "the entry is still restorable");
    let still_there = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(still_there["status"], json!("restored"));
    assert_eq!(env.progress_percent(book.id).await, Some(12.0));
}

/// Since t9p.3, bytes that match none of the snapshot's hashes report the
/// lossless choices instead of failing, and nothing is consumed.
#[tokio::test(flavor = "multi_thread")]
async fn a_pick_with_different_bytes_is_refused() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 9.0).await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();

    let other = pick_copy(&env, "other.epub", &navigation_epub());
    let report = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": other.to_string_lossy() }),
        )
        .await;
    assert_eq!(report["status"], json!("different_bytes"));
    assert_eq!(report["differentBytes"]["ownerBookId"], json!(null));
    assert_eq!(env.trash().await.len(), 1, "nothing was consumed");
    assert_eq!(env.durable_count().await, 0, "nothing was restored");
}

/// A picked file the library already owns takes that book's place as the
/// replacement: with none of the six kinds of user state it is replaced
/// silently, whether the Forget created it or a later import did.
#[tokio::test(flavor = "multi_thread")]
async fn a_pick_owned_by_a_stateless_book_replaces_silently() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 27.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();

    let restored = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": path.to_string_lossy() }),
        )
        .await;
    assert_eq!(restored["status"], json!("restored"));
    assert_eq!(restored["bookId"].as_i64(), Some(book.id));

    let library = env.books().await;
    assert_eq!(library.len(), 1);
    assert_eq!(library[0].id, book.id, "the old identity owns the entry");
    assert_eq!(library[0].path, path.to_string_lossy());
    assert_eq!(env.progress_percent(book.id).await, Some(27.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(
        env.durable_count().await,
        1,
        "the stateless fresh identity is gone"
    );
    assert_ne!(fresh_id, book.id);
    assert!(env.trash().await.is_empty());
}

/// The import-first case: the picked path belongs to a book a later import
/// created. When that book holds only a collection membership — state the old
/// two-kind check ignored — the restore asks instead of destroying it.
#[tokio::test(flavor = "multi_thread")]
async fn a_pick_owned_by_a_book_with_only_a_collection_asks() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 20.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();

    // A later import of the same bytes is a genuinely new book (the aliases
    // went with the Forget).
    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let owner = imported_book(&env).await;
    assert_ne!(owner.id, book.id);
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(owner.id, shelf).await;

    let conflict = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": path.to_string_lossy() }),
        )
        .await;
    assert_eq!(conflict["status"], json!("conflict"));
    assert_eq!(
        conflict["conflict"]["collections"].as_i64(),
        Some(1),
        "the conflict names the collection membership"
    );
    assert_eq!(conflict["bookId"].as_i64(), Some(owner.id));
    assert_eq!(
        env.collection_book_ids(shelf).await,
        vec![owner.id],
        "asking for the choice changes nothing"
    );
    assert_eq!(env.trash().await.len(), 1, "the entry is still open");

    let replaced = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": path.to_string_lossy(), "mode": "replace" }),
        )
        .await;
    assert_eq!(replaced["status"], json!("restored"));
    assert_eq!(replaced["bookId"].as_i64(), Some(book.id));
    assert!(
        env.collection_book_ids(shelf).await.is_empty(),
        "Replace destroys the fresh identity's membership with it"
    );
    assert_eq!(env.progress_percent(book.id).await, Some(20.0));
    assert_eq!(env.annotation_count(book.id).await, 1);
    assert_eq!(env.books().await.len(), 1);
    assert_eq!(env.books().await[0].id, book.id);
    assert!(env.trash().await.is_empty());
}

/// The same six-kind check applies to the Forget-time replacement path: a
/// fresh identity holding only a collection membership forces the choice
/// even with no picked file.
#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_identity_with_only_a_collection_asks_without_a_pick() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 15.0).await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(fresh_id, shelf).await;
    assert_eq!(
        env.trash().await[0]["hasNewState"],
        json!(true),
        "a membership alone counts as new state"
    );

    let conflict = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(conflict["status"], json!("conflict"));
    assert_eq!(conflict["conflict"]["collections"].as_i64(), Some(1));
    assert_eq!(
        env.collection_book_ids(shelf).await,
        vec![fresh_id],
        "the membership was not destroyed"
    );
}

/// Keep with an explicit replacement acts on the picked owner: the old
/// snapshot is discarded and nothing is restored detached.
#[tokio::test(flavor = "multi_thread")]
async fn keep_with_a_picked_owner_never_restores_detached() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    env.save_progress(book.id, 10.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();

    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let owner = imported_book(&env).await;
    env.save_progress(owner.id, 62.0).await;

    let kept = env
        .rpc(
            "restore_book",
            json!({
                "trashId": trash_id,
                "pickedPath": path.to_string_lossy(),
                "mode": "keep",
            }),
        )
        .await;
    assert_eq!(kept["status"], json!("kept"));
    assert_eq!(kept["bookId"].as_i64(), Some(owner.id));
    assert_eq!(env.durable_count().await, 1, "no detached record came back");
    let old_record: Option<(i64,)> = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_optional(&env.pool)
        .await
        .unwrap();
    assert!(old_record.is_none(), "Keep never resurrects the old record");
    assert_eq!(env.progress_percent(owner.id).await, Some(62.0));
    assert!(env.trash().await.is_empty());
}

/// Merge with an explicit replacement folds the old state into the picked
/// owner instead of falling through to a detached restore.
#[tokio::test(flavor = "multi_thread")]
async fn merge_with_a_picked_owner_folds_old_state_into_it() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    let shelf = env.create_collection("Shelf").await;
    env.add_to_collection(book.id, shelf).await;
    env.save_progress(book.id, 20.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();

    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    let owner = imported_book(&env).await;
    env.save_progress(owner.id, 65.0).await;
    env.annotate(owner.id, "epubcfi(/6/4!/4/2,/1:10,/1:18)")
        .await;

    let merged = env
        .rpc(
            "restore_book",
            json!({
                "trashId": trash_id,
                "pickedPath": path.to_string_lossy(),
                "mode": "merge",
            }),
        )
        .await;
    assert_eq!(merged["status"], json!("restored"));
    assert_eq!(merged["bookId"].as_i64(), Some(owner.id));
    assert_eq!(env.durable_count().await, 1, "no detached record came back");
    let old_record: Option<(i64,)> = sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
        .bind(&old_uid)
        .fetch_optional(&env.pool)
        .await
        .unwrap();
    assert!(
        old_record.is_none(),
        "Merge never resurrects the old record"
    );
    assert_eq!(
        env.progress_percent(owner.id).await,
        Some(65.0),
        "the newer save wins"
    );
    assert_eq!(
        env.annotation_count(owner.id).await,
        2,
        "both annotations survive the merge"
    );
    assert_eq!(env.collection_book_ids(shelf).await, vec![owner.id]);
    assert!(env.trash().await.is_empty());
}
