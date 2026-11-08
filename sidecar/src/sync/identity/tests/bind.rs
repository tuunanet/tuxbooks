//! Hashing, binding, and rehash tests.

use super::*;

#[tokio::test]
async fn a_rewrite_keeps_the_uuid_and_adds_a_hash_alias() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let path = tmp.path().join("book.epub");
    std::fs::write(&path, b"version one").unwrap();
    let book_id = book_with_file(&pool, &path).await;

    let first = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();
    std::fs::write(&path, b"version two is longer").unwrap();
    let (file_size, file_mtime) = snapshot(&path);
    books::update_file_snapshot(&pool, book_id, file_size, file_mtime)
        .await
        .unwrap();
    let second = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();

    assert_eq!(first.book_uid, second.book_uid);
    assert_ne!(first.content_hash, second.content_hash);
    let aliases: Vec<(String, String)> =
        sqlx::query_as("SELECT content_hash, book_uid FROM sync_book_aliases")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(aliases.len(), 2);
    assert!(aliases.iter().all(|(_, uid)| uid == &first.book_uid));
    let pending: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty WHERE kind = 'book_identity'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(pending >= 1, "the new alias is published");
}

#[tokio::test]
async fn a_pending_rehash_survives_a_missed_snapshot_update() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let path = tmp.path().join("book.epub");
    std::fs::write(&path, b"version one").unwrap();
    let book_id = book_with_file(&pool, &path).await;
    let first = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();

    // Simulate a crash after the rewrite but before the snapshot update:
    // the row and the binding both still describe the old file.
    books::mark_rehash_pending(&pool, book_id).await.unwrap();
    std::fs::write(&path, b"version two is longer").unwrap();
    let second = ensure_book_identity(&pool, book_id).await.unwrap().unwrap();

    assert_eq!(first.book_uid, second.book_uid);
    assert_ne!(first.content_hash, second.content_hash);
    let (pending, hashed): (i64, String) = sqlx::query_as(
        "SELECT b.rehash_pending, s.content_hash
         FROM books b JOIN sync_book_bindings s ON s.book_id = b.id
         WHERE b.id = ?1",
    )
    .bind(book_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pending, 0);
    assert_eq!(hashed, second.content_hash);
}

#[tokio::test]
async fn duplicate_bindings_share_one_uuid_and_record_an_issue() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let first_path = tmp.path().join("first.epub");
    let second_path = tmp.path().join("second.epub");
    std::fs::write(&first_path, b"the same bytes").unwrap();
    std::fs::write(&second_path, b"the same bytes").unwrap();
    let first = book_with_file(&pool, &first_path).await;
    let second = book_with_file(&pool, &second_path).await;

    let first_identity = ensure_book_identity(&pool, first).await.unwrap().unwrap();
    let second_identity = ensure_book_identity(&pool, second).await.unwrap().unwrap();
    assert_eq!(first_identity.book_uid, second_identity.book_uid);

    let issues: Vec<(String, String)> =
        sqlx::query_as("SELECT kind, detail FROM sync_issues WHERE kind = 'duplicate_book'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(issues.len(), 1, "one duplicate issue for the second copy");
    assert!(issues[0].1.contains("first.epub"));
    assert!(issues[0].1.contains("second.epub"));
}

#[tokio::test]
async fn identity_lookup_skips_missing_unavailable_and_vanished_books() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    assert!(
        ensure_book_identity(&pool, 999).await.unwrap().is_none(),
        "a missing row has no identity"
    );

    let missing = tmp.path().join("gone.epub");
    let present = tmp.path().join("present.epub");
    std::fs::write(&present, b"present bytes").unwrap();
    let id = book_with_file(&pool, &present).await;
    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        ensure_book_identity(&pool, id).await.unwrap().is_none(),
        "an unavailable book is skipped"
    );

    sqlx::query("UPDATE books SET available = 1, path = ?2 WHERE id = ?1")
        .bind(id)
        .bind(missing.to_string_lossy().into_owned())
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        ensure_book_identity(&pool, id).await.unwrap().is_none(),
        "a vanished file is skipped, not an error"
    );
}

#[tokio::test]
async fn bind_hash_reuses_the_uuid_the_migration_already_assigned() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let path = tmp.path().join("book.epub");
    std::fs::write(&path, b"already identified").unwrap();
    let file_id = book_with_file(&pool, &path).await;
    let existing = "a1".repeat(16);
    sqlx::query("UPDATE books SET book_uid = ?2 WHERE id = ?1")
        .bind(file_id)
        .bind(&existing)
        .execute(&pool)
        .await
        .unwrap();

    let identity = bind_hash(&pool, file_id, &"b2".repeat(32), 18, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(identity.book_uid, existing);
    let binding: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(binding, existing);
}

#[tokio::test]
async fn bind_hash_folds_both_sides_of_an_alias_collision() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    // Existing binding sorts before the alias.
    let first_path = tmp.path().join("first.epub");
    std::fs::write(&first_path, b"first").unwrap();
    let first = book_with_file(&pool, &first_path).await;
    let existing = "a".repeat(32);
    let alias = "e".repeat(32);
    let first_hash = "1".repeat(64);
    sqlx::query(
        "INSERT INTO sync_book_bindings
            (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
         VALUES (?1, ?2, 'old', 0, 0)",
    )
    .bind(first)
    .bind(&existing)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE books SET book_uid = ?2 WHERE id = ?1")
        .bind(first)
        .bind(&existing)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)")
        .bind(&first_hash)
        .bind(&alias)
        .execute(&pool)
        .await
        .unwrap();

    let identity = bind_hash(&pool, first, &first_hash, 5, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(identity.book_uid, existing, "the smaller uid wins");
    let merge: (String, String) =
        sqlx::query_as("SELECT loser, winner FROM sync_book_merges WHERE loser = ?1")
            .bind(&alias)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(merge.1, existing);

    // Existing binding sorts after the alias.
    let second_path = tmp.path().join("second.epub");
    std::fs::write(&second_path, b"second").unwrap();
    book_with_file(&pool, &second_path).await;
    let second: i64 = sqlx::query_scalar("SELECT id FROM books WHERE path = ?1")
        .bind(second_path.to_string_lossy().into_owned())
        .fetch_one(&pool)
        .await
        .unwrap();
    let later = "f".repeat(32);
    let earlier = "b".repeat(32);
    let second_hash = "2".repeat(64);
    sqlx::query(
        "INSERT INTO sync_book_bindings
            (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
         VALUES (?1, ?2, 'old', 0, 0)",
    )
    .bind(second)
    .bind(&later)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE books SET book_uid = ?2 WHERE id = ?1")
        .bind(second)
        .bind(&later)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)")
        .bind(&second_hash)
        .bind(&earlier)
        .execute(&pool)
        .await
        .unwrap();

    let identity = bind_hash(&pool, second, &second_hash, 6, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(identity.book_uid, earlier);
    let merge: (String, String) =
        sqlx::query_as("SELECT loser, winner FROM sync_book_merges WHERE loser = ?1")
            .bind(&later)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(merge.1, earlier);
}

#[tokio::test]
async fn a_forgotten_binding_is_not_an_identity_candidate() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let path = tmp.path().join("forgotten.epub");
    std::fs::write(&path, b"forgotten identity").unwrap();
    let file = book_with_file(&pool, &path).await;
    let old = "c1".repeat(16);
    let hash = "3".repeat(64);
    sqlx::query(
        "UPDATE sync_book_bindings SET book_uid = ?2, content_hash = 'old' WHERE book_id = ?1",
    )
    .bind(file)
    .bind(&old)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE books SET book_uid = ?2 WHERE id = ?1")
        .bind(file)
        .bind(&old)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, snapshot_json, deleted_wall, deleted_count, deleted_dev,
             deleted_at, expires_at)
         VALUES (?1, NULL, 10, 0, 'other', '2026-01-01T00:00:00.000Z',
                 '2999-01-01T00:00:00.000Z')",
    )
    .bind(&old)
    .execute(&pool)
    .await
    .unwrap();

    let identity = bind_hash(&pool, file, &hash, 18, 0).await.unwrap().unwrap();
    assert_ne!(identity.book_uid, old);
    let owner: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, identity.book_uid);
}

#[tokio::test]
async fn bind_hash_handles_a_legacy_row_without_a_book_uid() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let file: i64 = sqlx::query_scalar(
        "INSERT INTO books (path, title, book_uid) VALUES ('/tmp/legacy.epub', 'Legacy', NULL)
         RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let hash = "4".repeat(64);
    let identity = bind_hash(&pool, file, &hash, 0, 0).await.unwrap().unwrap();
    assert_eq!(identity.book_uid.len(), 32);
    assert_eq!(identity.content_hash, hash);
}

#[tokio::test]
async fn a_forgotten_binding_follows_its_replacement() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let path = tmp.path().join("replaced.epub");
    std::fs::write(&path, b"replaced identity").unwrap();
    let file = book_with_file(&pool, &path).await;
    let old = "c4".repeat(16);
    let fresh = "c5".repeat(16);
    let hash = "5".repeat(64);
    sqlx::query(
        "INSERT INTO sync_book_bindings
            (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
         VALUES (?1, ?2, 'old', 0, 0)",
    )
    .bind(file)
    .bind(&old)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE books SET book_uid = ?2 WHERE id = ?1")
        .bind(file)
        .bind(&old)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, replacement_book_uid, snapshot_json, deleted_wall,
             deleted_count, deleted_dev, deleted_at, expires_at)
         VALUES (?1, ?2, NULL, 10, 0, 'other', '2026-01-01T00:00:00.000Z',
                 '2999-01-01T00:00:00.000Z')",
    )
    .bind(&old)
    .bind(&fresh)
    .execute(&pool)
    .await
    .unwrap();

    let identity = bind_hash(&pool, file, &hash, 18, 0).await.unwrap().unwrap();
    assert_eq!(
        identity.book_uid, fresh,
        "the alias follows the live replacement, never the dead identity"
    );
}
