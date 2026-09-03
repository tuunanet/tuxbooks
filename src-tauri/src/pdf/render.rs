use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use pdfium_render::prelude::*;

use super::PdfError;

/// Rendered cover width in pixels. The grid shows covers at a fraction of
/// this; the headroom keeps the book-detail view sharp.
const COVER_WIDTH_PX: i32 = 600;

/// Process-wide PDFium handle. PDFium initializes exactly once; every scan
/// reuses the bindings from the first successful probe.
static PDFIUM: OnceLock<Pdfium> = OnceLock::new();

/// Serializes the bind sequence. pdfium-render probes its global bindings
/// state non-atomically, so two threads can both "win" `bind_to_library`;
/// the loser's teardown would then destroy the winner's `FPDF_InitLibrary`.
static BIND_LOCK: Mutex<()> = Mutex::new(());

/// Rasterize page 1 of the PDF at `path` into PNG bytes for use as a
/// library cover. Returns `Ok(None)` when no PDFium dynamic library can be
/// loaded from `library_dirs` or the system loader: covers are best-effort
/// and must never fail an import. Callers pass candidate directories that
/// may contain the platform library (see `pdfium_library_dirs` in `lib.rs`
/// and `docs/build.md`).
pub fn render_first_page_cover(
    path: &Path,
    library_dirs: &[PathBuf],
) -> Result<Option<Vec<u8>>, PdfError> {
    let Some(pdfium) = pdfium(library_dirs) else {
        return Ok(None);
    };

    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|err| PdfError::Render(err.to_string()))?;
    let pages = document.pages();
    if pages.is_empty() {
        return Ok(None);
    }
    let page = pages
        .get(0)
        .map_err(|err| PdfError::Render(err.to_string()))?;
    let image = page
        .render_with_config(&PdfRenderConfig::new().set_target_width(COVER_WIDTH_PX))
        .map_err(|err| PdfError::Render(err.to_string()))?
        .as_image()
        .map_err(|err| PdfError::Render(err.to_string()))?;

    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|err| PdfError::Render(err.to_string()))?;
    Ok(Some(png.into_inner()))
}

/// True when a PDFium library loads from the given candidate directories.
/// Callers use it to degrade gracefully (tests skip; imports proceed
/// without covers) when the library was never installed.
pub fn pdfium_available(library_dirs: &[PathBuf]) -> bool {
    pdfium(library_dirs).is_some()
}

/// Bind to the first loadable PDFium library from the candidate directories
/// (falling back to the system loader) and cache it for the process
/// lifetime. `None` means PDFium is unavailable and covers are skipped.
fn pdfium(library_dirs: &[PathBuf]) -> Option<&'static Pdfium> {
    if let Some(pdfium) = PDFIUM.get() {
        return Some(pdfium);
    }
    let _serial = BIND_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(pdfium) = PDFIUM.get() {
        return Some(pdfium);
    }

    for dir in library_dirs {
        let candidate = Pdfium::pdfium_platform_library_name_at_path(dir);
        if !candidate.exists() {
            continue;
        }
        match Pdfium::bind_to_library(&candidate) {
            Ok(bindings) => {
                let _raced = PDFIUM.set(Pdfium::new(bindings));
                return PDFIUM.get();
            }
            Err(_) => continue,
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(bindings) => {
            let _raced = PDFIUM.set(Pdfium::new(bindings));
            PDFIUM.get()
        }
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The dev checkout's library directory (scripts/fetch-pdfium.sh), the
    /// same candidate the app builds; may be absent when pdfium was never
    /// fetched, in which case tests skip.
    fn library_dirs() -> Vec<PathBuf> {
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium")]
    }

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/books")
            .join(name)
    }

    /// Skip guard for tests that need a real PDFium library: absent when the
    /// dev checkout was never fetched via `just fetch-pdfium` (docs/build.md).
    pub(crate) fn pdfium_is_available() -> bool {
        pdfium_available(&[PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium")])
    }

    fn png_dimensions(png: &[u8]) -> (u32, u32) {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
        let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
        let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
        (width, height)
    }

    #[test]
    fn renders_first_page_of_fixture_pdf_as_png() {
        if !pdfium_is_available() {
            eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)");
            return;
        }

        let png = render_first_page_cover(&fixture("minimal.pdf"), &library_dirs())
            .unwrap()
            .expect("fixture PDF must render");

        let (width, height) = png_dimensions(&png);
        assert_eq!(width, COVER_WIDTH_PX as u32);
        assert!(height > 0);
    }

    #[test]
    fn garbage_bytes_report_a_render_error() {
        if !pdfium_is_available() {
            eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)");
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("garbage.pdf");
        std::fs::write(&path, b"this is not a pdf at all").unwrap();

        let err = render_first_page_cover(&path, &library_dirs()).unwrap_err();
        assert!(matches!(err, PdfError::Render(_)), "got: {err:?}");
    }
}
