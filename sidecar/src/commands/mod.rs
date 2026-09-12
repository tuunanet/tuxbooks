pub mod annotations;
pub mod books;
pub mod collections;
pub mod library;
pub mod metadata;
pub mod progress;
pub mod reader;

use crate::error::AppError;
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::LibraryChange;
use crate::AppState;

/// A command mutated a book row (metadata, cover, reading progress), so the
/// UI updates through the same `library-changed` channel the watcher and
/// remove/reconnect already use: refetch the row and push it as a `changed`
/// event so every view (grid, list, detail, search) patches in place.
pub(crate) async fn emit_book_changed(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
) -> Result<(), AppError> {
    if let Some(book) = crate::repository::books::get_book(&state.db, book_id).await? {
        events.emit(
            "library-changed",
            &LibraryChange::Changed {
                book: Box::new(book),
            },
        );
    }
    Ok(())
}
