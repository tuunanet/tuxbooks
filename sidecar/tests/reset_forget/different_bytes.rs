//! Different-bytes picks (tuxbooks-t9p.3): restore never merges bytes it
//! cannot prove, and answers with the lossless choices instead.

use crate::common::*;

/// A copy of a book's bytes, outside every watched folder.
fn pick_copy(env: &Env, name: &str, source: &Path) -> PathBuf {
    let picks = env._tmp.path().join("picks");
    std::fs::create_dir_all(&picks).unwrap();
    let path = picks.join(name);
    std::fs::copy(source, &path).unwrap();
    path
}

async fn forget_without_a_file(env: &Env) -> (i64, i64, String) {
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.save_progress(book.id, 9.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();
    (book.id, trash_id, book.book_uid.clone().unwrap())
}

/// Import a different book outside the library folder: import_paths scans
/// the file's parent folder, so a private folder keeps the fixtures apart.
async fn import_other_book(env: &Env) -> Book {
    let folder = env._tmp.path().join("other-library");
    std::fs::create_dir_all(&folder).unwrap();
    let other = folder.join("other.epub");
    std::fs::copy(navigation_epub(), &other).unwrap();
    env.rpc("import_paths", json!({ "paths": [other.to_string_lossy()] }))
        .await;
    env.books()
        .await
        .into_iter()
        .find(|entry| entry.path == other.to_string_lossy())
        .expect("the other book is in the library")
}

/// A pick whose bytes match nothing reports the choices and the forgotten
/// book's identity; nothing is restored and the trash entry stays open.
#[tokio::test(flavor = "multi_thread")]
async fn a_different_bytes_pick_reports_the_lossless_choices() {
    let env = setup().await;
    let (book_id, trash_id, old_uid) = forget_without_a_file(&env).await;

    let picked = pick_copy(&env, "other.epub", &navigation_epub());
    let report = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": picked.to_string_lossy() }),
        )
        .await;
    assert_eq!(report["status"], json!("different_bytes"));
    assert_eq!(report["bookId"], json!(null));
    let payload = &report["differentBytes"];
    assert_eq!(payload["title"], json!("A Minimal Book"));
    assert_eq!(payload["author"], json!("Ada Lovelace"));
    assert_eq!(payload["progressPercent"], json!(9.0));
    assert_eq!(payload["annotationCount"], json!(1));
    assert_eq!(payload["ownerBookId"], json!(null));

    assert_eq!(env.trash().await.len(), 1, "the report consumes nothing");
    assert_eq!(env.durable_count().await, 0, "nothing was restored");
    assert!(
        !books::has_file_rows(&env.pool, &old_uid).await.unwrap(),
        "no file came back for book {book_id}"
    );
}

/// When a library book already owns the pick, the report names it: that
/// owner is what makes the edition choice available.
#[tokio::test(flavor = "multi_thread")]
async fn the_report_names_the_book_that_owns_the_pick() {
    let env = setup().await;
    let (_book_id, trash_id, _old_uid) = forget_without_a_file(&env).await;

    let owner = import_other_book(&env).await;

    let report = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": owner.path }),
        )
        .await;
    assert_eq!(report["status"], json!("different_bytes"));
    assert_eq!(report["differentBytes"]["ownerBookId"], json!(owner.id));
    assert_eq!(report["differentBytes"]["annotationCount"], json!(1));
    assert_eq!(env.trash().await.len(), 1, "the report consumes nothing");
}

/// Link as an edition restores the record detached, keeps its annotations,
/// and moves the old progress percentage and provider link onto the owner.
#[tokio::test(flavor = "multi_thread")]
async fn linking_as_an_edition_moves_progress_and_provider_link() {
    let env = setup().await;
    env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    env.save_progress(book.id, 9.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    env.link_provider(&old_uid, "hardcover", "remote-7").await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();
    let owner = import_other_book(&env).await;
    let owner_uid = owner.book_uid.clone().unwrap();

    let linked = env
        .rpc(
            "restore_book",
            json!({
                "trashId": trash_id,
                "pickedPath": owner.path,
                "mode": "link_edition",
            }),
        )
        .await;
    assert_eq!(linked["status"], json!("restored"));
    assert_eq!(linked["bookId"].as_i64(), Some(book.id));

    assert_eq!(
        env.annotation_count(book.id).await,
        1,
        "the annotations stay with the restored record"
    );
    assert_eq!(
        env.annotation_count(owner.id).await,
        0,
        "the owner gains no annotations"
    );
    assert_eq!(
        env.progress_percent(owner.id).await,
        Some(9.0),
        "the old progress copies over as a percentage"
    );
    let editions = env
        .rpc("list_book_editions", json!({ "bookId": owner.id }))
        .await;
    assert_eq!(
        editions.as_array().unwrap().len(),
        1,
        "the restored record is linked as an edition"
    );
    assert_eq!(editions[0]["id"].as_i64(), Some(book.id));
    assert_eq!(editions[0]["inLibrary"], json!(false));
    assert!(
        env.provider_links(&old_uid).await.is_empty(),
        "the provider link moved off the restored record"
    );
    let moved = env.provider_links(&owner_uid).await;
    assert_eq!(moved.len(), 1);
    assert_eq!(moved[0]["provider"], json!("hardcover"));
    assert_eq!(moved[0]["remoteId"], json!("remote-7"));

    let library = env.books().await;
    assert_eq!(library.len(), 1, "the restored record has no file");
    assert_eq!(library[0].id, owner.id);
    assert_eq!(library[0].path, owner.path, "the pick stays where it was");
    assert_eq!(env.durable_count().await, 2);
    assert!(env.trash().await.is_empty(), "the trash entry is consumed");
}

/// Restore without file brings the record back detached and touches nothing
/// else: not the picked file, not the Forget-time fresh identity.
#[tokio::test(flavor = "multi_thread")]
async fn restoring_without_the_file_leaves_every_library_book_alone() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let old_uid = book.book_uid.clone().unwrap();
    env.save_progress(book.id, 9.0).await;
    env.annotate(book.id, "epubcfi(/6/4!/4/2,/1:0,/1:8)").await;
    let outcome = env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let fresh_id = outcome["replacementBookId"].as_i64().unwrap();
    let trash_id = env.trash().await[0]["id"].as_i64().unwrap();
    let owner = import_other_book(&env).await;

    let report = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": owner.path }),
        )
        .await;
    assert_eq!(report["status"], json!("different_bytes"));
    assert_eq!(report["differentBytes"]["ownerBookId"], json!(owner.id));

    let restored = env
        .rpc(
            "restore_book",
            json!({
                "trashId": trash_id,
                "pickedPath": owner.path,
                "mode": "without_file",
            }),
        )
        .await;
    assert_eq!(restored["status"], json!("restored"));
    assert_eq!(restored["bookId"].as_i64(), Some(book.id));

    assert_eq!(
        env.annotation_count(book.id).await,
        1,
        "the record comes back with its annotations"
    );
    assert_eq!(env.progress_percent(book.id).await, Some(9.0));
    assert!(
        !books::has_file_rows(&env.pool, &old_uid).await.unwrap(),
        "the record is detached"
    );
    let library = env.books().await;
    assert_eq!(library.len(), 2, "both library entries survive");
    let fresh = library.iter().find(|entry| entry.id == fresh_id).unwrap();
    assert_eq!(
        fresh.path, path.to_string_lossy(),
        "the fresh identity keeps the Forget-time file"
    );
    assert!(library.iter().any(|entry| entry.id == owner.id));
    assert_eq!(
        env.durable_count().await,
        3,
        "fresh identity, later import, restored record"
    );
    assert!(env.trash().await.is_empty(), "the trash entry is consumed");
}

/// Replace, Keep, and Merge need bytes the snapshot can prove; on different
/// bytes they are refused, and a matching pick still restores normally.
#[tokio::test(flavor = "multi_thread")]
async fn the_merge_modes_are_refused_on_different_bytes() {
    let env = setup().await;
    let (_book_id, trash_id, _old_uid) = forget_without_a_file(&env).await;
    let picked = pick_copy(&env, "other.epub", &navigation_epub());

    for mode in ["replace", "keep", "merge"] {
        let err = env
            .rpc_raw(
                "restore_book",
                json!({
                    "trashId": trash_id,
                    "pickedPath": picked.to_string_lossy(),
                    "mode": mode,
                }),
            )
            .await;
        assert!(
            err["error"]["message"].as_str().unwrap().contains("do not match"),
            "{mode} names the byte mismatch: {err}"
        );
    }
    assert_eq!(env.trash().await.len(), 1, "nothing was consumed");

    let matching = pick_copy(&env, "same.epub", &minimal_epub());
    let restored = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": matching.to_string_lossy() }),
        )
        .await;
    assert_eq!(restored["status"], json!("restored"));
}

/// The lossless modes only answer a different-bytes report: a pick with no
/// owner cannot link, a matching pick restores normally, and a missing pick
/// names what the modes need.
#[tokio::test(flavor = "multi_thread")]
async fn the_lossless_modes_only_follow_a_different_bytes_report() {
    let env = setup().await;
    let (_book_id, trash_id, _old_uid) = forget_without_a_file(&env).await;
    let picked = pick_copy(&env, "other.epub", &navigation_epub());

    let err = env
        .rpc_raw(
            "restore_book",
            json!({
                "trashId": trash_id,
                "pickedPath": picked.to_string_lossy(),
                "mode": "link_edition",
            }),
        )
        .await;
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("already in the library"),
        "linking needs an owner: {err}"
    );

    let err = env
        .rpc_raw("restore_book", json!({ "trashId": trash_id, "mode": "without_file" }))
        .await;
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no file was picked"),
        "the modes need the pick they answer: {err}"
    );

    let matching = pick_copy(&env, "same.epub", &minimal_epub());
    for mode in ["link_edition", "without_file"] {
        let err = env
            .rpc_raw(
                "restore_book",
                json!({
                    "trashId": trash_id,
                    "pickedPath": matching.to_string_lossy(),
                    "mode": mode,
                }),
            )
            .await;
        assert!(
            err["error"]["message"]
                .as_str()
                .unwrap()
                .contains("restore them normally"),
            "{mode} on matching bytes names the normal path: {err}"
        );
    }

    assert_eq!(env.trash().await.len(), 1, "nothing was consumed");
    let restored = env
        .rpc(
            "restore_book",
            json!({ "trashId": trash_id, "pickedPath": matching.to_string_lossy() }),
        )
        .await;
    assert_eq!(restored["status"], json!("restored"));
}
