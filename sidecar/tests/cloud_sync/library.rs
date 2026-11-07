use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn a_rewritten_file_keeps_its_book_identity() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    let a_book = add_book(&a, "same.epub", b"version one").await;
    add_bookmark(&a, a_book, "epubcfi(/6/4!/4/2,/1:0,/1:8)", "keep").await;
    connect(&a, sync_dir.path()).await;
    run(&a).await;
    connect(&b, sync_dir.path()).await;
    let _b_book = add_book(&b, "same.epub", b"version one").await;
    run(&b).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1
    );

    // Simulate a metadata embed on A: same row, new bytes.
    let a_book = book_id(&a, "same.epub").await;
    update_book_bytes(&a, a_book, b"version two with new metadata").await;
    run(&a).await;
    run(&a).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&a, book_id(&a, "same.epub").await).await,
        1,
        "the rewriting device keeps its book"
    );
    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1,
        "the other device keeps the annotation under the old alias"
    );

    // B's cloud client eventually delivers the rewritten bytes.
    let b_book = book_id(&b, "same.epub").await;
    update_book_bytes(&b, b_book, b"version two with new metadata").await;
    run(&b).await;
    run(&b).await;
    assert_eq!(
        annotation_count(&b, book_id(&b, "same.epub").await).await,
        1,
        "the new hash alias resolves to the same book"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_library_mismatch_requires_confirmation_then_merges() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    let b = device().await;
    connect(&a, sync_dir.path()).await;
    let remote_id = a.service.status().await.unwrap().library_id.unwrap();
    clock::set_meta(
        &b.pool,
        clock::META_LIBRARY_ID,
        "0123456789abcdef0123456789abcdef",
    )
    .await
    .unwrap();

    let result = b
        .service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();
    let mismatch = result.mismatch.expect("mismatch surfaced");
    assert_eq!(mismatch.remote_library_id, remote_id);

    let confirmed = b
        .service
        .connect(
            sync_dir.path().to_str().unwrap(),
            None,
            Some(remote_id.clone()),
            false,
        )
        .await
        .unwrap();
    assert!(confirmed.mismatch.is_none());
    assert_eq!(
        confirmed.status.library_id.as_deref(),
        Some(remote_id.as_str())
    );
    assert!(confirmed.status.enabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_folder_is_adopted_without_a_mismatch() {
    let sync_dir = tempfile::tempdir().unwrap();
    let b = device().await;
    let old_id = "0123456789abcdef0123456789abcdef";
    clock::set_meta(&b.pool, clock::META_LIBRARY_ID, old_id)
        .await
        .unwrap();

    let result = b
        .service
        .connect(sync_dir.path().to_str().unwrap(), None, None, false)
        .await
        .unwrap();

    assert!(
        result.mismatch.is_none(),
        "a freshly created library must be adopted, not treated as another one"
    );
    let library_id = result.status.library_id.clone().expect("library id");
    assert_ne!(library_id, old_id);
    assert!(result.status.enabled);
    let library: Value = serde_json::from_str(
        &std::fs::read_to_string(sync_dir.path().join("TuxBooks/library.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(library["library_id"], library_id);
}

#[tokio::test(flavor = "multi_thread")]
async fn starting_a_new_library_archives_the_existing_one() {
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let old_id = a.service.status().await.unwrap().library_id.unwrap();

    let b = device().await;
    clock::set_meta(&b.pool, clock::META_LIBRARY_ID, &old_id)
        .await
        .unwrap();

    let result = b
        .service
        .connect(sync_dir.path().to_str().unwrap(), None, None, true)
        .await
        .unwrap();

    assert!(result.mismatch.is_none());
    let new_id = result.status.library_id.clone().expect("new library id");
    assert_ne!(new_id, old_id);
    let archived = result
        .archived_library_path
        .expect("the old library path is reported");
    let archived_library: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(&archived).join("library.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(archived_library["library_id"], old_id);
    assert!(sync_dir.path().join("TuxBooks/library.json").exists());
    let current: Value = serde_json::from_str(
        &std::fs::read_to_string(sync_dir.path().join("TuxBooks/library.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(current["library_id"], new_id);
}
