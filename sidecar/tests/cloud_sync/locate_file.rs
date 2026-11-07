use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn locate_file_attaches_a_waiting_book_from_the_exact_bytes() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = fixture_epub("../tests/fixtures/books/minimal.epub");
    let a_book = add_book(&a, "located.epub", &bytes).await;
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
            text: Some("exact bytes highlight".into()),
            color: Some("yellow".into()),
            geometry: None,
        },
    )
    .await
    .unwrap();
    let overrides = metadata_repo::OverrideRow {
        title: Some("The Located Title".into()),
        authors_customized: true,
        ..metadata_repo::OverrideRow::default()
    };
    metadata::apply_synced_overrides(&a.pool, a_book, &overrides, &["Ada Lovelace".into()], &[])
        .await
        .unwrap();
    books::mark_opened(&a.pool, a_book).await.unwrap();
    let shelf = collections::create_collection(&a.pool, "Located shelf")
        .await
        .unwrap();
    collections::add_book_to_collection(&a.pool, a_book, shelf)
        .await
        .unwrap();
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    connect(&b, sync_dir.path()).await;
    run(&b).await;
    let waiting = waiting::list(&b.pool).await.unwrap();
    assert_eq!(waiting.len(), 1);
    let uid = waiting[0].book_uid.clone();
    // B has never imported this book, so only the mirror describes it.
    let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&uid)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(records, 0, "the waiting book has no durable record yet");

    let path = place_file(&b, "located.epub", &bytes);
    let book = b
        .service
        .attach_waiting_book(&uid, &path, &[])
        .await
        .unwrap();

    assert_eq!(book.book_uid.as_deref(), Some(uid.as_str()));
    assert_eq!(book.path, path.to_string_lossy());
    assert_eq!(book.id, book_id(&b, "located.epub").await);
    assert!(waiting::list(&b.pool).await.unwrap().is_empty());
    assert_eq!(b.service.status().await.unwrap().waiting_books, 0);
    assert_eq!(annotation_count(&b, book.id).await, 1);
    assert_eq!(progress_percent(&b, book.id).await, Some(42.0));
    assert_eq!(book.title, "The Located Title");
    assert_eq!(book.author.as_deref(), Some("Ada Lovelace"));
    assert!(book.last_opened_at.is_some(), "last-opened is applied");
    let member: Option<i64> = sqlx::query_scalar(
        "SELECT br.id FROM book_collections bc
         JOIN book_records br ON br.uid = bc.book_uid
         JOIN collections c ON c.id = bc.collection_id
         WHERE c.name = ?1 AND br.id = ?2",
    )
    .bind("Located shelf")
    .bind(book.id)
    .fetch_optional(&b.pool)
    .await
    .unwrap();
    assert_eq!(member, Some(book.id), "collection membership is applied");
    let binding: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_row_id(&b, "located.epub").await)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(binding, uid);
}

#[tokio::test(flavor = "multi_thread")]
async fn locate_file_rejects_a_different_book_and_unseen_bytes() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let waiting_bytes = fixture_epub("../tests/fixtures/books/minimal.epub");
    let other_bytes = fixture_epub("../tests/fixtures/epub/core/epub3/navigation.epub");
    let unseen_bytes = fixture_epub("../tests/fixtures/epub/core/epub3/content.epub");
    let waiting = add_book(&a, "waiting.epub", &waiting_bytes).await;
    seed_progress(&a, waiting, 55.0).await;
    let other = add_book(&a, "other.epub", &other_bytes).await;
    let waiting_uid = book_uid(&a, waiting).await;
    seed_progress(&a, other, 10.0).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    let waiting_books = waiting::list(&b.pool).await.unwrap();
    assert_eq!(waiting_books.len(), 2);
    assert!(
        waiting_books
            .iter()
            .any(|book| book.book_uid == waiting_uid),
        "the target is on the waiting list"
    );

    // Another book's bytes have an alias, but it names a different uid.
    let other_path = place_file(&b, "other.epub", &other_bytes);
    let err = b
        .service
        .attach_waiting_book(&waiting_uid, &other_path, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("different book"), "got {err}");
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 2);

    // Bytes nothing has imported carry no alias at all.
    let unseen_path = place_file(&b, "unseen.epub", &unseen_bytes);
    let err = b
        .service
        .attach_waiting_book(&waiting_uid, &unseen_path, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("do not match"), "got {err}");
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn locate_file_refuses_an_ignored_waiting_book() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = fixture_epub("../tests/fixtures/books/minimal.epub");
    let a_book = add_book(&a, "ignored.epub", &bytes).await;
    seed_progress(&a, a_book, 20.0).await;
    let uid = book_uid(&a, a_book).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;

    let waiting = waiting::list(&b.pool).await.unwrap();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].book_uid, uid);
    assert!(b.service.forget_waiting_book(&uid).await.unwrap());

    let path = place_file(&b, "ignored.epub", &bytes);
    let err = b
        .service
        .attach_waiting_book(&uid, &path, &[])
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("hidden on this device"),
        "got {err}"
    );
    assert!(waiting::list(&b.pool).await.unwrap().is_empty());
    assert_eq!(b.service.status().await.unwrap().waiting_books, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn locate_file_reports_path_errors_and_keeps_the_waiting_row() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = fixture_epub("../tests/fixtures/books/minimal.epub");
    let a_book = add_book(&a, "paths.epub", &bytes).await;
    seed_progress(&a, a_book, 30.0).await;
    let uid = book_uid(&a, a_book).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 1);

    let missing = b.db_path.parent().unwrap().join("library/missing.epub");
    let err = b
        .service
        .attach_waiting_book(&uid, &missing, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no file exists"), "got {err}");

    let directory = b.db_path.parent().unwrap().join("library/folder.epub");
    std::fs::create_dir_all(&directory).unwrap();
    let err = b
        .service
        .attach_waiting_book(&uid, &directory, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no file exists"), "got {err}");

    // A file the library already owns is refused before the hash is compared.
    let present = add_book(&b, "present.epub", b"already here").await;
    let present_path = books::get_book(&b.pool, present)
        .await
        .unwrap()
        .unwrap()
        .path;
    let err = b
        .service
        .attach_waiting_book(&uid, std::path::Path::new(&present_path), &[])
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("already in the library"),
        "got {err}"
    );

    // A path that is not a book fails the parse, not the process.
    let notes = place_file(&b, "notes.txt", b"not a book at all");
    let err = b
        .service
        .attach_waiting_book(&uid, &notes, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not a readable book"), "got {err}");

    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn locate_file_parse_failure_leaves_no_reading_history_row() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    // The fixture helper accepts arbitrary bytes, so A publishes an alias for
    // content the parser will reject on B. The hash matches; the parse fails.
    let bytes = b"not an epub, but the same bytes on both machines";
    let a_book = add_book(&a, "corrupt.epub", bytes).await;
    seed_progress(&a, a_book, 25.0).await;
    let uid = book_uid(&a, a_book).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 1);

    let path = place_file(&b, "corrupt.epub", bytes);
    let err = b
        .service
        .attach_waiting_book(&uid, &path, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not a readable book"), "got {err}");

    let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&uid)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(records, 0, "the placeholder record was rolled back");
    assert!(
        books::list_reading_history(&b.pool, None)
            .await
            .unwrap()
            .is_empty(),
        "Reading history must not gain an untitled book"
    );
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn locate_file_projection_failure_retries_the_attached_book() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = fixture_epub("../tests/fixtures/books/minimal.epub");
    let a_book = add_book(&a, "projected.epub", &bytes).await;
    seed_progress(&a, a_book, 42.0).await;
    let uid = book_uid(&a, a_book).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    // Another local book keeps its own ids, so a retry that used the wrong id
    // space would project this one instead.
    let unrelated = add_book(&b, "unrelated.epub", b"unrelated book").await;
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 1);

    let path = place_file(&b, "projected.epub", &bytes);
    // The uid reaches the trigger through a bound row, not the SQL text:
    // CodeQL reads an interpolated CREATE TRIGGER as cleartext storage of
    // it. The WHEN clause keeps failing only this book's projection.
    sqlx::query("CREATE TABLE fail_projection_target (uid TEXT NOT NULL)")
        .execute(&b.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO fail_projection_target (uid) VALUES (?1)")
        .bind(&uid)
        .execute(&b.pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_projection BEFORE INSERT ON reading_progress
         WHEN NEW.book_uid = (SELECT uid FROM fail_projection_target)
         BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END",
    )
    .execute(&b.pool)
    .await
    .unwrap();
    let book = b
        .service
        .attach_waiting_book(&uid, &path, &[])
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER fail_projection")
        .execute(&b.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE fail_projection_target")
        .execute(&b.pool)
        .await
        .unwrap();

    let issues = b.service.issues().await.unwrap();
    let issue = issues
        .iter()
        .find(|issue| issue.kind == "reprojection_failed")
        .expect("a projection failure is recorded");
    assert!(
        issue.detail.contains(&uid),
        "the issue names the durable uid: {issue:?}"
    );
    assert!(b.service.retry_issue(issue.id).await.unwrap());
    assert_eq!(progress_percent(&b, book.id).await, Some(42.0));
    assert_eq!(
        progress_percent(&b, unrelated).await,
        None,
        "retry targets the attached book, not another file row"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn locate_file_rejects_a_uid_that_is_not_waiting_or_sync_is_off() {
    let sync_dir = tempfile::tempdir().unwrap();
    let b = device().await;
    let path = place_file(
        &b,
        "not-waiting.epub",
        &fixture_epub("../tests/fixtures/books/minimal.epub"),
    );

    let err = b
        .service
        .attach_waiting_book(&"e".repeat(32), &path, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not connected"), "got {err}");

    connect(&b, sync_dir.path()).await;
    let err = b
        .service
        .attach_waiting_book(&"e".repeat(32), &path, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not waiting"), "got {err}");

    b.service.disconnect().await.unwrap();
    let err = b
        .service
        .attach_waiting_book(&"e".repeat(32), &path, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("turned off"), "got {err}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn locate_file_unreadable_file_keeps_the_waiting_state() {
    use std::os::unix::fs::PermissionsExt;

    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let bytes = fixture_epub("../tests/fixtures/books/minimal.epub");
    let a_book = add_book(&a, "hash.epub", &bytes).await;
    seed_progress(&a, a_book, 40.0).await;
    let uid = book_uid(&a, a_book).await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    run(&b).await;
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 1);

    let path = place_file(&b, "hash.epub", &bytes);
    let original = std::fs::metadata(&path).unwrap().permissions();
    let mut locked = original.clone();
    locked.set_mode(0o000);
    std::fs::set_permissions(&path, locked).unwrap();
    if std::fs::read(&path).is_ok() {
        // Running with enough privilege to read anyway (root): the failure
        // path cannot be provoked here.
        std::fs::set_permissions(&path, original).unwrap();
        return;
    }

    let err = b
        .service
        .attach_waiting_book(&uid, &path, &[])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("Permission denied"), "got {err}");
    assert_eq!(waiting::list(&b.pool).await.unwrap().len(), 1);
    assert_eq!(b.service.status().await.unwrap().waiting_books, 1);
    let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(&uid)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(records, 0, "the failed attempt left no phantom record");

    // The row is still attachable once the file can be read.
    std::fs::set_permissions(&path, original).unwrap();
    b.service
        .attach_waiting_book(&uid, &path, &[])
        .await
        .unwrap();
    assert!(waiting::list(&b.pool).await.unwrap().is_empty());
}
