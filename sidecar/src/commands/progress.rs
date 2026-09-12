use serde::Deserialize;

use crate::commands::emit_book_changed;
use crate::domain::{ProgressUpdate, ReadingProgress};
use crate::error::AppError;
use crate::repository::reading_progress::{get_progress, mark_finished, upsert_progress};
use crate::rpc::EventEmitter;
use crate::AppState;

/// Wire shape of a reading-progress update. Fields are optional so each
/// format writes only what it tracks (EPUB: Readium locator columns, with
/// `cfi`/`chapterHref` kept as foliate-era provenance; PDF: page number);
/// `progressPercent` is the coarse shell position. The engine-locator
/// columns are preserved server-side when a save omits them.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressInput {
    pub chapter_href: Option<String>,
    pub cfi: Option<String>,
    pub character_offset: Option<i64>,
    pub page_number: Option<i64>,
    pub scroll_offset: Option<f64>,
    pub progress_percent: Option<f64>,
    pub locator: Option<String>,
    pub progression: Option<f64>,
    pub locations: Option<String>,
    pub engine: Option<String>,
    pub schema_version: Option<i64>,
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
            locator: input.locator,
            progression: input.progression,
            locations: input.locations,
            engine: input.engine,
            schema_version: input.schema_version,
        }
    }
}

/// Persist (upsert) where the user stopped reading a book. Emits
/// `library-changed` so the grid and list progress bars reflect the save
/// immediately — reading progress is exposed on the book row itself, so
/// without the event the UI stays stale until the next restart.
pub async fn save_reading_progress(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
    progress: ProgressInput,
) -> Result<(), AppError> {
    upsert_progress(&state.db, book_id, &progress.into()).await?;
    emit_book_changed(state, events, book_id).await
}

/// Load the stored reading position for a book, if any.
pub async fn get_reading_progress(
    state: &AppState,
    book_id: i64,
) -> Result<Option<ReadingProgress>, AppError> {
    get_progress(&state.db, book_id).await
}

/// Flag a book as finished (milestone 10). Sets `progress_percent = 100`
/// while preserving the stored position, so the book lands in the
/// "Finished" section but still resumes where reading stopped. Emits
/// `library-changed` so the section change is visible immediately.
pub async fn mark_book_finished(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
) -> Result<(), AppError> {
    mark_finished(&state.db, book_id).await?;
    emit_book_changed(state, events, book_id).await
}
