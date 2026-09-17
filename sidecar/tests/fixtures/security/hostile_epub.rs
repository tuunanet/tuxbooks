//! Hostile EPUB corpus builders (issue #87, E/R invariants).
//!
//! Repo convention: hostile fixtures are generated at runtime, never
//! committed as binaries. This module is the shared loader for those
//! builders — included by `tests/security_corpus.rs` via `#[path]` and
//! reusable as fuzz seeds by #88. Every builder is deterministic (no
//! clock, fixed seeds) so a failing case reproduces byte for byte.

use std::io::Write as _;
use std::path::Path;

pub(crate) const MIMETYPE: &str = "application/epub+zip";

pub(crate) fn container_xml() -> String {
    r#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#
        .to_string()
}

pub(crate) fn opf(manifest_extra: &str, cover: bool) -> String {
    let cover_item = if cover {
        r#"<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>"#
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:corpus</dc:identifier>
    <dc:title>Hostile Corpus Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    {cover_item}
    {manifest_extra}
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>"#
    )
}

pub(crate) const CHAPTER: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>chapter text</p></body></html>"#;

/// Write a ZIP with deflate members, like the parser's own test helper.
pub(crate) fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    for (name, data) in entries {
        zip.start_file(name.clone(), zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
}

/// Deterministic pseudo-random byte stream (xorshift64): hostile members
/// must deflate badly (incompressible) without a dependency or clock.
pub(crate) struct Noise(u64);

impl Noise {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    pub(crate) fn next_byte(&mut self) -> u8 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 24) as u8
    }

    pub(crate) fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next_byte()).collect()
    }
}

pub(crate) fn epub_bytes(opf_xml: &str, chapter: &str) -> Vec<(String, Vec<u8>)> {
    vec![
        ("mimetype".to_string(), MIMETYPE.as_bytes().to_vec()),
        (
            "META-INF/container.xml".to_string(),
            container_xml().into_bytes(),
        ),
        ("content.opf".to_string(), opf_xml.as_bytes().to_vec()),
        ("chapter1.xhtml".to_string(), chapter.as_bytes().to_vec()),
    ]
}

/// E-1 fixture: a manifest item declaring a script media type (not in the
/// spine, so it ships a script resource without a scripted spine document).
pub(crate) fn scripted_manifest_item(path: &Path) {
    write_zip(
        path,
        &epub_bytes(
            &opf(
                r#"<item id="evil" href="evil.js" media-type="text/javascript"/>"#,
                false,
            ),
            CHAPTER,
        ),
    );
}

/// R-1 fixture: a cover member of incompressible noise, so its compressed
/// size far exceeds a small `max_compressed_member_bytes` while every other
/// quota passes.
pub(crate) fn incompressible_cover(path: &Path) {
    let noise = Noise::new(0x5EED_0001).bytes(4 << 10);
    let mut entries = epub_bytes(&opf("", true), CHAPTER);
    entries.push(("cover.png".to_string(), noise));
    write_zip(path, &entries);
}

/// R-1/E-5 fixture: members nested 200 directories deep — legal shapes that
/// must stay bounded, plus an over-long member name that must miss cleanly.
pub(crate) fn deep_paths(path: &Path) {
    let deep_dir = "d/".repeat(200);
    let mut entries = epub_bytes(&opf("", false), CHAPTER);
    entries.push((format!("{deep_dir}leaf.xhtml"), CHAPTER.as_bytes().to_vec()));
    write_zip(path, &entries);
}

pub(crate) fn deep_member_name() -> String {
    format!("{}leaf.xhtml", "d/".repeat(200))
}

/// R-1 fixture: a truncated archive (valid EPUB bytes cut mid central
/// directory).
pub(crate) fn truncated(path: &Path) {
    let mut entries = epub_bytes(&opf("", false), CHAPTER);
    entries.push(("filler.bin".to_string(), Noise::new(7).bytes(64)));
    let scratch = path.with_extension("full");
    write_zip(&scratch, &entries);
    let bytes = std::fs::read(&scratch).unwrap();
    let cut = bytes.len() * 3 / 5;
    std::fs::write(path, &bytes[..cut]).unwrap();
    let _ = std::fs::remove_file(&scratch);
}

/// R-1 fixture: a valid EPUB whose central-directory signature is corrupted.
pub(crate) fn corrupt_central_directory(path: &Path) {
    let mut entries = epub_bytes(&opf("", false), CHAPTER);
    entries.push(("filler.bin".to_string(), Noise::new(11).bytes(64)));
    let scratch = path.with_extension("full");
    write_zip(&scratch, &entries);
    let mut bytes = std::fs::read(&scratch).unwrap();
    let sig = [0x50u8, 0x4b, 0x01, 0x02];
    let pos = bytes
        .windows(4)
        .rposition(|w| w == sig)
        .expect("fixture must contain a central-directory signature");
    bytes[pos] = 0x51;
    std::fs::write(path, &bytes).unwrap();
    let _ = std::fs::remove_file(&scratch);
}

/// R-1 fixture: OPF carrying a billion-laughs style internal entity
/// expansion aimed at the title string.
pub(crate) fn entity_bomb(path: &Path) {
    let mut entities = String::from("<!ENTITY e0 \"AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD\">");
    for level in 1..8 {
        let refs = format!("&e{};", level - 1);
        entities.push_str(&format!("<!ENTITY e{level} \"{}\">", refs.repeat(10)));
    }
    let opf_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE package [{}]>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:corpus</dc:identifier>
    <dc:title>&e7;</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>"#,
        entities
    );
    write_zip(path, &epub_bytes(&opf_xml, CHAPTER));
}

/// E/R fixture: malformed cover image and font members (garbage bytes) that
/// must travel through the pipeline inert — extracted and served
/// byte-identically, never decoded or rewritten.
pub(crate) fn malformed_cover_and_font(path: &Path) -> (Vec<u8>, Vec<u8>) {
    let cover = Noise::new(0xBEEF).bytes(2 << 10);
    let font = Noise::new(0xF0AD).bytes(1 << 10);
    let opf_xml = opf(
        r#"<item id="font" href="evil.woff" media-type="font/woff"/>"#,
        true,
    );
    let mut entries = epub_bytes(&opf_xml, CHAPTER);
    entries.push(("cover.png".to_string(), cover.clone()));
    entries.push(("evil.woff".to_string(), font.clone()));
    write_zip(path, &entries);
    (cover, font)
}
