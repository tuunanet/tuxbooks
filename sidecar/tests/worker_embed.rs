//! Embed round trip through the real worker: bytes in, rewritten bytes out.
//! The sidecar-side write (backup + atomic replace) is exercised by the
//! existing metadata service tests once Task 7 flips the callers.

use std::path::PathBuf;

use tuxbooks_lib::epub::EpubMetadata;
use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};

fn client() -> WorkerClient {
    WorkerClient::locate().expect("worker binary built by cargo test")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

fn metadata(title: &str) -> EpubMetadata {
    EpubMetadata {
        title: title.to_string(),
        subtitle: None,
        author: Some("A. Author".to_string()),
        authors: vec!["A. Author".to_string()],
        subjects: Vec::new(),
        language: Some("en".to_string()),
        publisher: None,
        isbn: None,
        description: None,
        publication_date: None,
        series: None,
        series_index: None,
    }
}

#[test]
fn epub_embed_returns_a_valid_epub_with_new_metadata() {
    let rewritten = client()
        .epub_embed(
            &fixture("minimal.epub"),
            &metadata("Rewritten Title"),
            &ResourceLimits::DEFAULTS,
        )
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rewritten.epub");
    std::fs::write(&path, &rewritten).unwrap();
    let book = tuxbooks_lib::epub::parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
    assert_eq!(book.metadata.title, "Rewritten Title");
    assert!(book.metadata.authors.contains(&"A. Author".to_string()));
    // The rewrite preserves the document's spine, not just its metadata.
    assert!(!book.spine.is_empty());
}

#[test]
fn embed_rejects_a_hostile_document_instead_of_rewriting_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.epub");
    std::fs::write(&path, b"definitely not a zip archive").unwrap();
    let err = client()
        .epub_embed(&path, &metadata("x"), &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
}

#[test]
fn embed_sources_over_the_cap_are_refused_without_reading() {
    // I2: source + rewrite + base64 must fit the address-space rlimit
    // together, so oversized embeds are refused up front with a typed
    // limit error naming the cap.
    let (limit, _) =
        tuxbooks_lib::worker::embed_source_error(513 << 20).expect("513 MiB exceeds the embed cap");
    assert_eq!(limit, "max_embed_source_bytes");
    assert!(tuxbooks_lib::worker::embed_source_error(511 << 20).is_none());
}
