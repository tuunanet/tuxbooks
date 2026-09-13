//! Write bibliographic metadata back into an EPUB package document.
//!
//! "Embed into file" support (metadata curation): the OPF `<metadata>`
//! section is rewritten in place — the fields TuxBooks manages are replaced
//! while every other child (`dcterms:modified`, non-ISBN identifiers, cover
//! metas, custom metadata) is preserved byte-for-byte. The whole archive is
//! copied into a new ZIP and swapped in atomically, so a failure never leaves
//! a truncated book behind.
//!
//! The writer is deliberately read-only about everything outside metadata:
//! manifest, spine, resources, and the cover image are copied untouched.

use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::metadata::{attribute, local_name, EpubMetadata};
use super::parser::{parse_container_xml, read_entry};
use super::EpubError;

/// Rewrite the package document's metadata to match `metadata`, preserving
/// everything else in the EPUB. Replaces the file at `path` atomically.
pub fn write_metadata(path: &Path, metadata: &EpubMetadata) -> Result<(), EpubError> {
    let source = File::open(path)?;
    let mut archive = ZipArchive::new(BufReader::new(source))?;

    let container =
        read_entry(&mut archive, "META-INF/container.xml")?.ok_or(EpubError::MissingContainer)?;
    let opf_path = parse_container_xml(&container)?;
    let opf_bytes = read_entry(&mut archive, &opf_path)?
        .ok_or_else(|| EpubError::MissingOpf(opf_path.clone()))?;
    let opf_xml = String::from_utf8(opf_bytes).map_err(|e| EpubError::OpfXml(e.to_string()))?;

    let rewritten_opf = rewrite_opf(&opf_xml, metadata)?;

    let mut buffer: Vec<u8> = Vec::with_capacity(rewritten_opf.len() + 4096);
    {
        let mut writer = ZipWriter::new(std::io::Cursor::new(&mut buffer));
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let name = entry.name().to_string();
            // Keep `mimetype` stored as EPUB requires; everything else stays
            // deflated (the only methods this build supports).
            let method = match entry.compression() {
                CompressionMethod::Stored => CompressionMethod::Stored,
                _ => CompressionMethod::Deflated,
            };
            writer.start_file(
                name.clone(),
                SimpleFileOptions::default().compression_method(method),
            )?;
            if name == opf_path {
                writer.write_all(rewritten_opf.as_bytes())?;
            } else {
                let mut data = Vec::new();
                entry.read_to_end(&mut data)?;
                writer.write_all(&data)?;
            }
        }
        writer.finish()?;
    }

    crate::backup_file_once(path)?;
    crate::atomic_replace(path, &buffer)?;
    Ok(())
}

/// Rewrite the `<metadata>` children of one OPF document.
fn rewrite_opf(opf_xml: &str, metadata: &EpubMetadata) -> Result<String, EpubError> {
    let located = find_metadata(opf_xml)?;
    let Some((span, unique_id)) = located else {
        return Err(EpubError::OpfXml(
            "package document has no <metadata> section".into(),
        ));
    };
    let inner = &opf_xml[span.open_end..span.close_start];
    let rewritten_inner = rewrite_inner(inner, unique_id.as_deref(), metadata)?;

    let mut out = String::with_capacity(opf_xml.len() + 256);
    out.push_str(&opf_xml[..span.open_end]);
    out.push_str(&rewritten_inner);
    out.push_str(&opf_xml[span.close_start..]);
    Ok(out)
}

/// Byte span of the `<metadata>` element and the package's `unique-identifier`.
struct MetadataSpan {
    /// End offset of the `<metadata ...>` opening tag.
    open_end: usize,
    /// Start offset of the closing `</metadata>` tag.
    close_start: usize,
}

/// Locate the metadata element without assuming a namespace prefix. Only the
/// first `<metadata>` is considered (the package document has exactly one).
fn find_metadata(opf_xml: &str) -> Result<Option<(MetadataSpan, Option<String>)>, EpubError> {
    let mut reader = Reader::from_str(opf_xml);
    reader.config_mut().trim_text(false);

    let mut unique_id: Option<String> = None;
    let mut metadata_open_end: Option<usize> = None;

    loop {
        let start = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|err| EpubError::OpfXml(err.to_string()))?;
        let end = reader.buffer_position() as usize;

        match event {
            Event::Start(ref element) => match local_name(element.name().into_inner()) {
                "package" => unique_id = attribute(&element.attributes(), "unique-identifier"),
                "metadata" if metadata_open_end.is_none() => metadata_open_end = Some(end),
                _ => {}
            },
            Event::Empty(_) => {}
            Event::End(ref element) => {
                if local_name(element.name().into_inner()) == "metadata" {
                    if let Some(open_end) = metadata_open_end {
                        return Ok(Some((
                            MetadataSpan {
                                open_end,
                                close_start: start,
                            },
                            unique_id,
                        )));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(None)
}

/// Rebuild the metadata children: generated managed fields first, then every
/// preserved child re-emitted from its original bytes.
fn rewrite_inner(
    inner: &str,
    unique_id: Option<&str>,
    metadata: &EpubMetadata,
) -> Result<String, EpubError> {
    let mut reader = Reader::from_str(inner);
    reader.config_mut().trim_text(false);

    let mut out = generate_children(metadata);
    let mut skip_depth = 0usize;

    loop {
        let start = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|err| EpubError::OpfXml(err.to_string()))?;
        let end = reader.buffer_position() as usize;

        match event {
            Event::Start(ref element) => {
                if skip_depth > 0 {
                    skip_depth += 1;
                } else if is_managed(element, unique_id) {
                    skip_depth = 1;
                } else {
                    out.push_str(&inner[start..end]);
                }
            }
            Event::Empty(ref element) => {
                if skip_depth == 0 && !is_managed(element, unique_id) {
                    out.push_str(&inner[start..end]);
                }
            }
            Event::End(_) => {
                if skip_depth > 0 {
                    skip_depth -= 1;
                } else {
                    out.push_str(&inner[start..end]);
                }
            }
            Event::Eof => break,
            _ => {
                if skip_depth == 0 {
                    out.push_str(&inner[start..end]);
                }
            }
        }
    }
    Ok(out)
}

/// Whether a metadata child is owned by TuxBooks and must be regenerated.
/// ISBN identifiers are managed unless they double as the package's
/// `unique-identifier` (dropping those would leave the package dangling).
fn is_managed(element: &quick_xml::events::BytesStart<'_>, unique_id: Option<&str>) -> bool {
    match local_name(element.name().into_inner()) {
        "title" | "creator" | "subject" | "publisher" | "language" | "date" | "description" => true,
        "identifier" => {
            let is_isbn = attribute(&element.attributes(), "scheme")
                .map(|scheme| scheme.eq_ignore_ascii_case("isbn"))
                .unwrap_or(false);
            if !is_isbn {
                return false;
            }
            attribute(&element.attributes(), "id").as_deref() != unique_id
        }
        "meta" => attribute(&element.attributes(), "name")
            .as_deref()
            .is_some_and(|name| matches!(name, "calibre:series" | "calibre:series_index")),
        _ => false,
    }
}

/// The managed metadata block, inserted at the start of `<metadata>`.
fn generate_children(metadata: &EpubMetadata) -> String {
    let escape = |value: &str| quick_xml::escape::escape(value).into_owned();
    let mut out = String::new();

    out.push_str(&format!(
        "<dc:title id=\"tuxbooks-title\">{}</dc:title>",
        escape(&metadata.title)
    ));
    if let Some(subtitle) = non_empty(metadata.subtitle.as_deref()) {
        out.push_str(&format!(
            "<dc:title id=\"tuxbooks-subtitle\">{}</dc:title>",
            escape(subtitle)
        ));
        out.push_str("<meta refines=\"#tuxbooks-title\" property=\"title-type\">main</meta>");
        out.push_str(
            "<meta refines=\"#tuxbooks-subtitle\" property=\"title-type\">subtitle</meta>",
        );
    }

    let authors: Vec<String> = if metadata.authors.is_empty() {
        metadata.author.iter().cloned().collect()
    } else {
        metadata.authors.clone()
    };
    for author in authors.iter().filter(|name| !name.trim().is_empty()) {
        out.push_str(&format!("<dc:creator>{}</dc:creator>", escape(author)));
    }
    for subject in metadata
        .subjects
        .iter()
        .filter(|name| !name.trim().is_empty())
    {
        out.push_str(&format!("<dc:subject>{}</dc:subject>", escape(subject)));
    }

    if let Some(value) = non_empty(metadata.description.as_deref()) {
        out.push_str(&format!(
            "<dc:description>{}</dc:description>",
            escape(value)
        ));
    }
    if let Some(value) = non_empty(metadata.publisher.as_deref()) {
        out.push_str(&format!("<dc:publisher>{}</dc:publisher>", escape(value)));
    }
    if let Some(value) = non_empty(metadata.language.as_deref()) {
        out.push_str(&format!("<dc:language>{}</dc:language>", escape(value)));
    }
    if let Some(value) = non_empty(metadata.publication_date.as_deref()) {
        out.push_str(&format!("<dc:date>{}</dc:date>", escape(value)));
    }
    if let Some(value) = non_empty(metadata.isbn.as_deref()) {
        out.push_str(&format!(
            "<dc:identifier opf:scheme=\"ISBN\" xmlns:opf=\"http://www.idpf.org/2007/opf\">{}</dc:identifier>",
            escape(value)
        ));
    }
    if let Some(series) = non_empty(metadata.series.as_deref()) {
        out.push_str(&format!(
            "<meta name=\"calibre:series\" content=\"{}\"/>",
            escape(series)
        ));
        if let Some(index) = metadata.series_index {
            out.push_str(&format!(
                "<meta name=\"calibre:series_index\" content=\"{index}\"/>"
            ));
        }
    }
    out
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::super::parser::tests_support::{fixture_epub, write_zip};
    use super::*;

    fn metadata() -> EpubMetadata {
        EpubMetadata {
            title: "Curated Title".into(),
            subtitle: None,
            author: Some("Ada Lovelace".into()),
            authors: vec!["Ada Lovelace".into(), "Grace Hopper".into()],
            subjects: vec!["Computing".into(), "History".into()],
            language: Some("en".into()),
            publisher: Some("Tuxbooks Press".into()),
            isbn: Some("978-1-2345-6789-0".into()),
            description: Some("A curated description & more.".into()),
            publication_date: Some("1843".into()),
            series: Some("Engines".into()),
            series_index: Some(2.0),
        }
    }

    #[test]
    fn rewrites_metadata_and_round_trips_through_the_parser() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::copy(fixture_epub(), &path).unwrap();

        write_metadata(&path, &metadata()).unwrap();

        let parsed = super::super::parse_epub(&path).unwrap();
        assert_eq!(parsed.metadata.title, "Curated Title");
        assert_eq!(
            parsed.metadata.authors,
            vec!["Ada Lovelace".to_string(), "Grace Hopper".to_string()]
        );
        assert_eq!(parsed.metadata.subjects.len(), 2);
        assert_eq!(parsed.metadata.language.as_deref(), Some("en"));
        assert_eq!(parsed.metadata.publisher.as_deref(), Some("Tuxbooks Press"));
        assert_eq!(parsed.metadata.isbn.as_deref(), Some("978-1-2345-6789-0"));
        assert_eq!(
            parsed.metadata.description.as_deref(),
            Some("A curated description & more.")
        );
        assert_eq!(parsed.metadata.publication_date.as_deref(), Some("1843"));
        assert_eq!(parsed.metadata.series.as_deref(), Some("Engines"));
        assert_eq!(parsed.metadata.series_index, Some(2.0));
        // The reading order and cover survive the rewrite.
        assert_eq!(parsed.spine.len(), 3);
        assert!(parsed.cover.is_some());
    }

    #[test]
    fn first_write_backs_up_the_original_once() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::copy(fixture_epub(), &path).unwrap();
        let original = std::fs::read(&path).unwrap();

        write_metadata(&path, &metadata()).unwrap();
        let backup = crate::backup_path(&path);
        assert!(backup.exists(), "first embed creates a backup");
        assert_eq!(
            std::fs::read(&backup).unwrap(),
            original,
            "backup holds the pre-embed original"
        );

        // A second write never overwrites the original backup.
        let second = EpubMetadata {
            title: "Second Title".into(),
            ..metadata()
        };
        write_metadata(&path, &second).unwrap();
        assert_eq!(
            std::fs::read(&backup).unwrap(),
            original,
            "backup still holds the original"
        );
    }

    #[test]
    fn writes_and_reads_a_subtitle() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::copy(fixture_epub(), &path).unwrap();

        let with_subtitle = EpubMetadata {
            subtitle: Some("A Subtitle".into()),
            ..metadata()
        };
        write_metadata(&path, &with_subtitle).unwrap();

        let parsed = super::super::parse_epub(&path).unwrap();
        assert_eq!(parsed.metadata.title, "Curated Title");
        assert_eq!(parsed.metadata.subtitle.as_deref(), Some("A Subtitle"));
    }

    #[test]
    fn preserves_non_managed_metadata_children() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("book.epub");
        let opf = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="book-id">urn:uuid:1234</dc:identifier>
    <dc:title>Old Title</dc:title>
    <meta property="dcterms:modified">2020-01-01T00:00:00Z</meta>
    <meta name="cover" content="cover-image"/>
    <dc:title>Old Second</dc:title>
  </metadata>
  <manifest/>
  <spine/>
</package>"#;
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", opf.as_bytes()),
            ],
        );

        write_metadata(&path, &metadata()).unwrap();

        // Read the OPF back out of the rewritten archive.
        let file = std::fs::File::open(&path).unwrap();
        let mut archive = ZipArchive::new(BufReader::new(file)).unwrap();
        let mut opf_text = String::new();
        archive
            .by_name("content.opf")
            .unwrap()
            .read_to_string(&mut opf_text)
            .unwrap();

        assert!(opf_text.contains("urn:uuid:1234"), "unique identifier kept");
        assert!(opf_text.contains("dcterms:modified"), "modified kept");
        assert!(opf_text.contains("name=\"cover\""), "cover meta kept");
        // Both old titles are replaced by exactly one managed title.
        assert_eq!(opf_text.matches("Old Title").count(), 0);
        assert_eq!(opf_text.matches("Old Second").count(), 0);
        assert!(opf_text.contains("Curated Title"));
    }

    #[test]
    fn malformed_opf_errors_without_touching_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("book.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", b"<package><metadata></metdata></package>"),
            ],
        );
        let original = std::fs::read(&path).unwrap();

        let err = write_metadata(&path, &metadata()).unwrap_err();
        assert!(matches!(err, EpubError::OpfXml(_)), "got: {err:?}");
        assert_eq!(std::fs::read(&path).unwrap(), original, "file untouched");
    }
}
