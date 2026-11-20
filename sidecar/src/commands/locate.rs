//! Locate File: reconnect a missing book, merge a lossless duplicate, or
//! report the conflict for the user to resolve.

use std::path::Path;

use crate::commands::emit_changed_book;
use crate::error::AppError;
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::LibraryChange;
use crate::services::locate_file::{self, LocateOutcome};
use crate::{covers_dir, pdfium_library_dirs, AppState};

pub async fn locate_book(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
    path: String,
) -> Result<LocateOutcome, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("book path is empty".into()));
    }
    let outcome = locate_file::locate_book(
        &state.db,
        book_id,
        Path::new(&path),
        &covers_dir(&state.db_path),
        &pdfium_library_dirs(),
    )
    .await?;
    match &outcome {
        LocateOutcome::Reconnected { book } => emit_changed_book(events, book.clone()),
        LocateOutcome::Merged { book, merged_from } => {
            events.emit(
                "library-changed",
                &LibraryChange::Removed {
                    book_id: merged_from.id,
                },
            );
            emit_changed_book(events, book.clone());
        }
        LocateOutcome::Detached { detached_from, .. } => {
            events.emit(
                "library-changed",
                &LibraryChange::Removed {
                    book_id: detached_from.id,
                },
            );
        }
        LocateOutcome::Conflict { .. } => {}
    }
    Ok(outcome)
}
