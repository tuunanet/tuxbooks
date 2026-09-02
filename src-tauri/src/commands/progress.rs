use serde::Deserialize;
use tauri::State;

use crate::domain::{ProgressUpdate, ReadingProgress};
use crate::error::AppError;
use crate::repository::reading_progress::{get_progress, upsert_progress};
use crate::AppState;

/// Wire shape of a reading-progress update. Fields are optional so each
/// format writes only what it tracks (EPUB: chapter href + CFI; PDF: page
/// number); `progress_percent` is the coarse shell position.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressInput {
    pub chapter_href: Option<String>,
    pub cfi: Option<String>,
    pub character_offset: Option<i64>,
    pub page_number: Option<i64>,
    pub scroll_offset: Option<f64>,
    pub progress_percent: Option<f64>,
}

impl From<ProgressInput> for ProgressUpdate {
    fn from(input: ProgressInput) -> Self {
        ProgressUpdate {
            chapter_href: input.chapter_href,
            cfi: input.cfi,
            character_offset: input.character_offset,
            page_number: input.page_number,
            scroll_offset: input.scroll_offset,
            progress_percent: input.progress_percent,
        }
    }
}

/// Persist (upsert) where the user stopped reading a book.
#[tauri::command]
pub async fn save_reading_progress(
    state: State<'_, AppState>,
    book_id: i64,
    progress: ProgressInput,
) -> Result<(), AppError> {
    upsert_progress(&state.db, book_id, &progress.into()).await
}

/// Load the stored reading position for a book, if any.
#[tauri::command]
pub async fn get_reading_progress(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<Option<ReadingProgress>, AppError> {
    get_progress(&state.db, book_id).await
}
