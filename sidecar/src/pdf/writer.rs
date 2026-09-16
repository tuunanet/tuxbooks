//! Write bibliographic metadata back into a PDF's document information
//! dictionary.
//!
//! "Embed into file" support (metadata curation). PDFs only have standard
//! Info fields for a subset of the library's metadata: `/Title`, `/Author`,
//! and `/Subject` (the library's description). Publisher, language, ISBN,
//! publication date, series, and subtitle have no faithful PDF field and stay
//! database-side. The document is saved through `lopdf` (which renumbers
//! objects but preserves page content) and swapped in atomically.

use std::path::Path;

use lopdf::{Dictionary, Document, Object, StringFormat};

use super::{PdfError, PdfMetadata};
use crate::limits::ResourceLimits;

/// Rewrite `/Title`, `/Author`, and `/Subject`, preserving every other Info
/// entry. Replaces the file at `path` atomically.
pub fn write_metadata(path: &Path, metadata: &PdfMetadata) -> Result<(), PdfError> {
    let buffer = rewrite_pdf_bytes(&std::fs::read(path)?, metadata, &ResourceLimits::DEFAULTS)?;
    crate::backup_file_once(path)?;
    crate::atomic_replace(path, &buffer)?;
    Ok(())
}

/// Bytes-based rewrite core: returns the full rewritten PDF bytes. The
/// caller owns the write (the sidecar keeps `backup_file_once` +
/// `atomic_replace`; the worker only returns the buffer). Enforces the
/// source quota before loading the document.
pub fn rewrite_pdf_bytes(
    bytes: &[u8],
    metadata: &PdfMetadata,
    limits: &ResourceLimits,
) -> Result<Vec<u8>, PdfError> {
    limits.check_source_file(bytes.len() as u64)?;
    let mut document = Document::load_mem_with_options(bytes, super::parser::load_options(limits))
        .map_err(super::parser::load_error)?;

    let mut info = existing_info(&document).unwrap_or_default();
    set_required(&mut info, b"Title", &metadata.title);
    match non_empty(metadata.author.as_deref()) {
        Some(author) => set_required(&mut info, b"Author", author),
        None => {
            info.remove(b"Author");
        }
    }
    match non_empty(metadata.description.as_deref()) {
        Some(subject) => set_required(&mut info, b"Subject", subject),
        None => {
            info.remove(b"Subject");
        }
    }

    let info_id = document.add_object(Object::Dictionary(info));
    document.trailer.set("Info", Object::Reference(info_id));

    let mut buffer = Vec::new();
    document
        .save_to(&mut buffer)
        .map_err(|err| PdfError::Parse(err.to_string()))?;
    Ok(buffer)
}

/// The existing Info dictionary, following one indirect-reference hop.
fn existing_info(document: &Document) -> Option<Dictionary> {
    let info = document.trailer.get(b"Info").ok()?;
    let object = match info {
        Object::Reference(id) => document.get_object(*id).ok()?,
        other => other,
    };
    object.as_dict().ok().cloned()
}

fn set_required(info: &mut Dictionary, key: &[u8], value: &str) {
    info.set(key.to_vec(), pdf_string(value));
}

/// PDF strings are either ASCII literals or UTF-16BE with a byte-order mark
/// (the same two forms the reader decodes).
fn pdf_string(value: &str) -> Object {
    if value.is_ascii() {
        Object::string_literal(value.to_string())
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in value.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::super::parse_pdf;
    use super::*;
    use crate::pdf::parser::tests_support::{build_pdf, write_pdf};

    fn metadata(title: &str, author: Option<&str>, description: Option<&str>) -> PdfMetadata {
        PdfMetadata {
            title: title.to_string(),
            author: author.map(str::to_string),
            description: description.map(str::to_string),
        }
    }

    #[test]
    fn writes_and_reads_back_the_three_supported_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(
            tmp.path(),
            "book.pdf",
            &build_pdf(&[("Title", "Old Title"), ("Author", "Old Author")]),
        );

        write_metadata(
            &path,
            &metadata("New Title", Some("New Author"), Some("A subject")),
        )
        .unwrap();

        let parsed = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(parsed.metadata.title, "New Title");
        assert_eq!(parsed.metadata.author.as_deref(), Some("New Author"));
        assert_eq!(parsed.metadata.description.as_deref(), Some("A subject"));
    }

    #[test]
    fn first_write_backs_up_the_original_once() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(tmp.path(), "book.pdf", &build_pdf(&[("Title", "Old")]));
        let original = std::fs::read(&path).unwrap();

        write_metadata(&path, &metadata("New", None, None)).unwrap();
        let backup = crate::backup_path(&path);
        assert!(backup.exists(), "first embed creates a backup");
        assert_eq!(std::fs::read(&backup).unwrap(), original);

        write_metadata(&path, &metadata("Newer", None, None)).unwrap();
        assert_eq!(
            std::fs::read(&backup).unwrap(),
            original,
            "backup is not overwritten"
        );
    }

    #[test]
    fn creates_an_info_dictionary_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(tmp.path(), "plain.pdf", &build_pdf(&[]));

        write_metadata(&path, &metadata("Added Title", Some("Someone"), None)).unwrap();

        let parsed = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(parsed.metadata.title, "Added Title");
        assert_eq!(parsed.metadata.author.as_deref(), Some("Someone"));
        assert_eq!(parsed.metadata.description, None);
    }

    #[test]
    fn clears_author_and_subject_when_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(
            tmp.path(),
            "book.pdf",
            &build_pdf(&[("Title", "T"), ("Author", "A"), ("Subject", "S")]),
        );

        write_metadata(&path, &metadata("T", Some("   "), None)).unwrap();

        let parsed = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(parsed.metadata.author, None);
        assert_eq!(parsed.metadata.description, None);
    }

    #[test]
    fn non_ascii_values_round_trip_through_utf16() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(tmp.path(), "book.pdf", &build_pdf(&[]));

        write_metadata(&path, &metadata("Übermensch — naïve", Some("Åsa"), None)).unwrap();

        let parsed = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(parsed.metadata.title, "Übermensch — naïve");
        assert_eq!(parsed.metadata.author.as_deref(), Some("Åsa"));
    }

    #[test]
    fn malformed_pdf_errors_without_touching_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(tmp.path(), "garbage.pdf", b"not a pdf");
        let original = std::fs::read(&path).unwrap();

        let err = write_metadata(&path, &metadata("T", None, None)).unwrap_err();
        assert!(matches!(err, PdfError::Parse(_)), "got: {err:?}");
        assert_eq!(std::fs::read(&path).unwrap(), original, "file untouched");
    }
}
