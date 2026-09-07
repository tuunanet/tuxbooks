use base64::Engine;

use crate::error::AppError;
use crate::AppState;

/// Raw bytes of a stored book's source file, consumed by the frontend reader
/// engines (MuPDF.js for PDF, Readium for EPUB) via the `tuxbooks://`
/// protocol. An optional byte range backs HTTP-style Range requests so large
/// documents are read incrementally; with no range the whole file is served.
/// The response carries base64 data plus the file's total size and the
/// offset the slice starts at.
pub async fn get_book_bytes(
    state: &AppState,
    book_id: i64,
    offset: Option<u64>,
    length: Option<u64>,
) -> Result<GetBookBytesResult, AppError> {
    let (data, total) = match (offset, length) {
        (Some(offset), Some(length)) => {
            crate::services::reader::load_book_file_range(&state.db, book_id, offset, length)
                .await?
        }
        _ => {
            let bytes = crate::services::reader::load_book_file(&state.db, book_id).await?;
            let total = bytes.len() as u64;
            (bytes, total)
        }
    };
    Ok(GetBookBytesResult {
        data: base64::engine::general_purpose::STANDARD.encode(&data),
        offset: offset.unwrap_or(0),
        total,
    })
}

/// Wire shape of a (possibly ranged) book-bytes response.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetBookBytesResult {
    pub data: String,
    pub offset: u64,
    pub total: u64,
}
