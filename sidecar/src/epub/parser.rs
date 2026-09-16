use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use super::metadata::{attribute, local_name, parse_opf, OpfPackage};
use super::EpubError;
use crate::limits::{read_bounded, Deadline, ResourceLimits};

/// Cover image bytes with their media type (e.g. `image/png`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CoverImage {
    pub media_type: String,
    pub data: Vec<u8>,
}

/// Runtime- and database-independent representation of a parsed EPUB.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EpubBook {
    pub metadata: super::EpubMetadata,
    /// Manifest hrefs in spine/reading order.
    pub spine: Vec<String>,
    pub cover: Option<CoverImage>,
}

/// Open an EPUB file, validate its container structure, and extract
/// metadata, reading order, and the cover image when present. Every stage
/// enforces the `limits` quotas (issue #83) and fails fast with a typed
/// limit error instead of unbounded work.
pub fn parse_epub(path: &Path, limits: &ResourceLimits) -> Result<EpubBook, EpubError> {
    limits.check_source_file(source_len(path)?)?;
    parse_epub_reader(BufReader::new(File::open(path)?), limits)
}

/// Reader-based parse core: same behavior as [`parse_epub`] for any
/// seekable source. The source-size quota is the path wrapper's job (an
/// fd or an in-memory source has no stat); the worker checks the fd
/// metadata against the job's quota table before handing the reader over.
pub fn parse_epub_reader<R: Read + Seek>(
    reader: BufReader<R>,
    limits: &ResourceLimits,
) -> Result<EpubBook, EpubError> {
    let deadline = Deadline::start(limits);
    let mut zip = ZipArchive::new(reader)?;
    check_archive_totals(&mut zip, limits)?;
    deadline.check()?;

    read_mimetype(&mut zip, limits)?;
    deadline.check()?;

    let container = read_entry(&mut zip, "META-INF/container.xml", limits)?
        .ok_or(EpubError::MissingContainer)?;
    let opf_path = parse_container_xml(&container, limits)?;
    deadline.check()?;

    let opf_bytes = read_entry(&mut zip, &opf_path, limits)?
        .ok_or_else(|| EpubError::MissingOpf(opf_path.clone()))?;
    let opf_xml = String::from_utf8(opf_bytes).map_err(|e| EpubError::OpfXml(e.to_string()))?;
    let package = parse_opf(&opf_xml, limits)?;
    deadline.check()?;

    let spine = resolve_spine(&package)?;
    let cover = extract_cover(&package, &opf_path, &mut zip, limits)?;
    deadline.check()?;

    Ok(EpubBook {
        metadata: package.metadata,
        spine,
        cover,
    })
}

fn source_len(path: &Path) -> Result<u64, EpubError> {
    Ok(std::fs::metadata(path)?.len())
}

/// Cheap central-directory pre-scan (R-1): entry count and the sum of
/// declared uncompressed sizes, before any member is decompressed.
pub(crate) fn check_archive_totals<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    limits: &ResourceLimits,
) -> Result<(), EpubError> {
    limits.check_entries(zip.len())?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        total += entry.size();
    }
    limits.check_total_uncompressed(total)?;
    Ok(())
}

/// Native metadata entries for the read-only "Original File Metadata" panel,
/// built from the same OPF parse the importer uses. Only non-empty values are
/// returned, in a stable display order.
pub fn read_file_properties(
    path: &Path,
    limits: &ResourceLimits,
) -> Result<Vec<(String, String)>, EpubError> {
    read_file_properties_reader(BufReader::new(File::open(path)?), limits)
}

/// Reader-based core of [`read_file_properties`]; the path wrapper owns the
/// source-size quota check (see [`parse_epub_reader`]).
pub fn read_file_properties_reader<R: Read + Seek>(
    reader: BufReader<R>,
    limits: &ResourceLimits,
) -> Result<Vec<(String, String)>, EpubError> {
    let metadata = parse_epub_reader(reader, limits)?.metadata;
    let mut entries = Vec::new();
    let mut push = |key: &str, value: Option<String>| {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            entries.push((key.to_string(), value));
        }
    };
    push("Title", Some(metadata.title));
    push("Subtitle", metadata.subtitle);
    push(
        "Creator(s)",
        (!metadata.authors.is_empty()).then(|| metadata.authors.join(", ")),
    );
    push(
        "Subject(s)",
        (!metadata.subjects.is_empty()).then(|| metadata.subjects.join(", ")),
    );
    push("Publisher", metadata.publisher);
    push("Language", metadata.language);
    push("Date", metadata.publication_date);
    push("Identifier (ISBN)", metadata.isbn);
    if let Some(series) = metadata.series {
        let value = match metadata.series_index {
            Some(index) => format!("{series} #{index}"),
            None => series,
        };
        entries.push(("Series".to_string(), value));
    }
    Ok(entries)
}

fn read_mimetype<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    limits: &ResourceLimits,
) -> Result<(), EpubError> {
    if zip.is_empty() {
        return Err(EpubError::MissingMimetype);
    }
    let first = zip.by_index(0)?;
    if first.name() != "mimetype" {
        return Err(EpubError::MissingMimetype);
    }
    limits.check_member(first.compressed_size(), first.size())?;
    let mut value = String::new();
    first
        .take(limits.max_decompressed_bytes.saturating_add(1))
        .read_to_string(&mut value)?;
    if value.len() as u64 > limits.max_decompressed_bytes {
        return Err(EpubError::Limit(crate::limits::LimitExceeded {
            limit: "max_decompressed_bytes",
            detail: "mimetype member over cap".to_string(),
        }));
    }
    if value != "application/epub+zip" {
        return Err(EpubError::InvalidMimetype);
    }
    Ok(())
}

pub(crate) fn parse_container_xml(
    bytes: &[u8],
    limits: &ResourceLimits,
) -> Result<String, EpubError> {
    limits.check_xml_bytes(bytes.len())?;
    let xml =
        String::from_utf8(bytes.to_vec()).map_err(|e| EpubError::ContainerXml(e.to_string()))?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut depth = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                limits.check_xml_depth(depth)?;
                if local_name(e.name().into_inner()) == "rootfile" {
                    if let Some(full_path) = attribute(&e.attributes(), "full-path") {
                        return Ok(full_path);
                    }
                }
            }
            Ok(Event::Empty(ref e)) => {
                if local_name(e.name().into_inner()) == "rootfile" {
                    if let Some(full_path) = attribute(&e.attributes(), "full-path") {
                        return Ok(full_path);
                    }
                }
            }
            Ok(Event::Eof) => return Err(EpubError::NoRootfile),
            Err(err) => return Err(EpubError::ContainerXml(err.to_string())),
            _ => {}
        }
    }
}

fn resolve_spine(package: &OpfPackage) -> Result<Vec<String>, EpubError> {
    package
        .spine
        .iter()
        .map(|idref| {
            package
                .manifest
                .get(idref)
                .map(|item| item.href.clone())
                .ok_or_else(|| EpubError::BrokenSpine(idref.clone()))
        })
        .collect()
}

fn extract_cover<R: Read + Seek>(
    package: &OpfPackage,
    opf_path: &str,
    zip: &mut ZipArchive<R>,
    limits: &ResourceLimits,
) -> Result<Option<CoverImage>, EpubError> {
    let item = package
        .manifest
        .values()
        .find(|item| item.has_property("cover-image"))
        .or_else(|| {
            package
                .legacy_cover_id
                .as_ref()
                .and_then(|id| package.manifest.get(id))
        });

    let Some(item) = item else {
        return Ok(None);
    };

    let zip_path = resolve_zip_path(opf_path, &item.href);
    match read_entry(zip, &zip_path, limits)? {
        Some(data) => Ok(Some(CoverImage {
            media_type: item.media_type.clone(),
            data,
        })),
        None => Ok(None),
    }
}

pub(crate) fn read_entry<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    limits: &ResourceLimits,
) -> Result<Option<Vec<u8>>, EpubError> {
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        if file.is_dir() {
            continue;
        }
        if file.name() == name {
            limits.check_member(file.compressed_size(), file.size())?;
            let data = read_bounded(file.by_ref(), limits.max_decompressed_bytes)?;
            return Ok(Some(data));
        }
    }
    Ok(None)
}

/// Resolve an href (relative to the OPF, possibly percent-encoded) to a ZIP entry name.
pub(crate) fn resolve_zip_path(opf_path: &str, href: &str) -> String {
    let decoded = percent_decode(href);
    if decoded.starts_with('/') {
        return normalize_path(&decoded);
    }
    let dir = match opf_path.rfind('/') {
        Some(idx) => &opf_path[..=idx],
        None => "",
    };
    normalize_path(&format!("{dir}{decoded}"))
}

/// Validate a renderer-supplied member path before any lookup (E-5):
/// traversal segments, absolute paths, Windows separators and drive
/// prefixes, and NUL/control characters are rejected with a typed error
/// instead of relying on the archive lookup to miss. Mirrors the protocol
/// layer's `parseMemberPath` exactly, so the two gates cannot drift.
pub(crate) fn validate_member_path(path: &str) -> Result<(), EpubError> {
    let reject = || Err(EpubError::InvalidMemberPath(path.to_string()));
    if path.contains('\\') || path.starts_with('/') {
        return reject();
    }
    if path.chars().any(|c| c == '\0' || c.is_control()) {
        return reject();
    }
    if path.split('/').any(|segment| segment == "..") {
        return reject();
    }
    let mut chars = path.chars();
    if let (Some(first), Some(second)) = (chars.next(), chars.next()) {
        if first.is_ascii_alphabetic() && second == ':' {
            return reject();
        }
    }
    Ok(())
}

pub(crate) fn normalize_path(path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
pub(crate) mod tests_support {
    use std::io::Write;
    use std::path::Path;

    pub(crate) fn fixture_epub() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
    }

    pub(crate) fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::{fixture_epub, write_zip};
    use super::*;
    use crate::epub::{read_member, read_member_reader};
    use crate::limits::ResourceLimits;

    const OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:x</dc:identifier>
    <dc:title>Root Level Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>"#;

    const CONTAINER: &[u8] =
        br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#;

    fn limits(max_source_file_bytes: u64) -> ResourceLimits {
        ResourceLimits {
            max_source_file_bytes,
            ..ResourceLimits::DEFAULTS
        }
    }

    #[test]
    fn parse_epub_rejects_oversized_source_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("huge.epub");
        std::fs::write(&path, vec![0u8; 200]).unwrap();
        let err = parse_epub(&path, &limits(100)).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_too_many_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("many.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", CONTAINER),
                ("content.opf", OPF.as_bytes()),
                ("filler.bin", &[0u8; 8]),
            ],
        );
        let tight = ResourceLimits {
            max_entries: 3,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_decompression_bomb_cover() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bomb.epub");
        let cover_opf = OPF.replace(
            r#"href="c1.xhtml" media-type="application/xhtml+xml""#,
            r#"href="cover.png" media-type="image/png" properties="cover-image""#,
        );
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", CONTAINER),
                ("content.opf", cover_opf.as_bytes()),
                ("cover.png", &vec![0u8; 4 << 20]),
            ],
        );
        let tight = ResourceLimits {
            max_decompressed_bytes: 1_024,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_oversized_total_uncompressed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("total.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", CONTAINER),
                ("content.opf", OPF.as_bytes()),
                ("filler.bin", &vec![0u8; 3 << 10]),
            ],
        );
        let tight = ResourceLimits {
            max_total_uncompressed_bytes: 2_000,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_rejects_expired_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("slow.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", CONTAINER),
                ("content.opf", OPF.as_bytes()),
            ],
        );
        let tight = ResourceLimits {
            max_parse_seconds: 0,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parse_epub_reader_matches_parse_epub() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("equivalent.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", OPF.as_bytes()),
            ],
        );
        let via_path = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let via_reader = parse_epub_reader(
            std::io::BufReader::new(std::io::Cursor::new(bytes)),
            &ResourceLimits::DEFAULTS,
        )
        .unwrap();
        assert_eq!(via_path.metadata.title, via_reader.metadata.title);
        assert_eq!(via_path.spine, via_reader.spine);
        assert_eq!(via_path.cover.is_some(), via_reader.cover.is_some());
    }

    #[test]
    fn read_member_reader_serves_the_same_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("member.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", b"<container/>".as_slice()),
            ],
        );
        let via_path =
            read_member(&path, "META-INF/container.xml", &ResourceLimits::DEFAULTS).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let via_reader = read_member_reader(
            std::io::BufReader::new(std::io::Cursor::new(bytes)),
            "META-INF/container.xml",
            &ResourceLimits::DEFAULTS,
        )
        .unwrap();
        assert_eq!(via_path, via_reader);
    }

    #[test]
    fn parse_epub_accepts_fixture_under_default_limits() {
        parse_epub(&fixture_epub(), &ResourceLimits::DEFAULTS).unwrap();
    }

    #[test]
    fn parse_epub_rejects_oversized_opf() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bigopf.epub");
        let mut opf = OPF.to_string();
        opf.push_str(&format!("<!-- {} -->", "x".repeat(4 << 10)));
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", CONTAINER),
                ("content.opf", opf.as_bytes()),
            ],
        );
        let tight = ResourceLimits {
            max_xml_bytes: 100,
            ..ResourceLimits::DEFAULTS
        };
        let err = parse_epub(&path, &tight).unwrap_err();
        assert!(matches!(err, EpubError::Limit(_)), "got: {err:?}");
    }

    #[test]
    fn parses_fixture_metadata() {
        let book = parse_epub(&fixture_epub(), &ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(book.metadata.title, "A Minimal Book");
        assert_eq!(book.metadata.author.as_deref(), Some("Ada Lovelace"));
        assert_eq!(book.metadata.language.as_deref(), Some("en"));
        assert_eq!(book.metadata.isbn.as_deref(), Some("978-3-16-148410-0"));
    }

    #[test]
    fn file_properties_list_native_metadata() {
        let entries = read_file_properties(&fixture_epub(), &ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(
            entries[0],
            ("Title".to_string(), "A Minimal Book".to_string())
        );
        assert!(entries.contains(&(
            "Identifier (ISBN)".to_string(),
            "978-3-16-148410-0".to_string()
        )));
        assert!(entries.contains(&("Language".to_string(), "en".to_string())));
        assert!(!entries.iter().any(|(_, value)| value.is_empty()));
    }

    #[test]
    fn fixture_spine_is_in_reading_order() {
        let book = parse_epub(&fixture_epub(), &ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(
            book.spine,
            vec![
                "chapter1.xhtml".to_string(),
                "chapter2.xhtml".to_string(),
                "chapter3.xhtml".to_string(),
            ]
        );
    }

    #[test]
    fn fixture_cover_is_extracted() {
        let book = parse_epub(&fixture_epub(), &ResourceLimits::DEFAULTS).unwrap();
        let cover = book.cover.expect("fixture has a cover");
        assert_eq!(cover.media_type, "image/png");
        assert_eq!(&cover.data[..4], &[0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn resolves_hrefs_relative_to_opf_in_root() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("root.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#,
                ),
                ("content.opf", OPF.as_bytes()),
                ("c1.xhtml", b"<html><body>c1</body></html>"),
            ],
        );
        let book = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(book.spine, vec!["c1.xhtml".to_string()]);
        assert!(book.cover.is_none());
    }

    #[test]
    fn percent_encoded_href_resolves_to_zip_entry() {
        let opf = OPF.replace(r#"href="c1.xhtml""#, r#"href="ch%20apters/c1.xhtml""#);
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("enc.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", opf.as_bytes()),
                ("ch apters/c1.xhtml", b"<html/>"),
            ],
        );
        let book = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(book.spine, vec!["ch%20apters/c1.xhtml".to_string()]);
    }

    #[test]
    fn unknown_spine_idref_reports_broken_spine() {
        let opf = OPF.replace(r#"<itemref idref="c1"/>"#, r#"<itemref idref="missing"/>"#);
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("broken.epub");
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
        let err = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::BrokenSpine(_)), "got: {err:?}");
    }

    #[test]
    fn container_without_rootfile_reports_no_rootfile() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("noroot.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"></container>"#,
                ),
            ],
        );
        let err = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::NoRootfile), "got: {err:?}");
    }

    proptest::proptest! {
        #[test]
        fn parse_never_panics_on_arbitrary_bytes(data in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..4096)) {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("fuzz.epub");
            std::fs::write(&path, &data).unwrap();
            let _ = parse_epub(&path, &ResourceLimits::DEFAULTS);
        }
    }
}
