pub mod parser;

pub use parser::{parse_pdf, PdfBook};

/// Errors that can occur while opening or parsing a PDF file.
#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a valid PDF: {0}")]
    Parse(String),
}
