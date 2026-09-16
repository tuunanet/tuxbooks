use std::path::Path;

use lopdf::{Document, Object};

use super::PdfError;
use crate::limits::{Deadline, ResourceLimits};

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

/// Runtime- and database-independent representation of a parsed PDF.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfBook {
    pub metadata: PdfMetadata,
}

/// Open a PDF and extract its metadata. Missing or empty fields fall back to
/// the file name for the title; structural failures (not a PDF, broken xref,
/// unsupported encryption) are typed errors. Every stage enforces the
/// `limits` quotas (issue #83) and fails fast with a typed limit error.
pub fn parse_pdf(path: &Path, limits: &ResourceLimits) -> Result<PdfBook, PdfError> {
    limits.check_source_file(std::fs::metadata(path)?.len())?;
    let deadline = Deadline::start(limits);
    deadline.check()?;
    let doc = Document::load(path).map_err(|err| PdfError::Parse(err.to_string()))?;
    deadline.check()?;
    count_pages_bounded(&doc, limits)?;
    deadline.check()?;

    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|obj| resolve(&doc, obj))
        .and_then(|obj| obj.as_dict().ok().cloned());

    let read = |key: &[u8]| -> Result<Option<String>, PdfError> {
        let value = info
            .as_ref()
            .and_then(|dict| dict.get(key).ok())
            .and_then(|obj| resolve(&doc, obj))
            .and_then(|obj| obj.as_str().ok())
            .map(decode_pdf_string)
            .filter(|value| !value.is_empty());
        match value {
            Some(value) => {
                limits.check_metadata_string(&value)?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    };

    Ok(PdfBook {
        metadata: PdfMetadata {
            title: read(b"Title")?.unwrap_or_else(|| fallback_title(path)),
            author: read(b"Author")?,
            description: read(b"Subject")?,
        },
    })
}

/// Walk the page tree with explicit budgets (R-2): node visits and depth are
/// capped, the leaf count must fit `max_pages`, and the walk stops early once
/// the page budget is exceeded. The walk is iterative, so no PDF structure
/// can drive recursion.
fn count_pages_bounded(doc: &Document, limits: &ResourceLimits) -> Result<usize, PdfError> {
    let catalog = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|obj| resolve(doc, obj))
        .and_then(|obj| obj.as_dict().ok())
        .ok_or_else(|| PdfError::Parse("missing document catalog".into()))?;
    let Some(root) = catalog
        .get(b"Pages")
        .ok()
        .and_then(|obj| resolve(doc, obj))
        .and_then(|obj| obj.as_dict().ok())
    else {
        return Ok(0);
    };

    let mut visited = 0usize;
    let mut pages = 0usize;
    let mut stack: Vec<(&lopdf::Dictionary, usize)> = vec![(root, 1)];
    while let Some((dict, depth)) = stack.pop() {
        visited += 1;
        limits.check_page_tree_node(visited)?;
        limits.check_page_tree_depth(depth)?;
        match dict.get(b"Type").ok().and_then(|obj| obj.as_name().ok()) {
            Some(b"Page") => {
                pages += 1;
                limits.check_pages(pages)?;
            }
            _ => {
                if let Ok(kids) = dict.get(b"Kids").and_then(|obj| obj.as_array()) {
                    for kid in kids {
                        if let Some(kid_dict) = resolve(doc, kid).and_then(|obj| obj.as_dict().ok())
                        {
                            stack.push((kid_dict, depth + 1));
                        }
                    }
                }
            }
        }
    }
    Ok(pages)
}

/// Every non-empty native entry of the document information dictionary, in a
/// stable display order, for the read-only "Original File Metadata" panel.
/// Unlike `parse_pdf`, a missing `/Title` stays missing (no file-name
/// fallback): this view reports what the file actually carries. The same
/// `limits` quotas apply as in `parse_pdf`.
pub fn read_file_properties(
    path: &Path,
    limits: &ResourceLimits,
) -> Result<Vec<(String, String)>, PdfError> {
    limits.check_source_file(std::fs::metadata(path)?.len())?;
    let deadline = Deadline::start(limits);
    deadline.check()?;
    let doc = Document::load(path).map_err(|err| PdfError::Parse(err.to_string()))?;
    deadline.check()?;
    count_pages_bounded(&doc, limits)?;
    deadline.check()?;

    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|obj| resolve(&doc, obj))
        .and_then(|obj| obj.as_dict().ok().cloned());

    let read = |key: &[u8]| -> Result<Option<String>, PdfError> {
        let value = info
            .as_ref()
            .and_then(|dict| dict.get(key).ok())
            .and_then(|obj| resolve(&doc, obj))
            .and_then(|obj| obj.as_str().ok())
            .map(decode_pdf_string)
            .filter(|value| !value.is_empty());
        match value {
            Some(value) => {
                limits.check_metadata_string(&value)?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    };

    let mut entries = Vec::new();
    let mut push = |key: &str, value: Option<String>| {
        if let Some(value) = value {
            entries.push((key.to_string(), value));
        }
    };
    push("Title", read(b"Title")?);
    push("Author", read(b"Author")?);
    push("Subject", read(b"Subject")?);
    push("Keywords", read(b"Keywords")?);
    push("Creator", read(b"Creator")?);
    push("Producer", read(b"Producer")?);
    push(
        "Creation date",
        read(b"CreationDate")?.map(|value| decode_pdf_date(&value)),
    );
    push(
        "Modification date",
        read(b"ModDate")?.map(|value| decode_pdf_date(&value)),
    );
    Ok(entries)
}

/// PDF dates look like `D:YYYYMMDDHHmmSSOHH'mm'`; render the common
/// `YYYY-MM-DD HH:mm` shape and fall back to the raw value when the string
/// does not carry a full date.
fn decode_pdf_date(raw: &str) -> String {
    let digits: String = raw
        .strip_prefix("D:")
        .unwrap_or(raw)
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    match (digits.get(0..4), digits.get(4..6), digits.get(6..8)) {
        (Some(year), Some(month), Some(day)) => {
            let date = format!("{year}-{month}-{day}");
            match (digits.get(8..10), digits.get(10..12)) {
                (Some(hour), Some(minute)) => format!("{date} {hour}:{minute}"),
                _ => date,
            }
        }
        _ => raw.to_string(),
    }
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
    use crate::limits::ResourceLimits;
    use std::fs;

    /// A structurally valid PDF whose page tree holds `count` leaf pages
    /// under one root (flat Kids array).
    fn build_pdf_with_pages(count: usize) -> Vec<u8> {
        let kids: Vec<String> = (3..(count as u32) + 3)
            .map(|id| format!("{id} 0 R"))
            .collect();
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {count} >>",
                kids.join(" ")
            ),
        ];
        for _ in 0..count {
            objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string());
        }
        tests_support::assemble_pdf(objects, "")
    }

    /// A structurally valid PDF whose page tree is a chain `depth` levels
    /// deep ending in one page leaf: object 1 = catalog, objects 2..=depth+1
    /// = chained Pages nodes, object depth+2 = the page leaf.
    fn build_pdf_with_deep_tree(depth: usize) -> Vec<u8> {
        let mut objects = vec!["<< /Type /Catalog /Pages 2 0 R >>".to_string()];
        for node in 2..(depth as u32) + 2 {
            let next = if node == (depth as u32) + 1 {
                (depth as u32) + 2
            } else {
                node + 1
            };
            objects.push(format!("<< /Type /Pages /Kids [{next} 0 R] >>"));
        }
        objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string());
        tests_support::assemble_pdf(objects, "")
    }

    #[test]
    fn parse_pdf_rejects_oversized_source_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("huge.pdf");
        std::fs::write(&path, vec![0u8; 200]).unwrap();
        let tight = ResourceLimits {
            max_source_file_bytes: 100,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_too_many_pages() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("many.pdf");
        std::fs::write(&path, build_pdf_with_pages(3)).unwrap();
        let tight = ResourceLimits {
            max_pages: 2,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_page_tree_over_node_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nodes.pdf");
        std::fs::write(&path, build_pdf_with_deep_tree(8)).unwrap();
        let tight = ResourceLimits {
            max_page_tree_nodes: 3,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_deep_page_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("deep.pdf");
        std::fs::write(&path, build_pdf_with_deep_tree(8)).unwrap();
        let tight = ResourceLimits {
            max_page_tree_depth: 3,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_oversized_metadata_string() {
        let tmp = tempfile::tempdir().unwrap();
        let title: String = "t".repeat(4 << 10);
        let path = tmp.path().join("longtitle.pdf");
        std::fs::write(&path, tests_support::build_pdf(&[("Title", &title)])).unwrap();
        let tight = ResourceLimits {
            max_metadata_string_bytes: 100,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_rejects_expired_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fixture.pdf");
        std::fs::write(&path, tests_support::build_pdf(&[("Title", "x")])).unwrap();
        let tight = ResourceLimits {
            max_parse_seconds: 0,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_pdf(&path, &tight).unwrap_err();
        assert!(matches!(err, PdfError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_pdf_accepts_fixture_under_default_limits() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/books/minimal.pdf");
        parse_pdf(&fixture, &ResourceLimits::DEFAULTS).unwrap();
    }

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

        let book = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
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

        let book = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
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

        let book = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(book.metadata.title, "untitled");
        assert_eq!(book.metadata.author.as_deref(), Some("Someone"));
    }

    #[test]
    fn utf16_strings_are_decoded() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf_utf16(tmp.path(), "hex-title.pdf");

        let book = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
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

        let err = parse_pdf(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap_err();
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

    #[test]
    fn reads_native_info_dictionary_entries_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(
            tmp.path(),
            "props.pdf",
            &build_pdf(&[
                ("Title", "The Quiet Meridian"),
                ("Author", "Elena Vasquez"),
                ("Subject", "tide charts"),
                ("Keywords", "tides, radio"),
                ("Creator", "Acme Writer"),
                ("Producer", "Acme Publisher"),
                ("CreationDate", "D:20230412102400-04'00'"),
                ("ModDate", "D:20230501120000Z"),
            ]),
        );

        let entries =
            read_file_properties(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(
            entries[0],
            ("Title".to_string(), "The Quiet Meridian".to_string())
        );
        assert!(entries.contains(&("Keywords".to_string(), "tides, radio".to_string())));
        assert!(entries.contains(&("Creator".to_string(), "Acme Writer".to_string())));
        assert!(entries.contains(&("Creation date".to_string(), "2023-04-12 10:24".to_string())));
        assert!(entries.contains(&(
            "Modification date".to_string(),
            "2023-05-01 12:00".to_string()
        )));
    }

    #[test]
    fn file_properties_omit_missing_entries_without_a_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_pdf(tmp.path(), "untitled.pdf", &build_pdf(&[]));
        assert_eq!(
            read_file_properties(&path, &crate::limits::ResourceLimits::DEFAULTS).unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn pdf_dates_render_common_shapes() {
        assert_eq!(
            decode_pdf_date("D:20230412102400-04'00'"),
            "2023-04-12 10:24"
        );
        assert_eq!(decode_pdf_date("D:20230412"), "2023-04-12");
        assert_eq!(decode_pdf_date("not a date"), "not a date");
    }
}

/// Shared helpers for tests in other modules that need a real PDF on disk.
#[cfg(test)]
pub(crate) mod tests_support {
    use std::fs;
    use std::path::Path;

    /// Assembles object bodies into a structurally valid PDF with a correct
    /// xref table. `trailer_extra` is spliced into the trailer dictionary
    /// (e.g. `/Info 4 0 R`).
    pub(crate) fn assemble_pdf(objects: Vec<String>, trailer_extra: &str) -> Vec<u8> {
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
            "trailer\n<< /Size {} /Root 1 0 R {trailer_extra} >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        ));
        pdf.into_bytes()
    }

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

        assemble_pdf(objects, &info_ref)
    }

    pub(crate) fn write_pdf(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}
