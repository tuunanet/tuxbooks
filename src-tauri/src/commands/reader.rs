use tauri::State;

use crate::error::AppError;
use crate::services::reader::load_book_file;
use crate::AppState;

/// Raw bytes of a stored book's source file, consumed by the frontend reader
/// engines (PDF.js for PDF, foliate-js for EPUB). Returned as an IPC raw byte
/// response — not a JSON array of numbers — so multi-megabyte documents cross
/// the boundary efficiently; `invoke` resolves to an `ArrayBuffer` on the JS
/// side. Document structure (TOC, metadata) is parsed engine-side from these
/// bytes.
#[tauri::command]
pub async fn get_book_bytes(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<tauri::ipc::Response, AppError> {
    let bytes = load_book_file(&state.db, book_id).await?;
    Ok(tauri::ipc::Response::new(bytes))
}
