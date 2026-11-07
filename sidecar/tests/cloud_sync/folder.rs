use crate::common::*;
use crate::support::*;

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_and_corrupt_operation_files_are_tolerated() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"duplicate ops").await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let root = sync_dir.path().join("TuxBooks");
    let op_dir = root.join("ops");
    let mut op_files = Vec::new();
    for entry in std::fs::read_dir(&op_dir).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            for file in std::fs::read_dir(entry.path()).unwrap() {
                op_files.push(file.unwrap().path());
            }
        }
    }
    assert!(!op_files.is_empty());
    let first = op_files[0].clone();
    std::fs::copy(&first, first.with_file_name("conflict copy.json")).unwrap();
    let corrupt_dir = op_dir.join("b".repeat(32));
    std::fs::create_dir_all(&corrupt_dir).unwrap();
    std::fs::write(corrupt_dir.join("broken.json"), b"{not json").unwrap();
    std::fs::write(corrupt_dir.join("oversized.json"), vec![b' '; 1_100_000]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&first, corrupt_dir.join("linked.json")).unwrap();

    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"duplicate ops").await;
    run(&b).await;
    run(&b).await;

    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1,
        "a conflict copy must not duplicate the annotation"
    );
    let issues = b.service.issues().await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.file_name.is_some()),
        "the corrupt file must surface as an issue"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_that_is_not_a_directory_is_rejected() {
    let a = device().await;
    let file = tempfile::NamedTempFile::new().unwrap();
    let err = a
        .service
        .connect(file.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn operations_are_ordered_by_clock_not_by_file_name() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let a_book = add_book(&a, "same.epub", b"out of order").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    let book_uid: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_bindings WHERE book_id = ?1")
            .bind(file_row_id(&a, "same.epub").await)
            .fetch_one(&a.pool)
            .await
            .unwrap();

    let manual_device = "c".repeat(32);
    let manual_dir = sync_dir
        .path()
        .join("TuxBooks")
        .join("ops")
        .join(&manual_device);
    std::fs::create_dir_all(&manual_dir).unwrap();
    let entity_uid = "a".repeat(32);
    let make = |op_id: &str, wall: i64, note: &str| Op {
        schema: OP_SCHEMA,
        op_id: op_id.to_string(),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::Annotation,
        entity_uid: entity_uid.clone(),
        book_uid: Some(book_uid.clone()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({
            "kind": "bookmark",
            "cfi": "epubcfi(/6/4)",
            "note": note,
        })
        .as_object()
        .cloned()
        .unwrap(),
        prior: None,
        created_at: "2026-10-28T00:00:00.000Z".into(),
    };
    // The newer clock deliberately sorts first: the merge, not the directory
    // listing, must decide the winner.
    std::fs::write(
        manual_dir.join("00000000000000000001.json"),
        serde_json::to_vec(&make("1".repeat(32).as_str(), 200, "newer")).unwrap(),
    )
    .unwrap();
    std::fs::write(
        manual_dir.join("99999999999999999999.json"),
        serde_json::to_vec(&make("2".repeat(32).as_str(), 100, "older")).unwrap(),
    )
    .unwrap();

    run(&a).await;
    run(&a).await;
    let listed = annotations::list_annotations(&a.pool, a_book)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].note.as_deref(), Some("newer"));
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert!(conflicts >= 1, "the older value is preserved");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disappearing_folder_becomes_a_sync_issue() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;

    drop(sync_dir);
    let err = a.service.run_pass().await.unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
    let issues = a.service.issues().await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "sync_failed"),
        "a folder failure must surface in Sync issues: {issues:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_one_copy_keeps_the_book_and_its_state() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let first = add_book(&a, "copy-one.epub", b"duplicate content").await;
    let second = add_book(&a, "copy-two.epub", b"duplicate content").await;
    add_bookmark(&a, first, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "one").await;

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    run(&a).await;

    assert_eq!(first, second, "duplicate bytes share one durable book");
    assert_eq!(annotation_count(&a, first).await, 1);
    let issues = a.service.issues().await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "duplicate_book"),
        "the duplicate copy is named in Sync issues: {issues:?}"
    );

    // Removing one location ends that copy's membership only.
    let first_file = file_row_id(&a, "copy-one.epub").await;
    books::delete_file_row(&a.pool, first_file).await.unwrap();
    run(&a).await;
    run(&a).await;

    assert_eq!(
        annotation_count(&a, second).await,
        1,
        "the remaining copy keeps the shared state"
    );
    assert_eq!(
        book_id(&a, "copy-two.epub").await,
        second,
        "the surviving copy is still in the library"
    );
    assert!(
        !open_issue_kinds(&a)
            .await
            .iter()
            .any(|kind| kind == "duplicate_book"),
        "the duplicate issue closes once one binding remains"
    );
}
