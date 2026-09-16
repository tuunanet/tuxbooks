//! PDF parsing and cover rendering are worker-internal (ADR 0001 D5): the
//! path-based entry points exist for tests and as thin wrappers over the
//! bytes-based cores, and services must reach parsing only through the
//! worker client (`worker::WorkerClient`), never these functions directly.

pub mod parser;
pub mod render;
pub mod writer;

pub use parser::{
    parse_pdf, parse_pdf_bytes, read_file_properties, read_file_properties_bytes, PdfBook,
    PdfMetadata,
};
pub use render::{render_first_page_cover, render_first_page_cover_bytes};
pub use writer::{rewrite_pdf_bytes, write_metadata};

/// Errors that can occur while opening or parsing a PDF file.
#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a valid PDF: {0}")]
    Parse(String),
    #[error("cover rendering failed: {0}")]
    Render(String),
    #[error("{0}")]
    Limit(#[from] crate::limits::LimitExceeded),
}
