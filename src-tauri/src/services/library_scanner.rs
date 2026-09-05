use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::epub::{parse_epub, EpubBook, EpubError};
use crate::pdf::{parse_pdf, PdfBook, PdfError};

/// One discovered book file together with its parse outcome.
/// Files that fail to parse are reported, not skipped silently.
#[derive(Debug)]
pub struct ScannedEntry {
    pub path: PathBuf,
    pub book: Result<ScannedBook, BookParseError>,
}

/// A parsed book of either supported format. The EPUB variant is boxed to
/// keep the enum size balanced (metadata carries Vec fields).
#[derive(Debug)]
pub enum ScannedBook {
    Epub(Box<EpubBook>),
    Pdf(PdfBook),
}

/// Per-file parse failures, reported per entry by the importer.
#[derive(Debug, thiserror::Error)]
pub enum BookParseError {
    #[error(transparent)]
    Epub(#[from] EpubError),
    #[error(transparent)]
    Pdf(#[from] PdfError),
}

/// Errors that make the whole scan meaningless (as opposed to a single bad file).
#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("library path does not exist: {0}")]
    Missing(PathBuf),
    #[error("library path is not a directory: {0}")]
    NotADirectory(PathBuf),
    #[error("cannot read library directory {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

fn has_book_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("epub") || ext.eq_ignore_ascii_case("pdf"))
}

/// Parse a single book file, dispatching on its extension. Shared by the
/// directory scan and the watcher reconciliation so both paths stay in sync.
pub fn parse_book(path: &Path) -> Result<ScannedBook, BookParseError> {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        parse_pdf(path).map(ScannedBook::Pdf).map_err(Into::into)
    } else {
        parse_epub(path)
            .map(|book| ScannedBook::Epub(Box::new(book)))
            .map_err(Into::into)
    }
}

/// List `.epub`/`.pdf` files under `root` without parsing them — the
/// cheap enumeration the reconciler uses to diff a location against the
/// database before deciding what is worth parsing. Sorted for determinism.
pub fn list_book_files(root: &Path) -> Result<Vec<PathBuf>, ScanError> {
    let metadata = std::fs::metadata(root).map_err(|source| ScanError::Io {
        path: root.to_path_buf(),
        source,
    })?;
    if !metadata.is_dir() {
        return Err(ScanError::NotADirectory(root.to_path_buf()));
    }

    let mut files: Vec<PathBuf> = WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| has_book_extension(entry.path()))
        .map(|entry| entry.into_path())
        .collect();
    files.sort();
    Ok(files)
}

/// Recursively scan `root` for `.epub` and `.pdf` files (case-insensitive
/// extension) and parse each one. Results are sorted by path for determinism.
/// The filesystem is only read, never modified.
pub fn scan_directory(root: &Path) -> Result<Vec<ScannedEntry>, ScanError> {
    let metadata = std::fs::metadata(root).map_err(|source| ScanError::Io {
        path: root.to_path_buf(),
        source,
    })?;
    if !metadata.is_dir() {
        return Err(ScanError::NotADirectory(root.to_path_buf()));
    }

    let mut entries: Vec<ScannedEntry> = WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| has_book_extension(entry.path()))
        .map(|entry| {
            let path = entry.into_path();
            let book = parse_book(&path);
            ScannedEntry { path, book }
        })
        .collect();

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(path: &Path, data: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, data).unwrap();
    }

    #[test]
    fn empty_directory_yields_no_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let entries = scan_directory(tmp.path()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn missing_directory_is_a_scan_error() {
        let tmp = tempfile::tempdir().unwrap();
        let err = scan_directory(&tmp.path().join("nope")).unwrap_err();
        assert!(matches!(err, ScanError::Io { .. }), "got: {err:?}");
    }

    #[test]
    fn file_as_root_is_not_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("book.epub");
        std::fs::write(&file, b"x").unwrap();
        let err = scan_directory(&file).unwrap_err();
        assert!(matches!(err, ScanError::NotADirectory(_)), "got: {err:?}");
    }

    #[test]
    fn finds_epub_in_nested_directories_and_ignores_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("a/b/deep.epub"), b"PK\x03\x04truncated");
        write_file(&root.join("notes.txt"), b"not a book");
        write_file(&root.join("cover.png"), b"\x89PNG");
        write_file(&root.join("no_ext"), b"?");

        let entries = scan_directory(root).unwrap();
        assert_eq!(entries.len(), 1, "only the .epub file is scanned");
        assert!(entries[0].path.ends_with("a/b/deep.epub"));
        assert!(entries[0].book.is_err(), "truncated file fails to parse");
    }

    #[test]
    fn pdf_files_are_discovered_and_parsed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let real_pdf = crate::pdf::parser::tests_support::build_pdf(&[
            ("Title", "Field Notes on Silence"),
            ("Author", "Petter Moen"),
        ]);
        write_file(&root.join("doc.pdf"), &real_pdf);
        write_file(&root.join("broken.pdf"), b"not a pdf");

        let entries = scan_directory(root).unwrap();
        assert_eq!(entries.len(), 2, "both PDF files are scanned");

        let ok = entries
            .iter()
            .find(|entry| entry.path.ends_with("doc.pdf"))
            .unwrap();
        match ok.book.as_ref().unwrap() {
            ScannedBook::Pdf(book) => {
                assert_eq!(book.metadata.title, "Field Notes on Silence");
                assert_eq!(book.metadata.author.as_deref(), Some("Petter Moen"));
            }
            other => panic!("expected a pdf book, got {other:?}"),
        }

        let broken = entries
            .iter()
            .find(|entry| entry.path.ends_with("broken.pdf"))
            .unwrap();
        assert!(
            matches!(broken.book, Err(BookParseError::Pdf(_))),
            "garbage pdf fails to parse: {:?}",
            broken.book
        );
    }

    #[test]
    fn extension_match_is_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("UPPER.EPUB"), b"PK\x03\x04");
        write_file(&root.join("lower.epub"), b"PK\x03\x04");

        let entries = scan_directory(root).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn entries_are_sorted_by_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("z.epub"), b"1");
        write_file(&root.join("a/m.epub"), b"2");
        write_file(&root.join("b.epub"), b"3");

        let entries = scan_directory(root).unwrap();
        let names: Vec<_> = entries
            .iter()
            .map(|e| e.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["m.epub", "b.epub", "z.epub"]);
    }

    #[test]
    fn directories_named_like_epub_files_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("fake.epub")).unwrap();
        write_file(&root.join("real.epub"), b"PK\x03\x04");

        let entries = scan_directory(root).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].path.ends_with("real.epub"));
    }

    #[test]
    fn malformed_epub_is_reported_as_entry_error_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("bad.epub"), b"garbage");

        let entries = scan_directory(root).unwrap();
        assert_eq!(entries.len(), 1);
        let err = entries[0].book.as_ref().unwrap_err();
        assert!(
            matches!(err, BookParseError::Epub(EpubError::Zip(_))),
            "got: {err:?}"
        );
    }

    proptest::proptest! {
        #[test]
        fn scan_only_reports_files_with_book_extensions(
            names in proptest::collection::vec(
                "[a-z]{1,8}(/[a-z0-9_]{1,8}){0,2}\\.(epub|EPUB|pdf|PDF|txt)",
                0..10
            ),
            data in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..64),
        ) {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            let mut unique = std::collections::BTreeSet::new();
            for name in &names {
                unique.insert(name.clone());
            }
            for name in &unique {
                write_file(&root.join(name), &data);
            }

            let entries = scan_directory(root).unwrap();
            let book_count = unique.iter().filter(|n| {
                let lower = n.to_lowercase();
                lower.ends_with(".epub") || lower.ends_with(".pdf")
            }).count();
            assert_eq!(entries.len(), book_count);
            for entry in &entries {
                assert!(
                    has_book_extension(&entry.path),
                    "scanned non-book: {:?}",
                    entry.path
                );
            }
        }
    }
}
