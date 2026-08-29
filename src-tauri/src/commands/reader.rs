use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::repository::books;
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
