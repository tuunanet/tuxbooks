//! Trash listing and the restore-with-pick flow.

use crate::domain::{BookTrashEntry, RestoreMode, RestoreOutcome, RestoreStatus};
use crate::error::AppError;
use crate::repository::{books, lifecycle};
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::LibraryChange;
use crate::AppState;

/// Open forgotten books still inside the 30-day window.
pub async fn list_book_trash(state: &AppState) -> Result<Vec<BookTrashEntry>, AppError> {
    lifecycle::list_trash(&state.db).await
}

/// Restore a forgotten book, optionally with the file the user picked. The
/// pick is validated before anything is written — the file must exist and
/// parse, and its bytes must match one of the trash snapshot's content
/// hashes — so a failed pick leaves the trash entry untouched. When a
/// library book already owns the picked path, that book takes the
/// replacement's role, resolved from the path so a caller cannot name an
/// arbitrary book; otherwise the picked file is attached to the restored
/// record. Without a mode the backend restores silently when the replacement
/// holds none of the six kinds of user state and returns a conflict
/// otherwise; Replace, Keep, and Merge resolve it explicitly.
pub async fn restore_book(
    state: &AppState,
    events: &EventEmitter,
    trash_id: i64,
    mode: Option<RestoreMode>,
    picked_path: Option<String>,
) -> Result<RestoreOutcome, AppError> {
    let picked = match picked_path {
        Some(path) if path.trim().is_empty() => {
            return Err(AppError::InvalidInput("book path is empty".into()));
        }
        Some(path) => Some(validate_pick(&state.db, trash_id, std::path::Path::new(&path)).await?),
        None => None,
    };

    let outcome = lifecycle::restore(
        &state.db,
        trash_id,
        mode,
        picked.as_ref().and_then(|pick| pick.replacement),
    )
    .await?;
    // Announce removed ids, or one file stays on the grid twice (tuxbooks-jpj).
    for book_id in &outcome.replaced_book_ids {
        events.emit(
            "library-changed",
            &LibraryChange::Removed { book_id: *book_id },
        );
    }
    // A pick no library book owned attaches to the restored record, which
    // comes back detached; the card below must carry the new file.
    if outcome.status == RestoreStatus::Restored {
        if let (Some(pick), Some(book_id), Some(book_uid)) =
            (picked.as_ref(), outcome.book_id, outcome.book_uid.clone())
        {
            if pick.replacement.is_none() {
                attach_picked_file(state, book_id, &book_uid, pick).await?;
            }
        }
    }
    if let (RestoreStatus::Restored | RestoreStatus::Kept, Some(book_id)) =
        (&outcome.status, outcome.book_id)
    {
        if let Some(book) = books::get_book(&state.db, book_id).await? {
            crate::commands::emit_changed_book(events, book);
        } else {
            events.emit("library-changed", &LibraryChange::Removed { book_id });
        }
    }
    Ok(outcome)
}

/// A validated pick: the file to attach, and the library book that owns it,
/// when one does.
struct ValidatedPick {
    path: std::path::PathBuf,
    replacement: Option<i64>,
}

/// Validate a picked file before anything is written (tuxbooks-t9p.2). The
/// replacement is resolved from the path here, so a caller cannot name an
/// arbitrary book. A pick on an entry that is no longer restorable skips the
/// file checks; the restore call then reports NotFound and writes nothing.
async fn validate_pick(
    pool: &sqlx::SqlitePool,
    trash_id: i64,
    path: &std::path::Path,
) -> Result<ValidatedPick, AppError> {
    let pick = ValidatedPick {
        path: path.to_path_buf(),
        replacement: None,
    };
    let Some(aliases) = lifecycle::restore_aliases(pool, trash_id).await? else {
        return Ok(pick);
    };
    if !path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "no file exists at {}",
            path.display()
        )));
    }
    crate::services::library_scanner::parse_book(path).map_err(|err| {
        AppError::InvalidInput(format!("that file is not a readable book: {err}"))
    })?;
    let hashed_path = pick.path.clone();
    let hashed =
        tokio::task::spawn_blocking(move || crate::sync::identity::hash_file(&hashed_path))
            .await
            .map_err(|err| AppError::InvalidInput(format!("could not hash that file: {err}")))?
            .map_err(|err| AppError::InvalidInput(format!("could not read that file: {err}")))?;
    if !aliases.iter().any(|hash| hash == &hashed.0) {
        // Different bytes never merge (ADR 0019 D5); the lossless outcomes
        // are a later step (tuxbooks-t9p.3).
        return Err(AppError::InvalidInput(
            "those bytes do not match this book, so nothing was attached".into(),
        ));
    }
    let replacement = match books::find_file_id_by_path(pool, &path.to_string_lossy()).await? {
        Some(file_id) => books::durable_id_for_file(pool, file_id).await?,
        None => None,
    };
    Ok(ValidatedPick {
        replacement,
        ..pick
    })
}

/// Attach a validated pick to a freshly restored record. The strict relink
/// re-checks the bytes against the snapshot aliases restore re-upserted, so
/// a pick that passed validation cannot land on the wrong book.
async fn attach_picked_file(
    state: &AppState,
    book_id: i64,
    book_uid: &str,
    pick: &ValidatedPick,
) -> Result<(), AppError> {
    if books::has_file_rows(&state.db, book_uid).await? {
        return Ok(());
    }
    crate::services::library_reconciler::relink_book(
        &state.db,
        book_id,
        &pick.path,
        &crate::covers_dir(&state.db_path),
        &crate::pdfium_library_dirs(),
        Some(book_uid),
    )
    .await?;
    Ok(())
}
