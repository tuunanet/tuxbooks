use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn a_waiting_book_can_be_hidden_on_one_machine_and_still_attach_later() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = b"waiting book bytes";
    let a_book = add_book(&a, "waiting.epub", bytes).await;
    reading_progress::upsert_progress(
        &a.pool,
        a_book,
        &ProgressUpdate {
            progress_percent: Some(42.0),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    annotations::insert_annotation(
        &a.pool,
        a_book,
        &NewAnnotation {
            kind: AnnotationKind::Highlight,
            cfi: Some("epubcfi(/6/4)".into()),
            chapter_href: Some("chapter1.xhtml".into()),
            page_number: None,
            page_fraction: None,
            text: Some("sample highlight".into()),
            color: Some("yellow".into()),
            geometry: None,
        },
    )
    .await
    .unwrap();
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    run(&b).await;
    let waiting_books = waiting::list(&b.pool).await.unwrap();
    assert_eq!(waiting_books.len(), 1);
    let waiting_book = &waiting_books[0];
    assert_eq!(waiting_book.annotation_count, 1);
    assert_eq!(waiting_book.progress_percent, Some(42.0));
    assert_eq!(
        waiting_book.sample_annotation.as_deref(),
        Some("sample highlight")
    );
    assert_eq!(b.service.status().await.unwrap().waiting_books, 1);

    assert!(b
        .service
        .forget_waiting_book(&waiting_book.book_uid)
        .await
        .unwrap());
    assert!(waiting::list(&b.pool).await.unwrap().is_empty());
    assert_eq!(b.service.status().await.unwrap().waiting_books, 0);

    // Hiding the waiting state is local. Importing the same bytes still joins
    // the mirror state to the book.
    add_book(&b, "waiting.epub", bytes).await;
    run(&b).await;
    let b_book = book_id(&b, "waiting.epub").await;
    assert_eq!(annotation_count(&b, b_book).await, 1);
    assert_eq!(progress_percent(&b, b_book).await, Some(42.0));
}

#[tokio::test(flavor = "multi_thread")]
async fn all_waiting_books_can_be_hidden_at_once() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let one = add_book(&a, "one.epub", b"one").await;
    let two = add_book(&a, "two.epub", b"two").await;
    for (book_id, percent) in [(one, 10.0), (two, 20.0)] {
        reading_progress::upsert_progress(
            &a.pool,
            book_id,
            &ProgressUpdate {
                progress_percent: Some(percent),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    run(&b).await;
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 2);
    assert_eq!(b.service.status().await.unwrap().waiting_books, 2);

    assert_eq!(waiting::forget_all(&b.pool).await.unwrap(), 2);
    assert!(waiting::list(&b.pool).await.unwrap().is_empty());
    assert_eq!(b.service.status().await.unwrap().waiting_books, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn waiting_books_report_metadata_progress_and_annotations() {
    let a = device().await;
    let uid = "a".repeat(32);
    let ignored = "b".repeat(32);
    let tombstoned = "c".repeat(32);

    put_state_entity(&a.pool, "metadata", &uid, &uid).await;
    put_state_field(&a.pool, "metadata", &uid, "title", "\"Waiting title\"").await;
    put_state_field(
        &a.pool,
        "metadata",
        &uid,
        "authors",
        "[\"Alice\", \"Bob\", 7]",
    )
    .await;
    // A field the waiting list does not display is ignored, not fatal.
    put_state_field(&a.pool, "metadata", &uid, "publisher", "\"Unused\"").await;
    put_state_entity(&a.pool, "progress", "p1", &uid).await;
    put_state_field(&a.pool, "progress", "p1", "progress_percent", "42.5").await;
    put_state_entity(&a.pool, "opened", "o1", &uid).await;
    put_state_field(
        &a.pool,
        "opened",
        "o1",
        "last_opened_at",
        "\"2026-01-02T03:04:05.000Z\"",
    )
    .await;
    put_state_entity(&a.pool, "annotation", "a1", &uid).await;
    put_state_field(
        &a.pool,
        "annotation",
        "a1",
        "text",
        "\"the first highlight\"",
    )
    .await;
    put_state_entity(&a.pool, "annotation", "a2", &uid).await;
    put_state_entity(&a.pool, "annotation", "a3", &uid).await;
    sqlx::query(
        "UPDATE sync_state_entities SET deleted = 1
         WHERE kind = 'annotation' AND entity_uid = 'a3'",
    )
    .execute(&a.pool)
    .await
    .unwrap();

    // Hidden books and books with a shared tombstone never appear.
    put_state_entity(&a.pool, "progress", "p2", &ignored).await;
    sqlx::query("INSERT INTO sync_ignored_books (book_uid) VALUES (?1)")
        .bind(&ignored)
        .execute(&a.pool)
        .await
        .unwrap();
    put_state_entity(&a.pool, "progress", "p3", &tombstoned).await;
    sqlx::query(
        "INSERT INTO sync_state_entities (kind, entity_uid, book_uid, deleted)
         VALUES ('book', ?1, ?1, 1)",
    )
    .bind(&tombstoned)
    .execute(&a.pool)
    .await
    .unwrap();

    assert_eq!(waiting::count(&a.pool).await.unwrap(), 1);
    let listed = a.service.waiting_books().await.unwrap();
    assert_eq!(listed.len(), 1);
    let book = &listed[0];
    assert_eq!(book.book_uid, uid);
    assert_eq!(book.title.as_deref(), Some("Waiting title"));
    assert_eq!(book.author.as_deref(), Some("Alice, Bob"));
    assert_eq!(book.progress_percent, Some(42.5));
    assert_eq!(
        book.last_opened_at.as_deref(),
        Some("2026-01-02T03:04:05.000Z")
    );
    assert_eq!(
        book.sample_annotation.as_deref(),
        Some("the first highlight")
    );
    assert_eq!(book.annotation_count, 2);
    assert_eq!(a.service.status().await.unwrap().waiting_books, 1);
    assert!(
        !a.service.forget_waiting_book("dddd").await.unwrap(),
        "an unknown uid is not waiting"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_service_forgets_all_waiting_books_in_one_call() {
    let a = device().await;
    put_state_entity(&a.pool, "progress", "p1", &"a".repeat(32)).await;
    put_state_entity(&a.pool, "progress", "p2", &"b".repeat(32)).await;
    assert_eq!(a.service.waiting_books().await.unwrap().len(), 2);

    assert_eq!(a.service.forget_all_waiting_books().await.unwrap(), 2);
    assert!(a.service.waiting_books().await.unwrap().is_empty());
    assert_eq!(a.service.status().await.unwrap().waiting_books, 0);
    assert_eq!(a.service.forget_all_waiting_books().await.unwrap(), 0);
}
