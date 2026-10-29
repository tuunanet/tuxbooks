use crate::domain::{ProviderLink, ProviderReadingStatus};
use crate::error::AppError;
use crate::services::providers;
use crate::AppState;

/// Read every provider link for one durable book.
pub async fn list_provider_links(
    state: &AppState,
    book_uid: String,
) -> Result<Vec<ProviderLink>, AppError> {
    providers::list_links(&state.db, &book_uid).await
}

/// Create or re-point a provider link for one durable book.
pub async fn link_provider_book(
    state: &AppState,
    book_uid: String,
    provider: String,
    remote_id: String,
) -> Result<ProviderLink, AppError> {
    providers::link_book(&state.db, &book_uid, &provider, &remote_id).await
}

/// Remove one provider link. The remote provider's own history is untouched.
pub async fn unlink_provider_book(
    state: &AppState,
    book_uid: String,
    provider: String,
) -> Result<bool, AppError> {
    providers::unlink_book(&state.db, &book_uid, &provider).await
}

/// Accept a provider-side reading status and/or progress update for a book
/// that may have no file. The update lands in durable state and never queues
/// an outgoing page-turn.
pub async fn apply_provider_reading_update(
    state: &AppState,
    book_uid: String,
    provider: String,
    status: Option<ProviderReadingStatus>,
    progress_percent: Option<f64>,
) -> Result<ProviderLink, AppError> {
    providers::apply_remote_update(&state.db, &book_uid, &provider, status, progress_percent).await
}
