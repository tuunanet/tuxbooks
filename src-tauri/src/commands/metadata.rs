use tauri::{Emitter, State};

use crate::domain::{Book, BookMetadata, MetadataFields};
use crate::error::AppError;
use crate::services::library_reconciler::LibraryChange;
use crate::services::metadata as service;
use crate::AppState;

/// The full curation view of a book: effective metadata (what every reader
/// path shows), untouched source-file values, and which fields carry user
/// overrides. `None` for unknown ids.
#[tauri::command]
pub async fn get_book_metadata(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<Option<BookMetadata>, AppError> {
    service::get_book_metadata(&state.db, book_id).await
}

/// Save the metadata edit form. Only fields that differ from the source file
/// become overrides — the source files are never rewritten (milestone 7).
/// Emits `library-changed` so the library grid, detail view, and search
/// reflect the edited values immediately.
#[tauri::command]
pub async fn update_book_metadata(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    book_id: i64,
    form: MetadataFields,
) -> Result<BookMetadata, AppError> {
    let view = service::update_book_metadata(&state.db, book_id, &form).await?;
    emit_changed(&app, &state, book_id).await?;
    Ok(view)
}

/// Drop every override: the book returns to exactly its source-file
/// metadata. Emits `library-changed`.
#[tauri::command]
pub async fn reset_book_metadata(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<BookMetadata, AppError> {
    let view = service::reset_book_metadata(&state.db, book_id).await?;
    emit_changed(&app, &state, book_id).await?;
    Ok(view)
}

/// Replace a book's cover with a user-picked image. The bytes are copied
/// into the artwork cache; the override survives re-imports and the source
/// file is never touched. Emits `library-changed`.
#[tauri::command]
pub async fn set_book_cover(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    book_id: i64,
    image_path: String,
) -> Result<Book, AppError> {
    let covers = crate::covers_dir(&state.db_path);
    let book = service::set_book_cover(&state.db, book_id, &image_path, &covers).await?;
    emit_changed(&app, &state, book_id).await?;
    Ok(book)
}

/// Remove a cover override; the extracted (source) cover returns.
/// Emits `library-changed`.
#[tauri::command]
pub async fn clear_book_cover_override(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<Book, AppError> {
    let book = service::clear_book_cover_override(&state.db, book_id).await?;
    emit_changed(&app, &state, book_id).await?;
    Ok(book)
}

/// Metadata edits mutate the book row, so the UI updates through the same
/// `library-changed` channel the watcher and remove/reconnect already use.
async fn emit_changed(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    book_id: i64,
) -> Result<(), AppError> {
    if let Some(book) = crate::repository::books::get_book(&state.db, book_id).await? {
        let _ignored = app.emit(
            "library-changed",
            LibraryChange::Changed {
                book: Box::new(book),
            },
        );
    }
    Ok(())
}
