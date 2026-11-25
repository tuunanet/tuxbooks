//! The Last known path of a detached record (ADR 0014 D5, tuxbooks-t9p.1).
//! When a book's last file row is deleted, the durable record keeps the path
//! of the copy the reader opened, shows it on the Detached records row, keeps
//! it through Forget into the trash, and clears it when a file attaches again.

use crate::common::*;
use std::path::Path;

fn sp(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
use tuxbooks_lib::repository::books;

/// Two copies of one durable book, the first import available and the second
/// unavailable on disk, so the reader's copy (available first, then lowest
/// row id) is a specific row the assertions can name.
async fn two_copies_reader_copy_first(env: &Env) -> (String, String) {
    let source = minimal_epub();
    env.write_book("first.epub", &source);
    env.write_book("second.epub", &source);
    env.scan().await;
    let book = imported_book(env).await;
    let mut files = books::list_files_for_book(&env.pool, book.id).await.unwrap();
    assert_eq!(files.len(), 2, "the duplicate copies share one record");
    files.sort_by_key(|file| file.id);
    let (low, high) = (files.remove(0), files.remove(0));
    books::set_availability_prefix(&env.pool, &high.path, false)
        .await
        .unwrap();
    let library = env.books().await;
    assert_eq!(
        library[0].path, low.path,
        "the reader's copy is the available lowest-id row"
    );
    (low.path.clone(), high.path.clone())
}

async fn imported_book(env: &Env) -> tuxbooks_lib::domain::Book {
    let library = env.books().await;
    assert_eq!(library.len(), 1, "one durable book");
    library.into_iter().next().unwrap()
}

/// Remove stores the reader's copy, not the row the delete visited last.
#[tokio::test(flavor = "multi_thread")]
async fn remove_stores_the_reader_s_copy_of_a_multi_copy_book() {
    let env = setup().await;
    let (reader_path, missing_path) = two_copies_reader_copy_first(&env).await;

    let book = imported_book(&env).await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;

    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["lastKnownPath"].as_str(), Some(reader_path.as_str()));
    assert_ne!(
        history[0]["lastKnownPath"].as_str(),
        Some(missing_path.as_str()),
        "the copy the reader could not open is not the remembered one"
    );
}

/// Removing the last copy from the book details detaches with the path.
#[tokio::test(flavor = "multi_thread")]
async fn removing_the_last_copy_stores_its_path() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    let file_id = books::file_ids_for_book(&env.pool, book.id)
        .await
        .unwrap()
        .remove(0);

    env.rpc(
        "remove_book_file",
        json!({ "bookId": book.id, "fileId": file_id }),
    )
    .await;

    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0]["lastKnownPath"].as_str(),
        Some(sp(&path).as_str())
    );
}

/// Unwatch processes rows one at a time in its own order; the stored path is
/// still the reader's copy even when that row is deleted first.
#[tokio::test(flavor = "multi_thread")]
async fn unwatch_stores_the_reader_s_copy_of_a_multi_copy_book() {
    let env = setup().await;
    let (reader_path, _missing_path) = two_copies_reader_copy_first(&env).await;

    env.rpc(
        "unwatch_locations",
        json!({ "paths": [env.library.to_string_lossy()] }),
    )
    .await;

    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["lastKnownPath"].as_str(), Some(reader_path.as_str()));
}

/// A single-copy folder detaches with the path when it is unwatched.
#[tokio::test(flavor = "multi_thread")]
async fn unwatching_one_copy_stores_its_path() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;

    env.rpc(
        "unwatch_locations",
        json!({ "paths": [env.library.to_string_lossy()] }),
    )
    .await;

    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0]["lastKnownPath"].as_str(),
        Some(sp(&path).as_str())
    );
}

/// Importing a file again attaches it and clears the stored hint; a Forget
/// afterwards snapshots no path, because the record has a file again.
#[tokio::test(flavor = "multi_thread")]
async fn importing_the_file_again_clears_the_stored_path() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    assert_eq!(
        env.history().await[0]["lastKnownPath"].as_str(),
        Some(sp(&path).as_str())
    );

    env.rpc("import_paths", json!({ "paths": [path.to_string_lossy()] }))
        .await;
    assert!(env.history().await.is_empty(), "the file re-attaches");

    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash = env.trash().await;
    assert_eq!(trash.len(), 1);
    assert!(
        trash[0]["lastKnownPath"].is_null(),
        "no stale hint lingers once a file is attached"
    );
}

/// Forgetting a detached record carries the path into its trash snapshot.
#[tokio::test(flavor = "multi_thread")]
async fn forgetting_a_detached_record_carries_the_path_into_the_trash() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;

    let trash = env.trash().await;
    assert_eq!(trash.len(), 1);
    assert_eq!(
        trash[0]["lastKnownPath"].as_str(),
        Some(sp(&path).as_str())
    );
}

/// A restore without a file returns the record to Detached records and the
/// remembered path comes back with it.
#[tokio::test(flavor = "multi_thread")]
async fn restore_returns_the_path_to_the_detached_record() {
    let env = setup().await;
    let path = env.write_book("book.epub", &minimal_epub());
    env.scan().await;
    let book = imported_book(&env).await;
    env.rpc("remove_book", json!({ "bookId": book.id })).await;
    env.rpc("forget_book", json!({ "bookId": book.id })).await;
    let trash_id = env.trash().await.remove(0)["id"].as_i64().unwrap();

    let result = env
        .rpc("restore_book", json!({ "trashId": trash_id }))
        .await;
    assert_eq!(result["status"], json!("restored"));

    let history = env.history().await;
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0]["lastKnownPath"].as_str(),
        Some(sp(&path).as_str())
    );
}
