use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::repository::books;
use crate::services::reader::load_book_file;
use crate::AppState;

/// Reading-order table of contents for a stored book, derived from its EPUB spine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookToc {
    pub book_id: i64,
    pub title: String,
    pub chapters: Vec<String>,
}

#[tauri::command]
pub async fn get_book_toc(state: State<'_, AppState>, book_id: i64) -> Result<BookToc, AppError> {
    let book = books::get_book(&state.db, book_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let parsed = crate::epub::parse_epub(std::path::Path::new(&book.path))?;
    Ok(BookToc {
        book_id: book.id,
        title: book.title,
        chapters: parsed.spine,
    })
}

/// Raw bytes of a stored book's source file, consumed by the frontend reader
/// engines (PDF.js today, an EPUB engine later). Returned as an IPC raw byte
/// response — not a JSON array of numbers — so multi-megabyte documents cross
/// the boundary efficiently; `invoke` resolves to an `ArrayBuffer` on the JS
/// side.
#[tauri::command]
pub async fn get_book_bytes(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<tauri::ipc::Response, AppError> {
    let bytes = load_book_file(&state.db, book_id).await?;
    Ok(tauri::ipc::Response::new(bytes))
}
