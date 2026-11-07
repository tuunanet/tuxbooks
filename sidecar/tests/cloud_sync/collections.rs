use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn collection_and_membership_survive_the_trip() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"collection book").await;
    let collection = collections::create_collection(&a.pool, "Favorites")
        .await
        .unwrap();
    collections::add_book_to_collection(&a.pool, a_book, collection)
        .await
        .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"collection book").await;
    run(&b).await;
    run(&b).await;

    let summaries = collections::list_collection_summaries(&b.pool)
        .await
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].name, "Favorites");
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(summaries[0].book_ids, vec![b_book]);
    assert_eq!(summaries[0].memberships.len(), 1);
    assert_eq!(summaries[0].memberships[0].book_id, b_book);
}

#[tokio::test(flavor = "multi_thread")]
async fn membership_added_at_survives_the_sync_projection() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"timestamp book").await;
    let collection = collections::create_collection(&a.pool, "Favorites")
        .await
        .unwrap();

    // A fixed timestamp makes the round trip exact: the insert trigger puts
    // added_at in the membership operation, and B's projection must write
    // that value instead of its own clock.
    let added_at = "2021-02-03T04:05:06.000Z";
    let book_uid: String = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(a_book)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO book_collections (book_uid, collection_id, added_at) VALUES (?1, ?2, ?3)",
    )
    .bind(&book_uid)
    .bind(collection)
    .bind(added_at)
    .execute(&a.pool)
    .await
    .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"timestamp book").await;
    run(&b).await;
    run(&b).await;

    let b_book = book_id(&b, "same.epub").await;
    let summaries = collections::list_collection_summaries(&b.pool)
        .await
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].memberships.len(), 1);
    assert_eq!(summaries[0].memberships[0].book_id, b_book);
    assert_eq!(
        summaries[0].memberships[0].added_at,
        chrono::DateTime::parse_from_rfc3339(added_at)
            .unwrap()
            .with_timezone(&chrono::Utc)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unwatch_on_one_machine_does_not_delete_the_other_machines_state() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"book that will be unwatched";
    let a_book = add_book(&a, "same.epub", bytes).await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", bytes).await;
    run(&b).await;
    run(&b).await;
    let b_book = book_id(&b, "same.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);

    books::delete_book(&a.pool, a_book).await.unwrap();
    run(&a).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, b_book).await,
        1,
        "A's local removal must not become a shared delete"
    );

    let _a_book_again = add_book(&a, "same.epub", bytes).await;
    run(&a).await;
    run(&a).await;
    let a_book_again = book_id(&a, "same.epub").await;
    assert_eq!(
        annotation_count(&a, a_book_again).await,
        1,
        "the annotation returns when the same content is re-imported"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn same_named_collections_merge_instead_of_duplicating() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"same shelf").await;
    let b_book = add_book(&b, "same.epub", b"same shelf").await;
    let a_collection = collections::create_collection(&a.pool, "Favorites")
        .await
        .unwrap();
    let b_collection = collections::create_collection(&b.pool, "Favorites")
        .await
        .unwrap();
    collections::add_book_to_collection(&a.pool, a_book, a_collection)
        .await
        .unwrap();
    collections::add_book_to_collection(&b.pool, b_book, b_collection)
        .await
        .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    run(&a).await;
    run(&b).await;

    for device in [&a, &b] {
        let summaries = collections::list_collection_summaries(&device.pool)
            .await
            .unwrap();
        assert_eq!(summaries.len(), 1, "one shelf, not two");
        assert_eq!(summaries[0].name, "Favorites");
        assert_eq!(summaries[0].book_ids.len(), 1);
    }
}
