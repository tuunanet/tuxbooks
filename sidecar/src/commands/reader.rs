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

/// The Readium reading session for a stored EPUB: the webpub manifest and
/// the positions list, parsed server-side (the renderer never touches ZIP
/// archives). Served as `manifest.json` / `positions.json` on the
/// publication base URL of the `tuxbooks://` protocol.
pub async fn get_epub_session(
    state: &AppState,
    book_id: i64,
) -> Result<GetEpubSessionResult, AppError> {
    let session = crate::services::reader::load_epub_session(&state.db, book_id).await?;
    let manifest = serde_json::from_str(&session.manifest_json)
        .map_err(|e| AppError::InvalidInput(format!("manifest is not valid JSON: {e}")))?;
    let positions = serde_json::from_str(&session.positions_json)
        .map_err(|e| AppError::InvalidInput(format!("positions are not valid JSON: {e}")))?;
    Ok(GetEpubSessionResult {
        manifest,
        positions,
    })
}

/// Wire shape of the EPUB reading session (deserialized RWPM + positions).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetEpubSessionResult {
    pub manifest: serde_json::Value,
    pub positions: serde_json::Value,
}

/// One EPUB ZIP member (chapter document, image, stylesheet, font) plus its
/// media type, consumed by the `tuxbooks://` protocol handler for the
/// per-resource requests the Readium navigator makes. An optional byte
/// range slices the decoded member; with no range the whole entry is served.
pub async fn get_book_resource(
    state: &AppState,
    book_id: i64,
    path: &str,
    offset: Option<u64>,
    length: Option<u64>,
) -> Result<GetBookResourceResult, AppError> {
    let (bytes, media_type) =
        crate::services::reader::load_book_resource(&state.db, book_id, path).await?;
    let total = bytes.len() as u64;
    let start = offset.unwrap_or(0).min(total);
    let end = match length {
        Some(length) => (start + length).min(total),
        None => total,
    };
    Ok(GetBookResourceResult {
        data: base64::engine::general_purpose::STANDARD
            .encode(&bytes[start as usize..end as usize]),
        offset: start,
        total,
        media_type: media_type.to_string(),
    })
}

/// Wire shape of a (possibly ranged) EPUB-resource response.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetBookResourceResult {
    pub data: String,
    pub offset: u64,
    pub total: u64,
    pub media_type: String,
}
