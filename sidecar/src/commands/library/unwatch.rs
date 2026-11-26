//! The unwatch purge: cancel in-flight scans, delete owned file rows
//! reader-last, and report progress in batches.

use std::path::PathBuf;
use std::time::Instant;

use super::{EVENT_BATCH_BOOKS, EVENT_BATCH_WINDOW_MS};
use crate::commands::books::delete_file_row_and_notify;
use crate::error::AppError;
use crate::repository::{books, library_locations};
use crate::rpc::EventEmitter;
use crate::{covers_dir, AppState};

/// Wire shape of one `unwatch-progress` event: `removed` books are gone out
/// of the `total` the dialog promised to remove.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnwatchProgress {
    removed: usize,
    total: usize,
}

/// Releases the roots an unwatch blocked, on every exit path. A scan that
/// overlaps one of them keeps failing to start until the purge is over.
struct UnwatchBlockGuard {
    importing: crate::ImportRegistry,
    roots: Vec<String>,
}

impl Drop for UnwatchBlockGuard {
    fn drop(&mut self) {
        self.importing.clear_blocking(&self.roots);
    }
}

/// Unwatch one or more folders: the rows leave the watch list, every file row
/// the folders own loses its library membership, and the filesystem watcher
/// stops observing those paths. Reading progress and annotations belong to
/// the durable book (ADR 0014), so they stay and return when the same bytes
/// are imported again. Every membership change announces itself through the
/// existing `library-changed` event so the library view updates without a
/// restart. Batched `unwatch-progress` events report how many of the promised
/// books are gone while the purge runs; the artwork cache is swept once at
/// the end instead of once per book. Files on disk are never touched. A folder
/// whose import is still running is cancelled first and the purge waits for
/// the scan to stop, so no book can land after the unwatch. Returns how many
/// folders were actually listed.
///
/// Per book the doomed rows are deleted unavailable-first, reader's-copy-last
/// (tuxbooks-t9p.1): a single-row delete remembers the path only when it
/// empties the book, so folder order must not decide which copy is remembered.
///
/// A folder inside another watched folder is refused (ADR 0010). The folder
/// above watches the whole subtree recursively, and the watch list is kept
/// flat, so the settings view never offers such a path; this refuses the case
/// for a caller that reaches the command directly.
pub async fn unwatch_locations(
    state: &AppState,
    events: &EventEmitter,
    paths: Vec<String>,
) -> Result<usize, AppError> {
    let mut roots = Vec::with_capacity(paths.len());
    for raw in &paths {
        let path = raw.trim();
        if path.is_empty() {
            return Err(AppError::InvalidInput("folder path is empty".into()));
        }
        roots.push(path.to_string());
    }

    let registered = library_locations::list_locations(&state.db).await?;

    for root in &roots {
        let ancestor = registered
            .iter()
            .filter(|candidate| {
                **candidate != *root && library_locations::is_under(root, candidate)
            })
            .min_by_key(|candidate| candidate.len());
        if let Some(ancestor) = ancestor {
            if !roots.iter().any(|kept| kept == ancestor) {
                return Err(AppError::InvalidInput(format!(
                    "{root} is inside the watched folder {ancestor}, which still watches \
                     everything under it; unwatch {ancestor} instead"
                )));
            }
        }
    }

    // Share the registration lock with new scans, then cancel and wait: without
    // it an import that had not registered yet could start after this purge.
    let (runs, blocked) = state.importing.block(&roots);
    let _unwatch_block = UnwatchBlockGuard {
        importing: state.importing.clone(),
        roots: blocked,
    };
    for run in &runs {
        run.cancel();
    }
    for run in &runs {
        run.wait_finished().await;
    }

    // Settle the removal set while rows stand: `storage_stats` already promised them.
    let mut doomed = Vec::new();
    for path in &roots {
        for book in books::books_owned_by(&state.db, path).await? {
            if let Some(file_id) = book.file_id {
                doomed.push((book.id, file_id, book.available));
            }
        }
    }
    // Reader's-copy last, per the ordering note on this function's doc.
    doomed.sort_by(|a, b| a.0.cmp(&b.0).then(a.2.cmp(&b.2)).then(b.1.cmp(&a.1)));

    // Stop the taps first: a leftover row is retryable, a leftover watch keeps syncing.
    let dying: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();
    state.watcher.unwatch_all(&dying);

    let mut removed_folders = 0usize;
    for path in &roots {
        if !library_locations::remove_location(&state.db, path).await? {
            continue;
        }
        removed_folders += 1;
    }
    if removed_folders > 0 {
        events.emit("watched-folders-changed", &());
    }

    let total = doomed.len();
    events.emit("unwatch-progress", &UnwatchProgress { removed: 0, total });
    let mut processed = 0usize;
    let mut last_reported = 0usize;
    let mut last_flush = Instant::now();
    for (book_id, file_id, _available) in doomed {
        delete_file_row_and_notify(state, events, file_id, book_id).await?;
        processed += 1;
        if processed % EVENT_BATCH_BOOKS == 0
            || last_flush.elapsed().as_millis() >= EVENT_BATCH_WINDOW_MS
        {
            events.emit(
                "unwatch-progress",
                &UnwatchProgress {
                    removed: processed,
                    total,
                },
            );
            last_reported = processed;
            last_flush = Instant::now();
        }
    }

    if processed > 0 {
        if let Err(err) = crate::services::artwork_cache::sweep_unreferenced_covers(
            &state.db,
            &covers_dir(&state.db_path),
        )
        .await
        {
            eprintln!("cover sweep after unwatch failed: {err}");
        }
    }
    if processed != last_reported {
        events.emit(
            "unwatch-progress",
            &UnwatchProgress {
                removed: processed,
                total,
            },
        );
    }
    Ok(removed_folders)
}
