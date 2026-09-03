pub mod parser;
pub mod render;

pub use parser::{parse_pdf, PdfBook};
pub use render::render_first_page_cover;

/// Errors that can occur while opening or parsing a PDF file.
#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a valid PDF: {0}")]
    Parse(String),
    #[error("cover rendering failed: {0}")]
    Render(String),
}
