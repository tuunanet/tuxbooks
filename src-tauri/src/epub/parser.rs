use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use super::metadata::{attribute, local_name, parse_opf, OpfPackage};
use super::EpubError;

/// Cover image bytes with their media type (e.g. `image/png`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverImage {
    pub media_type: String,
    pub data: Vec<u8>,
}

/// Tauri- and database-independent representation of a parsed EPUB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubBook {
    pub metadata: super::EpubMetadata,
    /// Manifest hrefs in spine/reading order.
    pub spine: Vec<String>,
    pub cover: Option<CoverImage>,
}

/// Open an EPUB file, validate its container structure, and extract
/// metadata, reading order, and the cover image when present.
pub fn parse_epub(path: &Path) -> Result<EpubBook, EpubError> {
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(BufReader::new(file))?;

    read_mimetype(&mut zip)?;

    let container =
        read_entry(&mut zip, "META-INF/container.xml")?.ok_or(EpubError::MissingContainer)?;
    let opf_path = parse_container_xml(&container)?;

    let opf_bytes =
        read_entry(&mut zip, &opf_path)?.ok_or_else(|| EpubError::MissingOpf(opf_path.clone()))?;
    let opf_xml = String::from_utf8(opf_bytes).map_err(|e| EpubError::OpfXml(e.to_string()))?;
    let package = parse_opf(&opf_xml)?;

    let spine = resolve_spine(&package)?;
    let cover = extract_cover(&package, &opf_path, &mut zip)?;

    Ok(EpubBook {
        metadata: package.metadata,
        spine,
        cover,
    })
}

fn read_mimetype<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<(), EpubError> {
    if zip.is_empty() {
        return Err(EpubError::MissingMimetype);
    }
    let mut first = zip.by_index(0)?;
    if first.name() != "mimetype" {
        return Err(EpubError::MissingMimetype);
    }
    let mut value = String::new();
    first.read_to_string(&mut value)?;
    if value != "application/epub+zip" {
        return Err(EpubError::InvalidMimetype);
    }
    Ok(())
}

fn parse_container_xml(bytes: &[u8]) -> Result<String, EpubError> {
    let xml =
        String::from_utf8(bytes.to_vec()).map_err(|e| EpubError::ContainerXml(e.to_string()))?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
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
    match read_entry(zip, &zip_path)? {
        Some(data) => Ok(Some(CoverImage {
            media_type: item.media_type.clone(),
            data,
        })),
        None => Ok(None),
    }
}

fn read_entry<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, EpubError> {
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        if file.is_dir() {
            continue;
        }
        if file.name() == name {
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;
            return Ok(Some(buf));
        }
    }
    Ok(None)
}

/// Resolve an href (relative to the OPF, possibly percent-encoded) to a ZIP entry name.
fn resolve_zip_path(opf_path: &str, href: &str) -> String {
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

fn normalize_path(path: &str) -> String {
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

fn percent_decode(input: &str) -> String {
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

    #[test]
    fn parses_fixture_metadata() {
        let book = parse_epub(&fixture_epub()).unwrap();
        assert_eq!(book.metadata.title, "A Minimal Book");
        assert_eq!(book.metadata.author.as_deref(), Some("Ada Lovelace"));
        assert_eq!(book.metadata.language.as_deref(), Some("en"));
        assert_eq!(book.metadata.isbn.as_deref(), Some("978-3-16-148410-0"));
    }

    #[test]
    fn fixture_spine_is_in_reading_order() {
        let book = parse_epub(&fixture_epub()).unwrap();
        assert_eq!(
            book.spine,
            vec!["chapter1.xhtml".to_string(), "chapter2.xhtml".to_string()]
        );
    }

    #[test]
    fn fixture_cover_is_extracted() {
        let book = parse_epub(&fixture_epub()).unwrap();
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
        let book = parse_epub(&path).unwrap();
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
        let book = parse_epub(&path).unwrap();
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
        let err = parse_epub(&path).unwrap_err();
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
        let err = parse_epub(&path).unwrap_err();
        assert!(matches!(err, EpubError::NoRootfile), "got: {err:?}");
    }

    proptest::proptest! {
        #[test]
        fn parse_never_panics_on_arbitrary_bytes(data in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..4096)) {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("fuzz.epub");
            std::fs::write(&path, &data).unwrap();
            let _ = parse_epub(&path);
        }
    }
}
