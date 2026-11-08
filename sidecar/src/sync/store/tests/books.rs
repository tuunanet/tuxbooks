//! Book blob round-trip and name-validation tests (ADR 0018 D2).

use std::fs;

use sha2::{Digest, Sha256};

use super::*;

const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn book_blob_names_reject_traversal_and_bad_grammar() {
    assert!(book_blob_name(&format!("{HASH}.epub")).is_some());
    assert!(book_blob_name(&format!("{HASH}.pdf")).is_some());
    // Traversal and path-like names never match.
    assert!(book_blob_name("../../etc/passwd").is_none());
    assert!(book_blob_name("../../etc/passwd.epub").is_none());
    assert!(book_blob_name("/x/books/0123456789abcdef.epub").is_none());
    // Covers are shorter hashes and a different extension set.
    assert!(book_blob_name("0123456789abcdef.png").is_none());
    // Not the full 64-hex SHA-256.
    assert!(book_blob_name("0123456789abcdef.epub").is_none());
    assert!(book_blob_name(&format!("{}.epub", &HASH[..63])).is_none());
    // Extensions the import path does not accept.
    assert!(book_blob_name(&format!("{HASH}.zip")).is_none());
    assert!(book_blob_name(&format!("{HASH}.epub.bak")).is_none());
    assert!(book_blob_name(HASH).is_none());
    assert!(book_blob_name("").is_none());
}

#[test]
fn book_blob_staging_round_trips_and_verifies_content() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    let source = tmp.path().join("book.epub");
    let bytes = b"book-bytes";
    fs::write(&source, bytes).unwrap();
    let hash = format!("{:x}", Sha256::digest(bytes));

    let stage = stage_book_blob(&root, &source, &hash).unwrap();
    assert_eq!(stage, BookBlobStage::Stored);
    let destination = root.join(BOOK_BLOB_DIR).join(format!("{hash}.epub"));
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    assert!(book_blob_exists(&root, &format!("{hash}.epub")));
    assert!(!book_blob_exists(&root, "../../etc/passwd"));

    // An already stored blob is left alone.
    let stage = stage_book_blob(&root, &source, &hash).unwrap();
    assert_eq!(stage, BookBlobStage::Stored);
    assert_eq!(fs::read(&destination).unwrap(), bytes);

    // A name whose content does not match its hash is refused, not staged.
    let err = stage_book_blob(&root, &source, &"f".repeat(64)).unwrap_err();
    assert!(err.to_string().contains("changed between"), "{err}");
    assert!(!book_blob_exists(
        &root,
        &format!("{}.epub", "f".repeat(64))
    ));
}

#[test]
fn book_blob_staging_rejects_an_oversize_file_without_reading_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    let source = tmp.path().join("big.epub");
    // A sparse file: the stat sees the cap breach, the bytes are never read.
    let file = fs::File::create(&source).unwrap();
    file.set_len(MAX_BOOK_BLOB_BYTES + 1).unwrap();
    drop(file);

    let stage = stage_book_blob(&root, &source, HASH).unwrap();
    assert_eq!(stage, BookBlobStage::Oversize);
    let blobs = root.join(BOOK_BLOB_DIR);
    assert!(!blobs.exists() || fs::read_dir(&blobs).unwrap().next().is_none());
}

#[test]
fn book_blob_staging_requires_a_hash_and_a_book_extension() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    let source = tmp.path().join("book.txt");
    fs::write(&source, b"not-a-book").unwrap();
    let hash = format!("{:x}", Sha256::digest(b"not-a-book"));

    let err = stage_book_blob(&root, &source, &hash).unwrap_err();
    assert!(err.to_string().contains("invalid book blob name"), "{err}");
    // A malformed hash cannot name a blob either.
    let err = stage_book_blob(&root, &source, "short").unwrap_err();
    assert!(err.to_string().contains("invalid book blob name"), "{err}");
}
