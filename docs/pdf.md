# PDF layer

`src-tauri/src/pdf/` is a metadata-only PDF reader built on `lopdf` (pure
Rust, no rendering engine). Like `epub/`, it has no Tauri or SQLx imports
and returns owned data. The stated reason for the dependency: the scanner
must index real-world PDF libraries (title/author/subject) without pulling
in a renderer — page rendering stays out of scope until the PDF reader.

## Public API

```rust
pub fn parse_pdf(path: &Path) -> Result<PdfBook, PdfError>;

pub struct PdfBook {
    pub metadata: PdfMetadata,
}

pub struct PdfMetadata {
    pub title: String,              // /Title, or file-name fallback
    pub author: Option<String>,     // /Author
    pub description: Option<String> // /Subject (PDFs have no description field)
}
```

## Behavior

1. **Open** — `lopdf::Document::load`; structural failures (not a PDF,
   unrecoverable xref, unsupported encryption) are `PdfError::Parse`.
2. **Info dictionary** — resolved through the trailer (`/Info` may be an
   indirect reference). A missing Info dictionary is not an error.
3. **Strings** — UTF-16BE (with `FE FF` byte-order mark) and
   PDFDocEncoding/Latin-1 are both decoded, trimmed, never lossy-panicking.
4. **Title fallback** — a missing/empty `/Title` indexes the book under a
   humanized file name (underscores become spaces); titles are mandatory in
   the library schema.

## Import mapping

| PDF field  | Library column                                                       |
| ---------- | -------------------------------------------------------------------- |
| `/Title`   | `title` (file-name fallback)                                         |
| `/Author`  | `author`                                                             |
| `/Subject` | `description`                                                        |
| —          | `publisher`, `language`, `isbn` stay NULL                            |
| —          | `cover_path` stays NULL (no rendering; the UI shows placeholder art) |

## Error handling

Per-file failures never abort an import run: the importer collects them in
`ImportReport.failed` exactly like EPUB parse failures.
