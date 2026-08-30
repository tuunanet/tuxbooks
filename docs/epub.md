# EPUB layer

`src-tauri/src/epub/` is a small, dependency-light EPUB reader: `zip`

- `quick-xml` only. It has no Tauri or SQLx imports and returns owned
  data, so parsed values are cheap to move between threads and layers.

## Public API

```rust
pub fn parse_epub(path: &Path) -> Result<EpubBook, EpubError>;

pub struct EpubBook {
    pub metadata: EpubMetadata, // title, author, language, publisher, isbn, description
    pub spine: Vec<String>,     // manifest hrefs in reading order
    pub cover: Option<CoverImage>, // media_type + raw bytes
}
```

## Parsing stages

1. **Container validation** — first ZIP entry must be `mimetype` with
   exactly `application/epub+zip` (strict, no trimming).
2. **META-INF/container.xml** — first `<rootfile full-path=...>` is the
   OPF location; missing container or rootfile are typed errors.
3. **OPF (package document)** — single streaming pass collects:
   - `<dc:title/creator/language/publisher/description>` (namespace
     prefix agnostic, entities unescaped)
   - `<dc:identifier opf:scheme="ISBN">` for the ISBN
   - `<meta name="cover" content="id">` (EPUB2 legacy cover)
   - `<item id, href, media-type, properties>` manifest
   - `<itemref idref>` spine
4. **Reading order** — spine idrefs resolved through the manifest;
   unknown idref → `EpubError::BrokenSpine`.
5. **Cover** — EPUB3 `properties~="cover-image"` preferred, EPUB2
   `<meta name="cover">` fallback; bytes resolved relative to the OPF
   directory (handles `../`, `./`, and `%XX` escapes).

## Error handling

`EpubError` is an exhaustive enum (`MissingMimetype`, `InvalidMimetype`,
`MissingContainer`, `NoRootfile`, `MissingOpf`, `OpfXml`, `MissingTitle`,
`BrokenSpine`, `ManifestItemWithoutHref`, `Zip`, `Io`). Parsers never
panic on malformed input — a property test feeds arbitrary bytes through
`parse_epub`.

## Known limitations (intentional, for now)

- No page list, encryption.xml (DRM), or media-overlay support.
- Chapter contents are not extracted yet — only the spine hrefs.
- Cover bytes are held in memory during import (fine for typical
  covers; revisit if libraries grow very large).

## Fixture

All parser behavior is pinned by `tests/fixtures/books/minimal.epub`
(regenerate with `python3 scripts/make-fixture.py`; content is original,
license-free). Tests live in `epub/mod.rs`, `epub/metadata.rs`, and
`epub/parser.rs`.

## Planned evolution

`epub/` will grow `spine::document(href) -> Vec<u8>`-style content
access and pagination metadata for the reader; metadata extraction
stays exactly where it is.
