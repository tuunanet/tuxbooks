use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::Reader;

use super::EpubError;

/// Bibliographic metadata extracted from the OPF `<metadata>` section.
/// Author/subject lists keep every `dc:creator`/`dc:subject` (normalized
/// entities, milestone 7); `author` stays as the first creator for the
/// flat display column.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EpubMetadata {
    pub title: String,
    pub author: Option<String>,
    pub authors: Vec<String>,
    pub subjects: Vec<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    /// `dc:date` verbatim (a year or full date, whatever the file carries).
    pub publication_date: Option<String>,
    /// Calibre's `calibre:series` / `calibre:series_index` meta pair.
    pub series: Option<String>,
    pub series_index: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestItem {
    pub href: String,
    pub media_type: String,
    pub properties: Vec<String>,
}

impl ManifestItem {
    pub fn has_property(&self, name: &str) -> bool {
        self.properties.iter().any(|p| p == name)
    }
}

/// Parsed OPF package: metadata plus manifest/spine enough to establish reading order.
#[derive(Debug, Clone, PartialEq)]
pub struct OpfPackage {
    pub metadata: EpubMetadata,
    pub manifest: HashMap<String, ManifestItem>,
    /// Spine itemref ids in reading order.
    pub spine: Vec<String>,
    /// EPUB2 `<meta name="cover" content="...">` item id, if present.
    pub legacy_cover_id: Option<String>,
}

/// Parse an EPUB package document (OPF) from XML text.
pub fn parse_opf(xml: &str) -> Result<OpfPackage, EpubError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut metadata = EpubMetadata::default();
    let mut manifest: HashMap<String, ManifestItem> = HashMap::new();
    let mut spine = Vec::new();
    let mut legacy_cover_id = None;
    let mut series_index_raw: Option<String> = None;

    // None | "metadata" | "manifest" | "spine"
    let mut section: Option<String> = None;
    // Which metadata element's text we are currently accumulating, if any.
    let mut text_target: Option<&'static str> = None;
    let mut text_buf = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let local = local_name(e.name().into_inner());
                match (section.as_deref(), local) {
                    (None, "metadata") | (None, "manifest") | (None, "spine") => {
                        section = Some(local.to_string());
                    }
                    (Some("metadata"), "title")
                    | (Some("metadata"), "creator")
                    | (Some("metadata"), "subject")
                    | (Some("metadata"), "date")
                    | (Some("metadata"), "language")
                    | (Some("metadata"), "publisher")
                    | (Some("metadata"), "description") => {
                        text_target = Some(local_static(local));
                        text_buf.clear();
                    }
                    (Some("metadata"), "identifier") => {
                        if let Some(scheme) = attribute(&e.attributes(), "scheme") {
                            if scheme.eq_ignore_ascii_case("isbn") && metadata.isbn.is_none() {
                                text_target = Some("isbn");
                                text_buf.clear();
                            }
                        }
                    }
                    (Some("metadata"), "meta") => {
                        handle_legacy_cover_meta(e, &mut legacy_cover_id);
                        handle_calibre_meta(e, &mut metadata.series, &mut series_index_raw);
                    }
                    (Some("manifest"), "item") => {
                        insert_manifest_item(&mut manifest, e)?;
                    }
                    (Some("spine"), "itemref") => {
                        if let Some(idref) = handle_itemref(e) {
                            spine.push(idref);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let local = local_name(e.name().into_inner());
                match (section.as_deref(), local) {
                    (Some("metadata"), "meta") => {
                        handle_legacy_cover_meta(e, &mut legacy_cover_id);
                        handle_calibre_meta(e, &mut metadata.series, &mut series_index_raw);
                    }
                    (Some("manifest"), "item") => {
                        insert_manifest_item(&mut manifest, e)?;
                    }
                    (Some("spine"), "itemref") => {
                        if let Some(idref) = handle_itemref(e) {
                            spine.push(idref);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                if text_target.is_some() {
                    if let Ok(decoded) = t.unescape() {
                        text_buf.push_str(&decoded);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let local = local_name(e.name().into_inner());
                if let Some(target) = text_target.take() {
                    let value = text_buf.trim().to_string();
                    if !value.is_empty() {
                        match target {
                            "title" => metadata.title = value,
                            "creator" => metadata.authors.push(value),
                            "subject" => metadata.subjects.push(value),
                            "date" => {
                                if metadata.publication_date.is_none() {
                                    metadata.publication_date = Some(value);
                                }
                            }
                            "language" => metadata.language = Some(value),
                            "publisher" => metadata.publisher = Some(value),
                            "description" => metadata.description = Some(value),
                            "isbn" => metadata.isbn = Some(value),
                            _ => unreachable!("unknown text target"),
                        }
                    }
                    text_buf.clear();
                }
                if let Some(open) = section.as_deref() {
                    if open == local {
                        section = None;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(EpubError::OpfXml(err.to_string())),
            _ => {}
        }
    }

    // The flat author is the first creator; the list is the normalized truth.
    metadata.author = metadata.authors.first().cloned();
    if let Some(raw) = series_index_raw.as_deref().and_then(parse_series_index) {
        metadata.series_index = Some(raw);
    }

    if metadata.title.is_empty() {
        return Err(EpubError::MissingTitle);
    }

    Ok(OpfPackage {
        metadata,
        manifest,
        spine,
        legacy_cover_id,
    })
}

fn local_static(name: &str) -> &'static str {
    match name {
        "title" => "title",
        "creator" => "creator",
        "subject" => "subject",
        "date" => "date",
        "language" => "language",
        "publisher" => "publisher",
        "description" => "description",
        "isbn" => "isbn",
        _ => unreachable!("unknown metadata element {name}"),
    }
}

fn handle_legacy_cover_meta(
    e: &quick_xml::events::BytesStart<'_>,
    legacy_cover_id: &mut Option<String>,
) {
    let name = attribute(&e.attributes(), "name");
    let content = attribute(&e.attributes(), "content");
    if name.as_deref() == Some("cover") {
        if let Some(content) = content {
            *legacy_cover_id = Some(content);
        }
    }
}

/// Calibre writes its series through legacy `<meta>` elements:
/// `<meta name="calibre:series" content="..."/>` and
/// `<meta name="calibre:series_index" content="3"/>`. The index is kept raw
/// until the end of the parse so a missing/invalid value simply stays unset.
fn handle_calibre_meta(
    e: &quick_xml::events::BytesStart<'_>,
    series: &mut Option<String>,
    series_index_raw: &mut Option<String>,
) {
    let name = attribute(&e.attributes(), "name");
    let content = attribute(&e.attributes(), "content");
    match (name.as_deref(), content) {
        (Some("calibre:series"), Some(value)) => {
            let value = value.trim();
            if !value.is_empty() {
                *series = Some(value.to_string());
            }
        }
        (Some("calibre:series_index"), Some(value)) => {
            let value = value.trim();
            if !value.is_empty() {
                *series_index_raw = Some(value.to_string());
            }
        }
        _ => {}
    }
}

/// Series indexes are decimal numbers, sometimes written with a trailing
/// `.0` or a comma decimal separator.
fn parse_series_index(raw: &str) -> Option<f64> {
    raw.replace(',', ".").trim().parse::<f64>().ok()
}

fn insert_manifest_item(
    manifest: &mut HashMap<String, ManifestItem>,
    e: &quick_xml::events::BytesStart<'_>,
) -> Result<(), EpubError> {
    let id = attribute(&e.attributes(), "id")
        .ok_or_else(|| EpubError::ManifestItemWithoutHref("(no id)".to_string()))?;
    let href = attribute(&e.attributes(), "href")
        .ok_or_else(|| EpubError::ManifestItemWithoutHref(id.clone()))?;
    let media_type = attribute(&e.attributes(), "media-type").unwrap_or_default();
    let properties = attribute(&e.attributes(), "properties")
        .map(|p| p.split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    manifest.insert(
        id,
        ManifestItem {
            href,
            media_type,
            properties,
        },
    );
    Ok(())
}

fn handle_itemref(e: &quick_xml::events::BytesStart<'_>) -> Option<String> {
    attribute(&e.attributes(), "idref")
}

pub(crate) fn local_name(qname: &[u8]) -> &str {
    match qname.iter().rposition(|&b| b == b':') {
        Some(idx) => std::str::from_utf8(&qname[idx + 1..]).unwrap_or(""),
        None => std::str::from_utf8(qname).unwrap_or(""),
    }
}

pub(crate) fn attribute(
    attrs: &quick_xml::events::attributes::Attributes<'_>,
    name: &str,
) -> Option<String> {
    attrs.clone().flatten().find_map(|attr| {
        let key = local_name(attr.key.as_ref());
        if key.eq_ignore_ascii_case(name) {
            attr.unescape_value().ok().map(|v| v.to_string())
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:1234</dc:identifier>
    <dc:title>A Minimal Book</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:creator>Charles Babbage</dc:creator>
    <dc:subject>Computing</dc:subject>
    <dc:subject>Victorian science</dc:subject>
    <dc:date>1843</dc:date>
    <dc:language>en</dc:language>
    <dc:publisher>Tuxbooks Press</dc:publisher>
    <dc:description>A tiny EPUB used as a test fixture.</dc:description>
    <dc:identifier opf:scheme="ISBN" xmlns:opf="http://www.idpf.org/2007/opf">978-3-16-148410-0</dc:identifier>
    <meta name="cover" content="cover-image"/>
    <meta name="calibre:series" content="Analytical Engines"/>
    <meta name="calibre:series_index" content="2"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>"#;

    #[test]
    fn parses_all_metadata_fields() {
        let opf = parse_opf(MINIMAL_OPF).unwrap();
        assert_eq!(opf.metadata.title, "A Minimal Book");
        assert_eq!(opf.metadata.author.as_deref(), Some("Ada Lovelace"));
        assert_eq!(
            opf.metadata.authors,
            vec!["Ada Lovelace".to_string(), "Charles Babbage".to_string()]
        );
        assert_eq!(
            opf.metadata.subjects,
            vec!["Computing".to_string(), "Victorian science".to_string()]
        );
        assert_eq!(opf.metadata.publication_date.as_deref(), Some("1843"));
        assert_eq!(opf.metadata.language.as_deref(), Some("en"));
        assert_eq!(opf.metadata.publisher.as_deref(), Some("Tuxbooks Press"));
        assert_eq!(
            opf.metadata.description.as_deref(),
            Some("A tiny EPUB used as a test fixture.")
        );
        assert_eq!(opf.metadata.isbn.as_deref(), Some("978-3-16-148410-0"));
        assert_eq!(opf.metadata.series.as_deref(), Some("Analytical Engines"));
        assert_eq!(opf.metadata.series_index, Some(2.0));
    }

    #[test]
    fn calibre_series_fields_are_optional_and_tolerant() {
        let without = MINIMAL_OPF
            .replace(
                r#"<meta name="calibre:series" content="Analytical Engines"/>"#,
                "",
            )
            .replace(r#"<meta name="calibre:series_index" content="2"/>"#, "");
        let opf = parse_opf(&without).unwrap();
        assert_eq!(opf.metadata.series, None);
        assert_eq!(opf.metadata.series_index, None);

        // A non-numeric index is dropped, not an error.
        let odd = MINIMAL_OPF.replace(r#"content="2""#, r#"content="two""#);
        let opf = parse_opf(&odd).unwrap();
        assert_eq!(opf.metadata.series.as_deref(), Some("Analytical Engines"));
        assert_eq!(opf.metadata.series_index, None);

        // A comma decimal separator parses.
        let comma = MINIMAL_OPF.replace(r#"content="2""#, r#"content="2,5""#);
        let opf = parse_opf(&comma).unwrap();
        assert_eq!(opf.metadata.series_index, Some(2.5));
    }

    #[test]
    fn parses_manifest_and_spine() {
        let opf = parse_opf(MINIMAL_OPF).unwrap();
        assert_eq!(opf.spine, vec!["c1".to_string(), "c2".to_string()]);
        let c1 = opf.manifest.get("c1").unwrap();
        assert_eq!(c1.href, "chapter1.xhtml");
        assert_eq!(c1.media_type, "application/xhtml+xml");
        assert!(!c1.has_property("cover-image"));
        assert!(opf.manifest.get("nav").unwrap().has_property("nav"));
    }

    #[test]
    fn detects_legacy_epub2_cover_meta() {
        let opf = parse_opf(MINIMAL_OPF).unwrap();
        assert_eq!(opf.legacy_cover_id.as_deref(), Some("cover-image"));
    }

    #[test]
    fn missing_title_is_an_error() {
        let opf = MINIMAL_OPF.replace("<dc:title>A Minimal Book</dc:title>", "");
        let err = parse_opf(&opf).unwrap_err();
        assert!(matches!(err, EpubError::MissingTitle), "got: {err:?}");
    }

    #[test]
    fn malformed_xml_is_an_error() {
        let err = parse_opf("<package><metadata></metdata></package>").unwrap_err();
        assert!(matches!(err, EpubError::OpfXml(_)), "got: {err:?}");
    }

    #[test]
    fn html_entities_in_text_are_unescaped() {
        let opf = parse_opf(
            r#"<package version="3.0"><metadata><dc:title>A &amp; B</dc:title></metadata></package>"#,
        )
        .unwrap();
        assert_eq!(opf.metadata.title, "A & B");
    }
}
