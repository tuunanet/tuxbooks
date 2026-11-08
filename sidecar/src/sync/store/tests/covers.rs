//! Cover blob round-trip and name-validation tests.

use std::fs;

use super::*;

#[test]
fn cover_names_reject_traversal() {
    assert!(cover_file_name("/x/covers/0123456789abcdef.png").is_some());
    assert!(cover_file_name("../../etc/passwd").is_none());
    assert!(cover_file_name("/x/covers/not-a-cover.png").is_none());
}

#[test]
fn cover_blob_storage_round_trips_and_rejects_bad_input() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    let covers = tmp.path().join("covers");
    let name = "0123456789abcdef.png";

    assert!(store_cover_blob(&root, &covers, "../../etc/passwd").is_err());
    store_cover_blob(&root, &covers, name).unwrap();
    assert!(!root.join(COVER_BLOB_DIR).join(name).exists());

    fs::create_dir_all(&covers).unwrap();
    fs::write(covers.join(name), b"cover-bytes").unwrap();
    store_cover_blob(&root, &covers, name).unwrap();
    assert_eq!(
        fs::read(root.join(COVER_BLOB_DIR).join(name)).unwrap(),
        b"cover-bytes"
    );
    // An already stored blob is left alone.
    store_cover_blob(&root, &covers, name).unwrap();

    let oversized = "fedcba9876543210.png";
    let file = fs::File::create(covers.join(oversized)).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    let err = store_cover_blob(&root, &covers, oversized).unwrap_err();
    assert!(err.to_string().contains("16 MiB"), "{err}");
}

#[test]
fn apply_cover_blob_handles_existing_missing_and_oversized_blobs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    let covers = tmp.path().join("covers");
    let name = "0123456789abcdef.png";

    assert!(!apply_cover_blob(&root, &covers, "../../etc/passwd").unwrap());
    assert!(!apply_cover_blob(&root, &covers, name).unwrap());

    let blob_dir = root.join(COVER_BLOB_DIR);
    fs::create_dir_all(&blob_dir).unwrap();
    fs::write(blob_dir.join(name), b"blob").unwrap();
    assert!(apply_cover_blob(&root, &covers, name).unwrap());
    assert_eq!(fs::read(covers.join(name)).unwrap(), b"blob");
    // An already cached cover is not copied again.
    assert!(apply_cover_blob(&root, &covers, name).unwrap());

    let oversized = "fedcba9876543210.png";
    let file = fs::File::create(blob_dir.join(oversized)).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    let err = apply_cover_blob(&root, &covers, oversized).unwrap_err();
    assert!(err.to_string().contains("16 MiB"), "{err}");
}
