use std::path::Path;

use lopdf::{Document, Object};

use super::PdfError;

/// Bibliographic metadata extracted from a PDF's document information
/// dictionary. PDFs carry no publisher/ISBN/language fields reliably, so
/// those stay unset and the UI shows its placeholders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfMetadata {
    /// `/Title`, falling back to a cleaned-up file name when absent.
    pub title: String,
    pub author: Option<String>,
    /// `/Subject` — PDFs have no dedicated description field.
    pub description: Option<String>,
}

/// Tauri- and database-independent representation of a parsed PDF.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfBook {
    pub metadata: PdfMetadata,
}

/// Open a PDF and extract its metadata. Missing or empty fields fall back to
/// the file name for the title; structural failures (not a PDF, broken xref,
/// unsupported encryption) are typed errors.
pub fn parse_pdf(path: &Path) -> Result<PdfBook, PdfError> {
    let doc = Document::load(path).map_err(|err| PdfError::Parse(err.to_string()))?;
    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|obj| resolve(&doc, obj))
        .and_then(|obj| obj.as_dict().ok().cloned());

    let read = |key: &[u8]| -> Option<String> {
        info.as_ref()
            .and_then(|dict| dict.get(key).ok())
            .and_then(|obj| resolve(&doc, obj))
            .and_then(|obj| obj.as_str().ok())
            .map(decode_pdf_string)
            .filter(|value| !value.is_empty())
    };

    Ok(PdfBook {
        metadata: PdfMetadata {
            title: read(b"Title").unwrap_or_else(|| fallback_title(path)),
            author: read(b"Author"),
            description: read(b"Subject"),
        },
    })
}

/// Follow one indirect-reference hop; lopdf stores trailer values as
/// `Reference` whenever the Info dictionary lives in an object stream.
fn resolve<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Object> {
    match obj {
        Object::Reference(id) => doc.get_object(*id).ok(),
        _ => Some(obj),
    }
}

/// PDF strings are either UTF-16BE (marked with a `FE FF` byte-order mark)
/// or PDFDocEncoding, which matches Latin-1 for the characters that matter
/// in bibliographic metadata. Decoding is best-effort, never lossy-panicking.
fn decode_pdf_string(bytes: &[u8]) -> String {
    let value = if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .filter(|pair| pair.len() == 2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        bytes.iter().map(|&byte| byte as char).collect()
    };
    value.trim().to_string()
}

/// Titles are mandatory in the library schema; a PDF without one is indexed
/// under a humanized file name rather than being rejected.
fn fallback_title(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let humanized = stem.replace('_', " ").trim().to_string();
    if humanized.is_empty() {
        "Untitled PDF".to_string()
    } else {
        humanized
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::{build_pdf, write_pdf};
    use super::*;
    use std::fs;

    #[test]
    fn extracts_title_author_and_subject() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(
            tmp.path(),
            "book.pdf",
            &build_pdf(&[
                ("Title", "The Quiet Meridian"),
                ("Author", "Elena Vasquez"),
                ("Subject", "tide charts and radio static"),
            ]),
        );

        let book = parse_pdf(&path).unwrap();
        assert_eq!(book.metadata.title, "The Quiet Meridian");
        assert_eq!(book.metadata.author.as_deref(), Some("Elena Vasquez"));
        assert_eq!(
            book.metadata.description.as_deref(),
            Some("tide charts and radio static")
        );
    }

    #[test]
    fn missing_info_dictionary_falls_back_to_file_name() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(tmp.path(), "Winter_Arithmetic.pdf", &build_pdf(&[]));

        let book = parse_pdf(&path).unwrap();
        assert_eq!(book.metadata.title, "Winter Arithmetic");
        assert_eq!(book.metadata.author, None);
        assert_eq!(book.metadata.description, None);
    }

    #[test]
    fn empty_title_field_falls_back_to_file_name() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(
            tmp.path(),
            "untitled.pdf",
            &build_pdf(&[("Title", ""), ("Author", "Someone")]),
        );

        let book = parse_pdf(&path).unwrap();
        assert_eq!(book.metadata.title, "untitled");
        assert_eq!(book.metadata.author.as_deref(), Some("Someone"));
    }

    #[test]
    fn utf16_strings_are_decoded() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf_utf16(tmp.path(), "hex-title.pdf");

        let book = parse_pdf(&path).unwrap();
        assert_eq!(book.metadata.title, "Hanah");
        assert_eq!(book.metadata.author.as_deref(), Some("H"));
    }

    /// Builds a PDF whose /Title uses a UTF-16BE hex string (`FEFF`-prefixed).
    fn write_pdf_utf16(dir: &Path, name: &str) -> std::path::PathBuf {
        let objects: Vec<String> = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string(),
            "<< /Title <FEFF00480061006E00610068> /Author (H) >>".to_string(),
        ];

        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
        }
        let xref_offset = pdf.len();
        pdf.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
        pdf.push_str("0000000000 65535 f \n");
        for offset in offsets {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info 4 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        ));
        let path = dir.join(name);
        fs::write(&path, pdf).unwrap();
        path
    }

    #[test]
    fn garbage_bytes_report_a_parse_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(tmp.path(), "garbage.pdf", b"this is not a pdf at all");

        let err = parse_pdf(&path).unwrap_err();
        assert!(matches!(err, PdfError::Parse(_)), "got: {err:?}");
    }

    #[test]
    fn utf16_bom_decode_is_unit_testable() {
        // <FEFF 0048 0069> -> "Hi"
        assert_eq!(
            decode_pdf_string(&[0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69]),
            "Hi"
        );
        // Plain literal bytes decode as PDFDocEncoding/Latin-1.
        assert_eq!(decode_pdf_string(b"Plain"), "Plain");
        assert_eq!(decode_pdf_string(b"  padded  "), "padded");
    }
}

/// Shared helpers for tests in other modules that need a real PDF on disk.
#[cfg(test)]
pub(crate) mod tests_support {
    use std::fs;
    use std::path::Path;

    /// Assembles a minimal but structurally valid PDF: catalog, pages, one
    /// page, and an Info dictionary built from the given entries. Offsets
    /// are computed so the xref table is correct.
    pub(crate) fn build_pdf(info_entries: &[(&str, &str)]) -> Vec<u8> {
        let mut objects: Vec<String> = Vec::new();
        objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_string());
        objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string());
        objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string());
        let info_dict = info_entries
            .iter()
            .map(|(key, value)| format!("/{key} ({value})"))
            .collect::<Vec<_>>()
            .join(" ");
        let info_ref = if info_dict.is_empty() {
            String::new()
        } else {
            format!("/Info {} 0 R", objects.len() + 1)
        };
        if !info_dict.is_empty() {
            objects.push(format!("<< {info_dict} >>"));
        }

        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
        }

        let xref_offset = pdf.len();
        pdf.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
        pdf.push_str("0000000000 65535 f \n");
        for offset in offsets {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R {info_ref} >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        ));
        pdf.into_bytes()
    }

    pub(crate) fn write_pdf(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}
