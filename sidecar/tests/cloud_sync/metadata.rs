use crate::common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn metadata_override_authors_and_cover_travel_together() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let _a_book = add_book(&a, "same.epub", b"metadata book").await;

    let covers = a.db_path.parent().unwrap().join("covers");
    std::fs::create_dir_all(&covers).unwrap();
    let cover_name = "0123456789abcdef.png";
    let cover_bytes = b"\x89PNG\r\n\x1a\nnot-a-real-png-but-bytes";
    std::fs::write(covers.join(cover_name), cover_bytes).unwrap();

    let overrides = metadata_repo::OverrideRow {
        title: Some("Curated title".into()),
        authors_customized: true,
        subjects_customized: true,
        cover_path: Some(covers.join(cover_name).to_string_lossy().into_owned()),
        ..metadata_repo::OverrideRow::default()
    };
    metadata::apply_synced_overrides(
        &a.pool,
        book_id(&a, "same.epub").await,
        &overrides,
        &["Alice".into(), "Bob".into()],
        &["Essays".into()],
    )
    .await
    .unwrap();

    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"metadata book").await;
    run(&b).await;
    run(&b).await;

    let b_book = book_id(&b, "same.epub").await;
    let book = books::get_book(&b.pool, b_book).await.unwrap().unwrap();
    assert_eq!(book.title, "Curated title");
    assert_eq!(book.author.as_deref(), Some("Alice, Bob"));
    let book_uid = book.book_uid.clone().expect("book uid");
    let authors = metadata_repo::list_book_authors(&b.pool, &book_uid)
        .await
        .unwrap();
    assert_eq!(authors, vec!["Alice".to_string(), "Bob".to_string()]);
    let cover_path = book.cover_path.expect("cover override projected");
    assert!(
        Path::new(&cover_path).exists(),
        "cover blob must be copied into B's cache"
    );
    assert_eq!(std::fs::read(&cover_path).unwrap(), cover_bytes);
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_with_a_missing_or_oversized_cover_still_applies() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let root = sync_dir.path().join("TuxBooks");
    let device = "f".repeat(32);
    let book_uid = "a".repeat(32);
    let missing_cover = "0123456789abcdef.png";

    let missing = Op {
        schema: OP_SCHEMA,
        op_id: "1".repeat(32),
        device_id: device.clone(),
        hlc: Hlc {
            wall: 10,
            counter: 0,
            device: device.clone(),
        },
        kind: EntityKind::Metadata,
        entity_uid: book_uid.clone(),
        book_uid: Some(book_uid.clone()),
        deleted: false,
        restore: false,
        fields: json!({
            "title": "Missing cover",
            "cover_path": missing_cover,
        })
        .as_object()
        .cloned()
        .unwrap(),
        prior: None,
        created_at: "2026-10-29T00:00:00.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &device,
        "00000000000000000001.json",
        &missing,
    );
    run(&a).await;
    let issues = a.service.issues().await.unwrap();
    let cover_issue = issues
        .iter()
        .find(|issue| issue.kind == "cover_missing")
        .expect("a missing cover is reported");
    assert!(
        cover_issue.detail.contains("not in the sync folder yet"),
        "{}",
        cover_issue.detail
    );

    let oversized_cover = "fedcba9876543210.png";
    let blob_dir = root.join("blobs/covers");
    std::fs::create_dir_all(&blob_dir).unwrap();
    let oversized = std::fs::File::create(blob_dir.join(oversized_cover)).unwrap();
    oversized.set_len(16 * 1024 * 1024 + 1).unwrap();
    let oversized_op = Op {
        schema: OP_SCHEMA,
        op_id: "2".repeat(32),
        device_id: device.clone(),
        hlc: Hlc {
            wall: 11,
            counter: 0,
            device: device.clone(),
        },
        kind: EntityKind::Metadata,
        entity_uid: book_uid.clone(),
        book_uid: Some(book_uid),
        deleted: false,
        restore: false,
        fields: json!({
            "title": "Oversized cover",
            "cover_path": oversized_cover,
        })
        .as_object()
        .cloned()
        .unwrap(),
        prior: None,
        created_at: "2026-10-29T00:00:01.000Z".into(),
    };
    write_manual_op(
        sync_dir.path(),
        &device,
        "00000000000000000002.json",
        &oversized_op,
    );
    run(&a).await;
    let issues = a.service.issues().await.unwrap();
    let oversized_issue = issues
        .iter()
        .find(|issue| issue.detail.contains("could not read cover"))
        .expect("an unreadable cover is reported");
    assert_eq!(oversized_issue.kind, "cover_missing");
}
