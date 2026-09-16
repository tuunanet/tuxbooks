//! The sidecar's parse surface routes through the worker (W-1, P-1). These
//! tests drive the real client against the real worker binary through the
//! service layer, on tempdirs, like the rest of the integration tier.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use tuxbooks_lib::services::library_scanner;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

/// Serializes the one test that mutates process env (TUXBOOKS_WORKER).
fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| Mutex::new(()));
    lock.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[test]
fn parse_book_routes_epub_through_the_worker() {
    let scanned = library_scanner::parse_book(&fixture("minimal.epub")).unwrap();
    assert!(matches!(scanned, library_scanner::ScannedBook::Epub(_)));
}

#[test]
fn parse_book_routes_pdf_through_the_worker() {
    let scanned = library_scanner::parse_book(&fixture("minimal.pdf")).unwrap();
    assert!(matches!(scanned, library_scanner::ScannedBook::Pdf(_)));
}

#[test]
fn parse_book_fails_typed_when_the_worker_binary_is_missing() {
    // Fail-closed contract (ADR 0001 D5): no worker, no parse, no fallback.
    let _guard = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("minimal.epub");
    std::fs::write(&path, std::fs::read(fixture("minimal.epub")).unwrap()).unwrap();
    std::env::set_var("TUXBOOKS_WORKER", dir.path().join("absent-worker"));
    let result = library_scanner::parse_book(&path);
    std::env::remove_var("TUXBOOKS_WORKER");
    match result {
        Err(err) => assert!(
            err.to_string().contains("document worker"),
            "expected the typed unavailable error, got: {err}"
        ),
        Ok(scanned) => panic!("parse must fail closed without a worker, got: {scanned:?}"),
    }
}
