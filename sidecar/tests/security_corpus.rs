//! Security corpus (issue #87): hostile EPUB/PDF fixtures and boundary
//! tests, grouped by invariant ID.
//!
//! Corpus layout: builders live in `tests/fixtures/security/` (generated at
//! runtime, never committed as binaries — see the README there) and every
//! test below names the invariant it proves. Coverage that already exists
//! in the tasks that landed each enforcement is indexed in
//! `docs/TESTING.md` and the TS-side corpus index
//! (`frontend/tests/security/corpus/`); this file carries what was missing:
//! the compressed-member parse-path fixture (deferred from #83), the
//! malformed-archive and entity-abuse fixtures, the hostile-PDF shapes, and
//! the worker boundary tests (#87 requirement after #81).

#[path = "fixtures/security/hostile_epub.rs"]
mod hostile_epub;
#[path = "fixtures/security/hostile_pdf.rs"]
mod hostile_pdf;

use std::path::PathBuf;

use tuxbooks_lib::epub::{parse_epub, read_member, EpubError};
use tuxbooks_lib::limits::{LimitExceeded, ResourceLimits};
use tuxbooks_lib::pdf::{parse_pdf, PdfError};
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

// ---------------------------------------------------------------------------
// R-1: EPUB quotas
// ---------------------------------------------------------------------------

#[test]
fn compressed_member_over_the_cap_fails_the_parse_path() {
    // Deferred from #83 (Task 1 minor): no test tripped
    // max_compressed_member_bytes on a real parse path. The cover member is
    // incompressible noise, so its compressed size alone trips the cap.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("incompressible.epub");
    hostile_epub::incompressible_cover(&path);
    let tight = ResourceLimits {
        max_compressed_member_bytes: 1024,
        ..ResourceLimits::DEFAULTS
    };
    match parse_epub(&path, &tight).unwrap_err() {
        EpubError::Limit(LimitExceeded { limit, .. }) => {
            assert_eq!(limit, "max_compressed_member_bytes");
        }
        other => panic!("expected compressed-member limit error, got: {other:?}"),
    }
}

#[test]
fn deeply_nested_member_paths_stay_bounded() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("deep.epub");
    hostile_epub::deep_paths(&path);

    let book = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
    assert!(!book.spine.is_empty());

    let deep = hostile_epub::deep_member_name();
    let leaf = read_member(&path, &deep, &ResourceLimits::DEFAULTS)
        .unwrap()
        .expect("the 200-dir-deep member must still resolve inside the archive");
    assert!(!leaf.is_empty());

    let long = format!("d/{}", "x".repeat(4096));
    assert!(
        read_member(&path, &long, &ResourceLimits::DEFAULTS)
            .unwrap()
            .is_none(),
        "an over-long member name must miss, never escape or crash"
    );
}

#[test]
fn malformed_zip_shapes_fail_typed() {
    let tmp = tempfile::tempdir().unwrap();
    let truncated = tmp.path().join("truncated.epub");
    hostile_epub::truncated(&truncated);
    let corrupt = tmp.path().join("corrupt.epub");
    hostile_epub::corrupt_central_directory(&corrupt);
    let garbage = tmp.path().join("garbage.epub");
    std::fs::write(&garbage, b"definitely not a zip archive").unwrap();

    for path in [&truncated, &corrupt, &garbage] {
        match parse_epub(path, &ResourceLimits::DEFAULTS).unwrap_err() {
            EpubError::Zip(_) | EpubError::MissingMimetype => {}
            other => panic!(
                "{}: expected a typed zip failure, got: {other:?}",
                path.display()
            ),
        }
    }
}

#[test]
fn entity_expansion_opf_is_inert_and_bounded() {
    // Billion-laughs style OPF: the XML reader must not expand the entity
    // chain — the outcome is a typed failure (the hostile title never
    // materializes) or an inert literal, never exponential expansion.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("entity.epub");
    hostile_epub::entity_bomb(&path);
    match parse_epub(&path, &ResourceLimits::DEFAULTS) {
        Ok(book) => assert!(
            !book.metadata.title.contains('&'),
            "entity references must not expand into the title, got: {:?}",
            book.metadata.title
        ),
        Err(EpubError::MissingTitle) => {}
        Err(other) => panic!("expected inert parse or MissingTitle, got: {other:?}"),
    }
}

#[test]
fn malformed_fonts_and_covers_travel_inert() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("inert.epub");
    let (cover, font) = hostile_epub::malformed_cover_and_font(&path);

    let book = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
    assert_eq!(
        book.cover.expect("garbage cover is still extracted").data,
        cover
    );
    assert_eq!(
        read_member(&path, "evil.woff", &ResourceLimits::DEFAULTS)
            .unwrap()
            .expect("garbage font is still served"),
        font
    );
}

// ---------------------------------------------------------------------------
// R-2 / P-1: PDF quotas and worker-boundary parsing
// ---------------------------------------------------------------------------

#[test]
fn malformed_pdf_xref_shapes_fail_typed() {
    let tmp = tempfile::tempdir().unwrap();
    let bad_startxref = tmp.path().join("badstart.pdf");
    std::fs::write(&bad_startxref, hostile_pdf::bad_startxref()).unwrap();
    let truncated = tmp.path().join("truncated.pdf");
    let bytes = hostile_pdf::benign();
    std::fs::write(&truncated, &bytes[..bytes.len() * 3 / 5]).unwrap();
    let garbage = tmp.path().join("garbage.pdf");
    std::fs::write(&garbage, b"not a pdf at all").unwrap();

    for path in [&bad_startxref, &truncated, &garbage] {
        let err = parse_pdf(path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(
            matches!(err, PdfError::Parse(_) | PdfError::Io(_)),
            "{}: expected a typed parse failure, got: {err:?}",
            path.display()
        );
    }
}

#[test]
fn pdf_decompression_bomb_is_contained_by_the_worker() {
    // Trip-level for this class: lopdf answers the ~19 MB to 4095 MiB
    // xref-stream inflation with the typed limit from the limits table
    // (wired as `max_decompressed_size`), well inside the deadline, and the
    // sidecar keeps serving afterwards. The worker's RLIMIT_AS stays the
    // containment backstop for inflation lopdf does not bound (content
    // streams decoded by PDFium, for example); #88 fuzzing still hunts
    // those residual classes, per docs/TESTING.md.
    let client = WorkerClient::locate().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("bomb.pdf");
    std::fs::write(&path, hostile_pdf::inflation_bomb()).unwrap();

    let started = std::time::Instant::now();
    let err = client
        .pdf_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(
        matches!(
            err,
            WorkerError::Parse(_)
                | WorkerError::Limit(_)
                | WorkerError::Crash(_)
                | WorkerError::Deadline
        ),
        "the bomb must be answered by a typed worker outcome, got: {err:?}"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(60),
        "containment must be prompt, took {:?}",
        started.elapsed()
    );
    // The sidecar survived: a benign parse still goes through.
    let good = client
        .pdf_parse(&fixture("minimal.pdf"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!good.metadata.title.is_empty());
}

#[test]
fn stream_inflation_over_the_decompression_cap_fails_typed() {
    // R-1/R-2 trip-level bomb coverage: a 64 MiB xref-stream inflation
    // against a 1 MiB cap must fail as the typed limit error from the
    // limits table, not as a structural parse error and not only through
    // worker containment.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("bomb-small.pdf");
    std::fs::write(&path, hostile_pdf::inflation_bomb_at(64)).unwrap();
    let tight = ResourceLimits {
        max_stream_decompressed_bytes: 1 << 20,
        ..ResourceLimits::DEFAULTS
    };
    match parse_pdf(&path, &tight).unwrap_err() {
        PdfError::Limit(err) => assert_eq!(err.limit, "max_stream_decompressed_bytes"),
        other => panic!("expected the lopdf decompression cap to trip typed, got: {other:?}"),
    }
}

#[test]
fn cyclic_page_tree_walk_is_bounded() {
    // A Pages node whose Kids array references itself: the node budget must
    // trip instead of looping forever.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("cyclic.pdf");
    std::fs::write(&path, hostile_pdf::cyclic_page_tree()).unwrap();
    let tight = ResourceLimits {
        max_page_tree_nodes: 16,
        ..ResourceLimits::DEFAULTS
    };
    match parse_pdf(&path, &tight).unwrap_err() {
        PdfError::Limit(err) => assert_eq!(err.limit, "max_page_tree_nodes"),
        other => panic!("expected node-budget limit error, got: {other:?}"),
    }
}

#[test]
fn hostile_huge_page_cover_render_stays_bounded() {
    let dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium")];
    if !tuxbooks_lib::pdf::render::pdfium_is_available(&dirs) {
        eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("hugepage.pdf");
    std::fs::write(&path, hostile_pdf::huge_page()).unwrap();

    let client = WorkerClient::locate().unwrap();
    match client.pdf_cover(&path, &dirs, &ResourceLimits::DEFAULTS) {
        Ok(Some(png)) => assert!(
            png.len() <= ResourceLimits::DEFAULTS.max_cover_png_bytes,
            "a 100000x100000 page must rasterize into the fixed cover budget, got {} bytes",
            png.len()
        ),
        // Ok(None) is a sanctioned outcome: the cover importer treats a
        // failed render as soft (an existing cover is kept), so a hostile
        // page may yield no cover at all. It may never exceed the budget
        // or take the worker down.
        Ok(None) => {}
        Err(err) => assert!(
            matches!(
                err,
                WorkerError::Parse(_) | WorkerError::Limit(_) | WorkerError::Deadline
            ),
            "a hostile render must fail typed, got: {err:?}"
        ),
    }
    // The worker recovered: a benign cover render still succeeds.
    let benign = client.pdf_cover(&fixture("minimal.pdf"), &dirs, &ResourceLimits::DEFAULTS);
    assert!(benign.is_ok(), "worker must recover: {benign:?}");
}

// ---------------------------------------------------------------------------
// W boundary subset (with #81): hostile input through the real worker
// ---------------------------------------------------------------------------

#[test]
fn hostile_epub_scripted_book_opens_inert_through_the_worker_and_the_worker_recovers() {
    let client = WorkerClient::locate().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("scripted.epub");
    hostile_epub::scripted_manifest_item(&path);

    // E-1 fences scripts at the engine seam (sanitizer + frame CSP), so a
    // book shipping script resources opens through the worker, rendered as
    // if scripting were disabled, instead of tripping a sidecar gate.
    let session = client
        .epub_session(&path, &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(
        session.manifest_json.contains("chapter1.xhtml"),
        "session manifest must list the spine: {session:?}"
    );
    // W-9: the worker is reusable after hostile input.
    let good = client
        .epub_parse(&fixture("minimal.epub"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!good.spine.is_empty());
}

#[test]
fn hostile_member_path_fails_typed_through_the_worker() {
    let client = WorkerClient::locate().unwrap();
    let book = fixture("minimal.epub");

    let err = client
        .epub_member(&book, "../secret.txt", &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
    let hit = client
        .epub_member(&book, "META-INF/container.xml", &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(
        hit.is_some(),
        "worker must keep serving after a hostile path"
    );
}

#[test]
fn hostile_pdf_fails_typed_through_the_worker_and_the_worker_recovers() {
    let client = WorkerClient::locate().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("badstart.pdf");
    std::fs::write(&path, hostile_pdf::bad_startxref()).unwrap();

    let err = client
        .pdf_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
    let good = client
        .pdf_parse(&fixture("minimal.pdf"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!good.metadata.title.is_empty());
}
