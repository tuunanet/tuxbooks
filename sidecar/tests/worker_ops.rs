//! End-to-end ops against the real worker binary (W-1, P-1): the sidecar
//! client spawns it, hands off the fixture, and gets typed results.

use std::path::PathBuf;

use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};

fn client() -> WorkerClient {
    WorkerClient::locate().expect("worker binary built by cargo test")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

#[test]
fn epub_parse_returns_the_fixture_book() {
    let book = client()
        .epub_parse(&fixture("minimal.epub"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!book.metadata.title.is_empty());
    assert!(!book.spine.is_empty());
}

#[test]
fn epub_session_returns_manifest_and_positions() {
    let session = client()
        .epub_session(&fixture("minimal.epub"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!session.manifest_json.is_empty());
    assert!(!session.positions_json.is_empty());
}

#[test]
fn epub_member_serves_a_member_and_misses_cleanly() {
    let hit = client()
        .epub_member(
            &fixture("minimal.epub"),
            "META-INF/container.xml",
            &ResourceLimits::DEFAULTS,
        )
        .unwrap();
    assert!(hit.unwrap().starts_with(b"<"));
    let miss = client()
        .epub_member(
            &fixture("minimal.epub"),
            "no/such/file.xml",
            &ResourceLimits::DEFAULTS,
        )
        .unwrap();
    assert!(miss.is_none());
}

#[test]
fn epub_parse_rejects_hostile_documents_with_typed_parse_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.epub");
    std::fs::write(&path, b"definitely not a zip archive").unwrap();
    let err = client()
        .epub_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
}

#[test]
fn epub_parse_enforces_the_job_quota_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("small.epub");
    std::fs::write(&path, vec![0u8; 200]).unwrap();
    let tight = ResourceLimits {
        max_source_file_bytes: 100,
        ..ResourceLimits::DEFAULTS
    };
    let err = client().epub_parse(&path, &tight).unwrap_err();
    assert!(matches!(err, WorkerError::Limit(_)), "got: {err:?}");
}

#[test]
fn pdf_parse_and_properties_return_the_fixture_metadata() {
    let book = client()
        .pdf_parse(&fixture("minimal.pdf"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!book.metadata.title.is_empty());
    let props = client()
        .pdf_properties(&fixture("minimal.pdf"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!props.is_empty());
}

#[test]
fn pdf_parse_rejects_garbage_as_a_typed_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.pdf");
    std::fs::write(&path, b"not a pdf").unwrap();
    let err = client()
        .pdf_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
}

#[test]
fn pdf_cover_renders_when_pdfium_is_available() {
    let dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium")];
    if !tuxbooks_lib::pdf::render::pdfium_is_available(&dirs) {
        eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)");
        return;
    }
    let cover = client()
        .pdf_cover(&fixture("minimal.pdf"), &dirs, &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(cover.is_some(), "minimal.pdf should render a cover");
}
