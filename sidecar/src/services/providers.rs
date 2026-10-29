use sqlx::SqlitePool;

use crate::domain::{ProgressUpdate, ProviderLink, ProviderReadingStatus};
use crate::error::AppError;
use crate::repository::providers;
use crate::repository::reading_progress::upsert_progress;

pub async fn link_book(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
    remote_id: &str,
) -> Result<ProviderLink, AppError> {
    let provider = provider.trim();
    let remote_id = remote_id.trim();
    if provider.is_empty() {
        return Err(AppError::InvalidInput("provider is empty".into()));
    }
    if remote_id.is_empty() {
        return Err(AppError::InvalidInput("remote id is empty".into()));
    }
    if let Some(owner) = providers::find_book_uid_by_remote(pool, provider, remote_id).await? {
        if owner != book_uid {
            return Err(AppError::InvalidInput(format!(
                "remote book {remote_id} is already linked to another TuxBooks book"
            )));
        }
    }
    providers::upsert_link(pool, book_uid, provider, remote_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn list_links(pool: &SqlitePool, book_uid: &str) -> Result<Vec<ProviderLink>, AppError> {
    providers::list_links(pool, book_uid).await
}

/// Unlink one provider. Called by Forget (ticket tuxbooks-ip6.7) before the
/// durable record goes away; it removes only local state, never the provider's
/// remote history.
pub async fn unlink_book(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
) -> Result<bool, AppError> {
    providers::delete_link(pool, book_uid, provider.trim()).await
}

/// Apply a status and/or progress value that came from the provider. The
/// remote status is cached on the link; progress lands in the same
/// `reading_progress` row the reader writes, so there is no second status
/// model (docs/PROVIDERS.md). A `finished` status sets 100% exactly like the
/// local "Mark as finished" action. This path never queues an outgoing
/// page-turn: it is not local reading activity.
pub async fn apply_remote_update(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
    status: Option<ProviderReadingStatus>,
    progress_percent: Option<f64>,
) -> Result<ProviderLink, AppError> {
    if status.is_none() && progress_percent.is_none() {
        return Err(AppError::InvalidInput(
            "remote update carries neither status nor progress".into(),
        ));
    }
    let provider = provider.trim();
    let link = providers::get_link(pool, book_uid, provider)
        .await?
        .ok_or(AppError::NotFound)?;

    let percent = match status {
        Some(status) if status.completes_book() => Some(100.0),
        _ => progress_percent,
    };
    if let Some(percent) = percent {
        let book_id = providers::book_id_for_uid(pool, book_uid)
            .await?
            .ok_or(AppError::NotFound)?;
        upsert_progress(
            pool,
            book_id,
            &ProgressUpdate {
                progress_percent: Some(percent),
                ..ProgressUpdate::default()
            },
        )
        .await?;
    }

    match status {
        Some(status) => providers::update_status(pool, book_uid, provider, status).await,
        None => Ok(link),
    }
}

/// Record one local page-turn for every linked provider. A book with no file
/// row is absent from the library, so there is nothing open to page through
/// and no update is queued.
pub async fn queue_page_turn(
    pool: &SqlitePool,
    book_id: i64,
    progress_percent: Option<f64>,
) -> Result<u64, AppError> {
    let Some(progress_percent) = progress_percent else {
        return Ok(0);
    };
    if !(0.0..=100.0).contains(&progress_percent) {
        return Err(AppError::InvalidInput(format!(
            "progress_percent {progress_percent} outside 0..=100"
        )));
    }
    providers::queue_progress_for_book(pool, book_id, progress_percent).await
}
