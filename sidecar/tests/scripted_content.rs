//! E-1 regression: scripted EPUBs open with scripting disabled.
//!
//! Project Gutenberg EPUB 3s stamp the EPUB 3 spec's own example nav
//! script into `nav.xhtml` (declared `properties="nav scripted"`), and the
//! EPUB 3 spec requires reading systems to render such books as if
//! scripting were off instead of refusing them. The engine seam
//! (`lib/epub/contentPolicy.ts`) strips scripts before parse and the frame
//! CSP blocks execution, so the sidecar must open the book.

use tuxbooks_lib::epub::build_session;
use tuxbooks_lib::limits::ResourceLimits;

#[test]
fn gutenberg_nav_script_book_opens() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/books/EBooks/EPUB Samples/childrens-literature.epub")
        .canonicalize()
        .unwrap();
    let session = build_session(&path, &ResourceLimits::DEFAULTS).unwrap();
    assert!(
        session.manifest_json.contains("nav.xhtml"),
        "session manifest must list the scripted nav document"
    );
}
