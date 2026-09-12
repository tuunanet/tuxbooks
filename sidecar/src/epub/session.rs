//! Reading-session layer over EPUB files: everything the Readium renderer
//! needs when a book opens, and the bytes the `tuxbooks://` protocol serves
//! for it.
//!
//! - `build_session` produces the Readium Web Publication manifest (RWPM)
//!   and the positions list the `EpubNavigator` requires, from the same
//!   ZIP + OPF truth the import parser uses. Both are served as virtual
//!   resources (`manifest.json`, `positions.json`) on the publication base
//!   URL, so the renderer treats the stored EPUB exactly like any Readium
//!   webpub served over `tuxbooks://`.
//! - `read_member` extracts one ZIP entry by (decoded, normalized) path for
//!   the protocol handler (chapter documents, images, stylesheets, fonts).
//!
//! The renderer never touches ZIP archives (docs/ARCHITECTURE.md); all
//! publication parsing lives here, in Rust.

use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use super::metadata::{attribute, local_name, parse_opf, OpfPackage};
use super::parser::{
    normalize_path, parse_container_xml, percent_decode, read_entry, resolve_zip_path,
};
use super::EpubError;

/// Media type the Readium toolkit looks up to find the positions list.
pub const POSITIONS_MEDIA_TYPE: &str = "application/vnd.readium.position-list+json";

/// Normalized characters of chapter text per estimated position. Positions
/// are a coarse reading-progress surface (the shell's percent moves per
/// position), never a visual page claim; 128 characters keeps the percent
/// responsive on short chapters while bounding the list size on real books
/// (a 300k-character novel yields ~2.3k entries).
const CHARS_PER_POSITION: usize = 128;

/// A stored EPUB opened as a reading session: the manifest the navigator
/// consumes plus the positions list it cannot operate without
/// (navigator docs: "In the absence of a positions argument, EpubNavigator
/// will ... not operate").
#[derive(Debug, Clone, PartialEq)]
pub struct EpubReadingSession {
    /// Serialized RWPM (`application/webpub+json`).
    pub manifest_json: String,
    /// Serialized positions list (`POSITIONS_MEDIA_TYPE`).
    pub positions_json: String,
}

/// One spine entry in the session's href space.
#[derive(Debug, Clone, PartialEq)]
struct SpineEntry {
    /// Decoded zip-root path (member lookup key).
    zip_path: String,
    /// Percent-encoded zip-root path (RWPM href).
    encoded: String,
    media_type: String,
}

/// One table-of-contents entry. `href` is a percent-encoded zip-root path
/// (optionally carrying a `#fragment`), matching the RWPM href space.
#[derive(Debug, Clone, PartialEq)]
pub struct TocItem {
    pub label: String,
    pub href: String,
    pub children: Vec<TocItem>,
}

/// Build the reading session for an EPUB file: container → OPF → RWPM
/// manifest + estimated positions list.
pub fn build_session(path: &Path) -> Result<EpubReadingSession, EpubError> {
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

    let spine = resolve_spine_entries(&package, &opf_path)?;
    let toc = parse_toc(&mut zip, &opf_path, &package)?;

    let manifest_json = build_manifest_json(&package, &spine, &toc, &opf_xml)?;
    let positions_json = build_positions_json(&mut zip, &spine)?;

    Ok(EpubReadingSession {
        manifest_json,
        positions_json,
    })
}

/// Read one ZIP entry by path. The path must already be decoded;
/// `normalize_path` collapses `.`/`..`, so a member path can never traverse
/// above the archive root.
pub fn read_member(path: &Path, member: &str) -> Result<Option<Vec<u8>>, EpubError> {
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(BufReader::new(file))?;
    let member = normalize_path(member);
    if member.is_empty() {
        return Ok(None);
    }
    read_entry(&mut zip, &member)
}

/// Best-effort media type for a stored ZIP member, by extension. Frame
/// documents are parsed from the RWPM link's media type; this answers the
/// protocol's `content-type` for every other resource.
pub fn guess_member_media_type(member: &str) -> &'static str {
    let extension = member.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "xhtml" => "application/xhtml+xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "text/javascript",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ncx" => "application/x-dtbncx+xml",
        "opf" => "application/oebps-package+xml",
        "mp3" => "audio/mpeg",
        "mp4" | "m4v" => "video/mp4",
        "ogg" | "oga" => "audio/ogg",
        "ogv" => "video/ogg",
        "webm" => "video/webm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "xml" => "application/xml",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
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

fn resolve_spine_entries(
    package: &OpfPackage,
    opf_path: &str,
) -> Result<Vec<SpineEntry>, EpubError> {
    package
        .spine
        .iter()
        .map(|idref| {
            let item = package
                .manifest
                .get(idref)
                .ok_or_else(|| EpubError::BrokenSpine(idref.clone()))?;
            let zip_path = resolve_zip_path(opf_path, &item.href);
            Ok(SpineEntry {
                encoded: encoded_href(&zip_path),
                zip_path,
                media_type: item.media_type.clone(),
            })
        })
        .collect()
}

/// The RWPM href space: percent-encoded zip-root paths. OPF hrefs are
/// decoded to zip paths for lookups, then re-encoded byte by byte so every
/// manifest/positions/TOC href is a valid URL path against the publication
/// base (`tuxbooks://book/<id>/`).
fn encoded_href(decoded_zip_path: &str) -> String {
    let mut out = String::with_capacity(decoded_zip_path.len());
    for byte in decoded_zip_path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Split `path#fragment` (first `#` wins). Fragment-less input yields
/// `(path, None)`.
fn split_fragment(href: &str) -> (&str, Option<&str>) {
    match href.split_once('#') {
        Some((path, fragment)) => (path, Some(fragment)),
        None => (href, None),
    }
}

fn build_manifest_json(
    package: &OpfPackage,
    spine: &[SpineEntry],
    toc: &[TocItem],
    opf_xml: &str,
) -> Result<String, EpubError> {
    let metadata = &package.metadata;

    let authors: Vec<serde_json::Value> = metadata
        .authors
        .iter()
        .map(|author| serde_json::json!({ "name": author }))
        .collect();
    let languages: Vec<String> = metadata.language.iter().cloned().collect();

    let layout = detect_fixed_layout(opf_xml);
    let progression = detect_page_progression(opf_xml);

    let mut metadata_json = serde_json::json!({
        "title": metadata.title,
        "layout": if layout { "fixed" } else { "reflowable" },
    });
    if !authors.is_empty() {
        metadata_json["author"] = serde_json::Value::Array(authors);
    }
    if !languages.is_empty() {
        metadata_json["language"] = serde_json::json!(languages);
    }
    if let Some(isbn) = &metadata.isbn {
        metadata_json["identifier"] = serde_json::json!(isbn);
    }
    if let Some(publisher) = &metadata.publisher {
        metadata_json["publisher"] = serde_json::json!({ "name": publisher });
    }
    if let Some(description) = &metadata.description {
        metadata_json["description"] = serde_json::json!(description);
    }
    if let Some(date) = &metadata.publication_date {
        metadata_json["published"] = serde_json::json!(date);
    }
    if progression == "rtl" {
        metadata_json["readingProgression"] = serde_json::json!(progression);
    }

    let reading_order: Vec<serde_json::Value> = spine
        .iter()
        .map(|entry| {
            serde_json::json!({
                "href": entry.encoded,
                "type": entry.media_type,
            })
        })
        .collect();

    let manifest = serde_json::json!({
        "@context": "https://readium.org/webpub-manifest/context.jsonld",
        "metadata": metadata_json,
        "links": [
            {
                "rel": "self",
                "href": "manifest.json",
                "type": "application/webpub+json"
            },
            {
                "rel": "position",
                "href": "positions.json",
                "type": POSITIONS_MEDIA_TYPE
            }
        ],
        "readingOrder": reading_order,
        "toc": toc_json(toc),
    });

    serde_json::to_string(&manifest).map_err(|e| EpubError::OpfXml(e.to_string()))
}

fn toc_json(items: &[TocItem]) -> serde_json::Value {
    serde_json::Value::Array(
        items
            .iter()
            .map(|item| {
                let (path, fragment) = split_fragment(&item.href);
                let mut link = serde_json::json!({
                    "href": encoded_href(path),
                    "title": item.label,
                });
                if let Some(fragment) = fragment {
                    link["locations"] = serde_json::json!({ "fragments": [fragment] });
                }
                if !item.children.is_empty() {
                    link["children"] = toc_json(&item.children);
                }
                link
            })
            .collect(),
    )
}

/// Parse the EPUB 3 nav document (manifest `properties~="nav"`) or the
/// EPUB 2 NCX (`application/x-dtbncx+xml`, spine `toc` attribute) into the
/// RWPM `toc` tree. A book with neither reads without a TOC.
fn parse_toc<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    opf_path: &str,
    package: &OpfPackage,
) -> Result<Vec<TocItem>, EpubError> {
    if let Some(item) = package
        .manifest
        .values()
        .find(|item| item.has_property("nav"))
    {
        let nav_zip_path = resolve_zip_path(opf_path, &item.href);
        if let Some(bytes) = read_entry(zip, &nav_zip_path)? {
            let xml = String::from_utf8_lossy(&bytes).into_owned();
            return parse_nav_document(&xml, &nav_zip_path);
        }
    }

    let ncx_id = package.spine_toc.clone().or_else(|| {
        package
            .manifest
            .iter()
            .find(|(_, item)| item.media_type == "application/x-dtbncx+xml")
            .map(|(id, _)| id.clone())
    });
    if let Some(ncx_id) = ncx_id {
        if let Some(item) = package.manifest.get(&ncx_id) {
            let ncx_zip_path = resolve_zip_path(opf_path, &item.href);
            if let Some(bytes) = read_entry(zip, &ncx_zip_path)? {
                let xml = String::from_utf8_lossy(&bytes).into_owned();
                return parse_ncx_document(&xml, &ncx_zip_path);
            }
        }
    }

    Ok(Vec::new())
}

/// EPUB 3 navigation document: the `<nav epub:type="toc">` list (or, when
/// none is typed, the first `<nav>`), parsed as nested `ol > li > a` trees.
/// Other navs (landmarks, page-list) are ignored.
fn parse_nav_document(xml: &str, nav_zip_path: &str) -> Result<Vec<TocItem>, EpubError> {
    let nav_dir = match nav_zip_path.rfind('/') {
        Some(idx) => &nav_zip_path[..=idx],
        None => "",
    };

    #[derive(Debug)]
    enum Scope {
        Nav { is_toc: bool, items: Vec<TocItem> },
        Ol { items: Vec<TocItem> },
        Li { item: TocItem, label_done: bool },
    }

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut stack: Vec<Scope> = Vec::new();
    let mut finished: Vec<(bool, Vec<TocItem>)> = Vec::new();
    let mut text_buf = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let local = local_name(e.name().into_inner());
                match local {
                    "nav" => {
                        let is_toc = e
                            .attributes()
                            .clone()
                            .flatten()
                            .filter(|attr| local_name(attr.key.as_ref()) == "type")
                            .filter_map(|attr| attr.unescape_value().ok())
                            .any(|value| {
                                value
                                    .split_whitespace()
                                    .any(|token| token.eq_ignore_ascii_case("toc"))
                            });
                        stack.push(Scope::Nav {
                            is_toc,
                            items: Vec::new(),
                        });
                    }
                    "ol" if matches!(
                        stack.last(),
                        Some(Scope::Nav { .. }) | Some(Scope::Ol { .. }) | Some(Scope::Li { .. })
                    ) =>
                    {
                        stack.push(Scope::Ol { items: Vec::new() });
                    }
                    "li" if matches!(stack.last(), Some(Scope::Ol { .. })) => {
                        stack.push(Scope::Li {
                            item: TocItem {
                                label: String::new(),
                                href: String::new(),
                                children: Vec::new(),
                            },
                            label_done: false,
                        });
                    }
                    "a" | "span" if matches!(stack.last(), Some(Scope::Li { .. })) => {
                        if local == "a" {
                            if let Some(href) = attribute(&e.attributes(), "href") {
                                if let Some(Scope::Li { item, label_done }) = stack.last_mut() {
                                    if !*label_done {
                                        item.href = resolve_nav_href(nav_dir, &href);
                                    }
                                }
                            }
                        }
                        text_buf.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                if matches!(
                    stack.last(),
                    Some(Scope::Li {
                        label_done: false,
                        ..
                    })
                ) {
                    if let Ok(decoded) = t.unescape() {
                        text_buf.push_str(&decoded);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let local = local_name(e.name().into_inner());
                match local {
                    "a" | "span" => {
                        if let Some(Scope::Li { item, label_done }) = stack.last_mut() {
                            if !*label_done {
                                item.label = text_buf.trim().to_string();
                                *label_done = true;
                            }
                        }
                        text_buf.clear();
                    }
                    "li" => {
                        if let Some(Scope::Li { item, .. }) = stack.pop() {
                            if let Some(Scope::Ol { items }) = stack.last_mut() {
                                items.push(item);
                            }
                        }
                    }
                    "ol" => {
                        if let Some(Scope::Ol { items }) = stack.pop() {
                            if items.is_empty() {
                                continue;
                            }
                            // The enclosing scope is the li that opened this
                            // nested list, or the nav itself for the top-level
                            // toc list.
                            match stack.last_mut() {
                                Some(Scope::Li { item, .. }) => item.children = items,
                                Some(Scope::Nav {
                                    items: nav_items, ..
                                }) => nav_items.extend(items),
                                _ => {}
                            }
                        }
                    }
                    "nav" => {
                        if let Some(Scope::Nav { is_toc, items }) = stack.pop() {
                            finished.push((is_toc, items));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(EpubError::OpfXml(err.to_string())),
            _ => {}
        }
    }

    // Prefer the toc-typed nav; fall back to the first nav on the page.
    let selected = finished
        .iter()
        .find(|(is_toc, items)| *is_toc && !items.is_empty())
        .or_else(|| finished.iter().find(|(_, items)| !items.is_empty()))
        .map(|(_, items)| items.clone());
    Ok(selected.unwrap_or_default())
}

/// EPUB 2 NCX table of contents: `navMap > navPoint > (navLabel > text,
/// content[src])`, nested `navPoint` children.
fn parse_ncx_document(xml: &str, ncx_zip_path: &str) -> Result<Vec<TocItem>, EpubError> {
    let ncx_dir = match ncx_zip_path.rfind('/') {
        Some(idx) => &ncx_zip_path[..=idx],
        None => "",
    };

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut roots: Vec<TocItem> = Vec::new();
    // Open navPoints, outermost first; each closing navPoint completes one.
    let mut open_points: Vec<TocItem> = Vec::new();
    let mut text_buf = String::new();
    let mut in_nav_label = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = local_name(e.name().into_inner());
                match local {
                    "navPoint" => {
                        open_points.push(TocItem {
                            label: String::new(),
                            href: String::new(),
                            children: Vec::new(),
                        });
                    }
                    "navLabel" => in_nav_label = true,
                    "content" => {
                        if let Some(point) = open_points.last_mut() {
                            if let Some(src) = attribute(&e.attributes(), "src") {
                                point.href = resolve_nav_href(ncx_dir, &src);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                if in_nav_label {
                    if let Ok(decoded) = t.unescape() {
                        text_buf.push_str(&decoded);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let local = local_name(e.name().into_inner());
                match local {
                    "navLabel" => {
                        in_nav_label = false;
                        if let Some(point) = open_points.last_mut() {
                            point.label = text_buf.trim().to_string();
                        }
                        text_buf.clear();
                    }
                    "navPoint" => {
                        if let Some(point) = open_points.pop() {
                            match open_points.last_mut() {
                                Some(parent) => parent.children.push(point),
                                None => roots.push(point),
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(EpubError::OpfXml(err.to_string())),
            _ => {}
        }
    }

    Ok(roots)
}

/// Resolve a TOC href (relative to the nav/NCX document, percent-encoded,
/// optionally `#fragment`) to the RWPM href space: a decoded zip path with
/// the fragment re-attached.
fn resolve_nav_href(base_dir: &str, href: &str) -> String {
    let (path, fragment) = split_fragment(href);
    let decoded = percent_decode(path);
    let zip_path = if decoded.starts_with('/') {
        normalize_path(&decoded)
    } else {
        normalize_path(&format!("{base_dir}{decoded}"))
    };
    match fragment {
        Some(fragment) => format!("{zip_path}#{fragment}"),
        None => zip_path,
    }
}

/// True when the OPF declares the fixed-layout rendition
/// (`meta property="rendition:layout" > pre-paginated`, or EPUB 3.2's
/// per-itemref `layout="pre-paginated"` on every spine item).
fn detect_fixed_layout(opf_xml: &str) -> bool {
    let mut reader = Reader::from_str(opf_xml);
    reader.config_mut().trim_text(true);

    let mut capturing_rendition_meta = false;
    let mut rendition_layout: Option<String> = None;
    let mut itemref_count = 0usize;
    let mut prepaginated_count = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = local_name(e.name().into_inner());
                match local {
                    "meta" => {
                        let property = attribute(&e.attributes(), "property");
                        if property.as_deref() == Some("rendition:layout") {
                            if let Some(content) = attribute(&e.attributes(), "content") {
                                rendition_layout = Some(content.trim().to_string());
                            } else {
                                capturing_rendition_meta = true;
                            }
                        }
                    }
                    "itemref" => {
                        itemref_count += 1;
                        if attribute(&e.attributes(), "layout").as_deref() == Some("pre-paginated")
                        {
                            prepaginated_count += 1;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                if capturing_rendition_meta {
                    if let Ok(value) = t.unescape() {
                        rendition_layout = Some(value.trim().to_string());
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if local_name(e.name().into_inner()) == "meta" {
                    capturing_rendition_meta = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    rendition_layout.as_deref() == Some("pre-paginated")
        || (itemref_count > 0 && prepaginated_count == itemref_count)
}

/// The spine's declared page progression (`page-progression-direction`).
fn detect_page_progression(opf_xml: &str) -> &'static str {
    let mut reader = Reader::from_str(opf_xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                if local_name(e.name().into_inner()) == "spine" {
                    if let Some(direction) =
                        attribute(&e.attributes(), "page-progression-direction")
                    {
                        if direction.eq_ignore_ascii_case("rtl") {
                            return "rtl";
                        }
                    }
                    return "ltr";
                }
            }
            Ok(Event::Eof) => return "ltr",
            Err(_) => return "ltr",
            _ => {}
        }
    }
}

/// Estimated positions list for the whole publication: per spine item, one
/// position per ~`CHARS_PER_POSITION` normalized characters of text
/// (non-text items get a single position). `position` counts through the
/// book (1-based), `progression` is the fraction within the item,
/// `totalProgression` the fraction through the whole book.
fn build_positions_json<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    spine: &[SpineEntry],
) -> Result<String, EpubError> {
    let mut item_texts: Vec<(String, usize)> = Vec::with_capacity(spine.len());
    for entry in spine {
        let chars =
            if entry.media_type == "application/xhtml+xml" || entry.media_type == "text/html" {
                match read_entry(zip, &entry.zip_path)? {
                    Some(bytes) => extract_visible_text(&String::from_utf8_lossy(&bytes))
                        .chars()
                        .count(),
                    None => 0,
                }
            } else {
                0
            };
        item_texts.push((entry.encoded.clone(), chars));
    }

    let total_chars: usize = item_texts.iter().map(|(_, chars)| *chars).sum();
    let total_chars = total_chars.max(1);
    let mut cumulative_chars = 0usize;
    let mut positions: Vec<serde_json::Value> = Vec::new();

    for (index, (href, item_chars)) in item_texts.iter().enumerate() {
        let is_last_item = index + 1 == item_texts.len();
        for start in position_boundaries(*item_chars) {
            let progression = if *item_chars == 0 {
                0.0
            } else {
                start as f64 / *item_chars as f64
            };
            let consumed = (progression * *item_chars as f64) as usize;
            // The book's final position always reports the end, so reaching
            // it displays 100% regardless of where the last window starts.
            let total = if is_last_item && start + CHARS_PER_POSITION >= *item_chars {
                1.0
            } else {
                clamp01((cumulative_chars + consumed) as f64 / total_chars as f64)
            };
            positions.push(serde_json::json!({
                "href": href,
                "locations": {
                    "position": positions.len() + 1,
                    "progression": clamp01(progression),
                    "totalProgression": total,
                }
            }));
        }
        cumulative_chars += item_chars;
    }

    let list = serde_json::json!({ "positions": positions, "total": positions.len() });
    serde_json::to_string(&list).map_err(|e| EpubError::OpfXml(e.to_string()))
}

/// Chunk start indexes for one chapter's text: one chunk per
/// ~CHARS_PER_POSITION characters. An empty chapter yields `[0]` (a single
/// start-of-item position).
fn position_boundaries(char_count: usize) -> Vec<usize> {
    if char_count == 0 {
        return vec![0];
    }
    let mut boundaries = vec![0usize];
    let mut next = CHARS_PER_POSITION;
    while next < char_count {
        boundaries.push(next);
        next += CHARS_PER_POSITION;
    }
    boundaries
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

/// Visible text of an XHTML document: everything outside `head`, `title`,
/// `style`, and `script`, entities unescaped, whitespace collapsed.
fn extract_visible_text(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut out = String::new();
    // Depth of the currently-open skipped subtree (head/title/style/script).
    let mut skip_depth = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                if skip_depth > 0 || is_skipped_element(local_name(e.name().into_inner())) {
                    skip_depth += 1;
                }
            }
            Ok(Event::Text(ref t)) => {
                if skip_depth == 0 {
                    if let Ok(decoded) = t.unescape() {
                        for word in decoded.split_whitespace() {
                            if !out.is_empty() {
                                out.push(' ');
                            }
                            out.push_str(word);
                        }
                    }
                }
            }
            Ok(Event::End(ref _e)) => {
                skip_depth = skip_depth.saturating_sub(1);
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    out
}

fn is_skipped_element(name: &str) -> bool {
    matches!(name, "head" | "title" | "style" | "script")
}

#[cfg(test)]
mod tests {
    use super::super::parser::tests_support::write_zip;
    use super::*;

    const OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:x</dc:identifier>
    <dc:title>Session Book</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"#;

    const NAV: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="landmarks"><ol><li><a href="chapter1.xhtml">Begin</a></li></ol></nav>
    <nav epub:type="toc">
      <ol>
        <li><a href="chapter1.xhtml">One</a></li>
        <li><a href="chapter2.xhtml">Two</a>
          <ol><li><a href="chapter2.xhtml#part">Part</a></li></ol>
        </li>
      </ol>
    </nav>
  </body>
</html>"#;

    fn long_chapter(label: &str, paragraphs: usize) -> String {
        let body: String = (0..paragraphs)
            .map(|i| format!("<p>{label} paragraph {i} with several words of text.</p>"))
            .collect();
        format!("<html><head><title>{label}</title></head><body>{body}</body></html>")
    }

    fn container() -> &'static [u8] {
        br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#
    }

    fn session_book() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("session.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", container()),
                ("content.opf", OPF.as_bytes()),
                ("nav.xhtml", NAV.as_bytes()),
                ("chapter1.xhtml", long_chapter("One", 40).as_bytes()),
                ("chapter2.xhtml", long_chapter("Two", 80).as_bytes()),
            ],
        );
        (tmp, path)
    }

    #[test]
    fn builds_manifest_with_reading_order_and_toc() {
        let (_tmp, path) = session_book();
        let session = build_session(&path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&session.manifest_json).unwrap();

        assert_eq!(manifest["metadata"]["title"], "Session Book");
        assert_eq!(manifest["metadata"]["layout"], "reflowable");
        assert_eq!(manifest["metadata"]["author"][0]["name"], "Ada Lovelace");
        assert_eq!(manifest["metadata"]["language"][0], "en");
        let order = manifest["readingOrder"].as_array().unwrap();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0]["href"], "chapter1.xhtml");
        assert_eq!(order[0]["type"], "application/xhtml+xml");

        let toc = manifest["toc"].as_array().unwrap();
        assert_eq!(
            toc.len(),
            2,
            "landmarks nav must be skipped for the toc nav"
        );
        assert_eq!(toc[0]["title"], "One");
        assert_eq!(toc[1]["title"], "Two");
        assert_eq!(toc[1]["children"][0]["title"], "Part");
        assert_eq!(toc[1]["children"][0]["href"], "chapter2.xhtml");
        assert_eq!(toc[1]["children"][0]["locations"]["fragments"][0], "part");

        let links = manifest["links"].as_array().unwrap();
        assert!(links
            .iter()
            .any(|link| link["type"] == POSITIONS_MEDIA_TYPE && link["href"] == "positions.json"));
    }

    #[test]
    fn builds_positions_across_spine() {
        let (_tmp, path) = session_book();
        let session = build_session(&path).unwrap();
        let list: serde_json::Value = serde_json::from_str(&session.positions_json).unwrap();

        let positions = list["positions"].as_array().unwrap();
        assert_eq!(list["total"], positions.len());
        assert!(
            positions.len() >= 3,
            "two long chapters must yield positions"
        );

        assert_eq!(positions[0]["href"], "chapter1.xhtml");
        assert_eq!(positions[0]["locations"]["position"], 1);
        assert_eq!(positions[0]["locations"]["progression"], 0.0);
        assert_eq!(positions[0]["locations"]["totalProgression"], 0.0);
        let last = positions.last().unwrap();
        assert_eq!(last["href"], "chapter2.xhtml");
        let total = last["locations"]["totalProgression"].as_f64().unwrap();
        assert!((total - 1.0).abs() < 1e-9, "last totalProgression {total}");
        for window in positions.windows(2) {
            let a = window[0]["locations"]["totalProgression"].as_f64().unwrap();
            let b = window[1]["locations"]["totalProgression"].as_f64().unwrap();
            assert!(b >= a, "positions must be ordered: {a} then {b}");
        }
        let second = positions[1]["locations"]["totalProgression"]
            .as_f64()
            .unwrap();
        assert!(second > 0.0 && second < 1.0, "mid-book position {second}");
    }

    #[test]
    fn manifest_href_space_is_percent_encoded() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("enc.epub");
        let opf = OPF
            .replace(
                r#"href="chapter1.xhtml""#,
                r#"href="ch%20apters/chapter1.xhtml""#,
            )
            .replace(
                r#"href="chapter2.xhtml""#,
                r#"href="ch%20apters/chapter2.xhtml""#,
            );
        let nav = NAV.replace("chapter1.xhtml", "../ch%20apters/chapter1.xhtml");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", container()),
                ("content.opf", opf.as_bytes()),
                ("nav.xhtml", nav.as_bytes()),
                (
                    "ch apters/chapter1.xhtml",
                    b"<html><body>one</body></html>".as_slice(),
                ),
                (
                    "ch apters/chapter2.xhtml",
                    b"<html><body>two</body></html>".as_slice(),
                ),
            ],
        );
        let session = build_session(&path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&session.manifest_json).unwrap();
        assert_eq!(
            manifest["readingOrder"][0]["href"],
            "ch%20apters/chapter1.xhtml"
        );
        let toc = manifest["toc"].as_array().unwrap();
        assert_eq!(toc[0]["href"], "ch%20apters/chapter1.xhtml");
    }

    #[test]
    fn fixed_layout_is_detected_from_rendition_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fxl.epub");
        let opf = OPF.replace(
            "<dc:language>en</dc:language>",
            "<dc:language>en</dc:language><meta property=\"rendition:layout\">pre-paginated</meta>",
        );
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", container()),
                ("content.opf", opf.as_bytes()),
                ("nav.xhtml", NAV.as_bytes()),
                ("chapter1.xhtml", b"<html><body>x</body></html>".as_slice()),
                ("chapter2.xhtml", b"<html><body>y</body></html>".as_slice()),
            ],
        );
        let session = build_session(&path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&session.manifest_json).unwrap();
        assert_eq!(manifest["metadata"]["layout"], "fixed");
    }

    #[test]
    fn reads_members_by_decoded_path() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("members.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "OEBPS/chapter1.xhtml",
                    b"<html><body>hi</body></html>".as_slice(),
                ),
                ("OEBPS/img/pic.png", &[0x89u8, b'P', b'N', b'G', 0x0D]),
            ],
        );
        assert_eq!(
            read_member(&path, "OEBPS/chapter1.xhtml").unwrap().unwrap(),
            b"<html><body>hi</body></html>"
        );
        let png = read_member(&path, "OEBPS/img/pic.png").unwrap().unwrap();
        assert_eq!(&png[..4], &[0x89, b'P', b'N', b'G']);
        // Traversal collapses to the root and misses instead of escaping.
        assert!(read_member(&path, "../etc/passwd").unwrap().is_none());
        assert!(read_member(&path, "OEBPS/missing.xhtml").unwrap().is_none());
    }

    #[test]
    fn media_type_guesses_cover_the_common_set() {
        assert_eq!(
            guess_member_media_type("a/b/c.xhtml"),
            "application/xhtml+xml"
        );
        assert_eq!(guess_member_media_type("style.CSS"), "text/css");
        assert_eq!(guess_member_media_type("font.woff2"), "font/woff2");
        assert_eq!(
            guess_member_media_type("data.bin"),
            "application/octet-stream"
        );
    }

    #[test]
    fn visible_text_excludes_head_and_scripts() {
        let xml = r#"<html><head><title>Do not leak</title><style>p { color: red }</style></head>
            <body><p>Hello   world</p><script>ignored()</script><p>Second &amp; last</p></body></html>"#;
        assert_eq!(extract_visible_text(xml), "Hello world Second & last");
    }

    #[test]
    fn ncx_toc_parses_for_epub2_books() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("epub2.epub");
        let opf = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Legacy</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>"#;
        let ncx = r#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="p1"><navLabel><text>First</text></navLabel><content src="c1.xhtml"/>
      <navPoint id="p2"><navLabel><text>Nested</text></navLabel><content src="c1.xhtml#sec"/></navPoint>
    </navPoint>
  </navMap>
</ncx>"#;
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", container()),
                ("content.opf", opf.as_bytes()),
                ("toc.ncx", ncx.as_bytes()),
                ("c1.xhtml", b"<html><body>c</body></html>".as_slice()),
            ],
        );
        let session = build_session(&path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&session.manifest_json).unwrap();
        let toc = manifest["toc"].as_array().unwrap();
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0]["title"], "First");
        assert_eq!(toc[0]["children"][0]["title"], "Nested");
        assert_eq!(toc[0]["children"][0]["href"], "c1.xhtml");
        assert_eq!(toc[0]["children"][0]["locations"]["fragments"][0], "sec");
    }

    #[test]
    fn books_without_toc_documents_read_without_a_toc() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("notoc.epub");
        let opf = OPF
            .replace(
                r#"    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
"#,
                "",
            )
            .replace(r#"<spine><itemref idref="c1"/><itemref idref="c2"/></spine>"#,
                r#"<spine><itemref idref="c1"/></spine>"#);
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", container()),
                ("content.opf", opf.as_bytes()),
                (
                    "chapter1.xhtml",
                    b"<html><body>one</body></html>".as_slice(),
                ),
            ],
        );
        let session = build_session(&path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&session.manifest_json).unwrap();
        assert_eq!(manifest["toc"].as_array().unwrap().len(), 0);
        let list: serde_json::Value = serde_json::from_str(&session.positions_json).unwrap();
        assert_eq!(
            list["total"], 1,
            "a text-less chapter still yields one position"
        );
    }

    proptest::proptest! {
        #[test]
        fn session_never_panics_on_arbitrary_bytes(data in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..4096)) {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("fuzz.epub");
            std::fs::write(&path, &data).unwrap();
            let _ = build_session(&path);
        }
    }
}
