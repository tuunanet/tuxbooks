//! E-1 regression: scripted EPUBs open with scripting disabled.
//!
//! Project Gutenberg EPUB 3s stamp the EPUB 3 spec's own example nav
//! script into `nav.xhtml` (declared `properties="nav scripted"`), and the
//! EPUB 3 spec requires reading systems to render such books as if
//! scripting were off instead of refusing them. The engine seam
//! (`lib/epub/contentPolicy.ts`) strips scripts before parse and the frame
//! CSP blocks execution, so the sidecar must open the book.
//!
//! The fixture is part of the free ebook corpus (`tests/fixtures/books/
//! EBooks/`, files gitignored — see docs/TESTING.md), so this test skips
//! with a notice when the corpus is absent; the synthetic scripted-book
//! shapes stay pinned in `epub/session.rs` tests. `REALISTIC_LIBRARY_PATH`
//! overrides the corpus location, like the other corpus consumers.

use std::path::PathBuf;

use tuxbooks_lib::epub::build_session;
use tuxbooks_lib::limits::ResourceLimits;

fn corpus_book() -> Option<PathBuf> {
    let from_env = std::env::var("REALISTIC_LIBRARY_PATH")
        .ok()
        .filter(|value| !value.is_empty());
    let path = from_env.map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/EBooks")
    });
    let book = path.join("EPUB Samples/childrens-literature.epub");
    book.is_file().then_some(book)
}

#[test]
fn gutenberg_nav_script_book_opens() {
    let Some(path) = corpus_book() else {
        eprintln!(
            "skipping gutenberg-nav-script test: corpus absent — fetch it with \
             `just fetch-ebooks` (the session.rs unit tests pin this shape \
             without the corpus)"
        );
        return;
    };
    let session = build_session(&path, &ResourceLimits::DEFAULTS).unwrap();
    assert!(
        session.manifest_json.contains("nav.xhtml"),
        "session manifest must list the scripted nav document"
    );
}
