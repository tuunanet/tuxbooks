//! Book import: parse library files and persist them into the catalog.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{mpsc, Semaphore};

use crate::domain::NewBook;
use crate::error::AppError;
use crate::repository::books;
use crate::services::library_scanner::{list_book_files, parse_book, ScanError};

mod convert;
mod cover;

pub use convert::file_stats;
pub(crate) use convert::{bibliographic_new_book, new_book_from_parsed};
pub(crate) use cover::write_cover_bytes;

use cover::existing_cover;

#[cfg(test)]
use cover::pdf_cover_from_result;

#[cfg(test)]
mod tests;

/// How many files may be parsed (+ cover-extracted) at once. Parsing is
/// CPU-bound (zip/XML, PDFium rasterization) and runs on the blocking pool;
/// a small bounded set keeps several cores busy without starving the rest
/// of the runtime, while persistence stays serialized behind the channel.
const PARSE_CONCURRENCY: usize = 3;

/// Summary of an import run over a library directory.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u64,
    pub updated: u64,
    /// Files whose stored size+mtime still match the source file — never
    /// re-parsed. A re-import of an existing library is a stat-only pass.
    pub skipped: u64,
    pub failed: Vec<FailedImport>,
    /// Folders this run newly registered as watched locations, so the UI
    /// can disclose the watch instead of starting it silently (ADR 0009).
    /// Already-watched folders never appear here.
    pub watched: Vec<String>,
    /// Folders this run declined to register because a watched folder above
    /// them already covers them (ADR 0010). Their books still arrive, so
    /// the report says where they came from instead of naming a watch that
    /// was never started.
    pub covered: Vec<String>,
    /// The scan stopped because its folder was unwatched mid-import. Counts
    /// cover only the books that landed before the cancel.
    pub cancelled: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedImport {
    pub path: String,
    pub error: String,
}

/// A single persisted book and whether the upsert newly inserted it.
#[derive(Debug, Clone)]
pub struct ImportOutcome {
    pub book: crate::domain::Book,
    pub inserted: bool,
}

/// Import a library directory: enumerate, skip unchanged files, parse the
/// rest with bounded concurrency, and persist in arrival order, streaming
/// each persisted book to `on_book` as soon as it lands (issue #61).
///
/// The walk itself never parses — [`list_book_files`] is names-only — and
/// no more than [`PARSE_CONCURRENCY`] books are ever parsed or held in
/// memory at once, so peak memory is O(1) parsed book, not O(library).
/// Files whose stored size+mtime still match the source (the same
/// skip-if-unchanged contract the reconciler applies) are never read;
/// per-file failures are reported and do not abort the run.
pub async fn import_directory(
    pool: &SqlitePool,
    library_root: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
    on_book: &(dyn Fn(&crate::domain::Book) + Send + Sync),
) -> Result<ImportReport, AppError> {
    import_directory_with_cancel(pool, library_root, covers_dir, pdfium_dirs, on_book, None).await
}

/// The cancellable form of [`import_directory`]. `cancel` is polled between
/// files and before each persisted book; a cancelled run stops scheduling
/// parses, drops any results still in the channel, and returns a report with
/// `cancelled` set. Workers already parsing finish, but nothing they produce
/// is written to the catalog.
pub async fn import_directory_with_cancel(
    pool: &SqlitePool,
    library_root: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
    on_book: &(dyn Fn(&crate::domain::Book) + Send + Sync),
    cancel: Option<Arc<AtomicBool>>,
) -> Result<ImportReport, AppError> {
    let cancelled = || {
        cancel
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    };
    let files = list_book_files(library_root).map_err(|err| match err {
        ScanError::Io { source, .. } => AppError::Io(source),
        other => AppError::InvalidInput(other.to_string()),
    })?;

    // One snapshot of the known rows: stored size/mtime for the skip check
    // and the stored cover path for the keep-what-works rule. Only those
    // columns are read, so a 10k-book re-import does not deserialize 10k
    // descriptions to compare two integers.
    let known: HashMap<String, books::BookFileSnapshot> = books::list_file_snapshots(pool)
        .await?
        .into_iter()
        .map(|book| (book.path.clone(), book))
        .collect();

    let mut report = ImportReport::default();
    let mut queued: Vec<(PathBuf, Option<String>)> = Vec::new();
    for path in files {
        if cancelled() {
            report.cancelled = true;
            break;
        }
        let path_str = path.to_string_lossy().into_owned();
        let stored = known.get(&path_str);
        let stats = file_stats(&path);
        if let Some(book) = stored {
            if book.available && stats == Some((book.file_size, book.file_mtime)) {
                report.skipped += 1;
                continue;
            }
        }
        let previous_cover = stored.and_then(|book| book.cover_path.clone());
        queued.push((path, previous_cover));
    }

    // Bounded parse workers feed one persister through a channel: parsing
    // and cover extraction block on the worker pool while DB writes stay
    // serialized, and the channel's backpressure keeps memory bounded — a
    // parser can only run ahead by the channel's few slots.
    let semaphore = Arc::new(Semaphore::new(PARSE_CONCURRENCY));
    let (tx, mut rx) = mpsc::channel::<(PathBuf, Result<NewBook, String>)>(PARSE_CONCURRENCY);
    let mut workers = Vec::with_capacity(queued.len());
    for (path, previous_cover) in queued {
        if cancelled() {
            report.cancelled = true;
            break;
        }
        let semaphore = semaphore.clone();
        let tx = tx.clone();
        let cancel = cancel.clone();
        let covers_dir = covers_dir.to_path_buf();
        let pdfium_dirs = pdfium_dirs.to_vec();
        workers.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            if cancel
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
            {
                return;
            }
            let parse_path = path.clone();
            let result = tokio::task::spawn_blocking(move || -> Result<NewBook, String> {
                let parsed = parse_book(&parse_path).map_err(|err| err.to_string())?;
                new_book_from_parsed(
                    &parse_path,
                    &parsed,
                    &covers_dir,
                    &pdfium_dirs,
                    previous_cover.as_deref(),
                )
                .map_err(|err| err.to_string())
            })
            .await
            .unwrap_or_else(|err| Err(format!("parse task failed: {err}")));
            let _ = tx.send((path, result)).await;
        }));
    }
    // Dropping the sender ends the receive loop once every worker finished.
    drop(tx);

    while let Some((path, result)) = rx.recv().await {
        if cancelled() {
            report.cancelled = true;
            break;
        }
        match result {
            Err(error) => report.failed.push(FailedImport {
                path: path.to_string_lossy().into_owned(),
                error,
            }),
            Ok(new_book) => {
                let upserted = books::upsert_file(pool, &new_book).await?;
                // Record the fresh parse as source truth and re-merge the
                // effective view, so user metadata overrides survive file
                // changes (milestone 7).
                crate::repository::metadata::record_imported_source(
                    pool,
                    upserted.file_id,
                    &new_book,
                )
                .await?;
                let book = finalize_import(pool, upserted.file_id).await?;
                on_book(&book);
                bump(&mut report, upserted.inserted);
            }
        }
    }
    // Close the channel before joining: a cancelled persister must not leave
    // a worker blocked on a full channel waiting for a reader that never
    // comes back.
    drop(rx);
    for worker in workers {
        worker
            .await
            .map_err(|err| AppError::InvalidInput(format!("import worker failed: {err}")))?;
    }
    Ok(report)
}

/// Import a single file (watcher path): parse, build the book, upsert by
/// path. `Ok(None)` means the file did not parse (e.g. still being written);
/// the caller simply waits for a later event instead of treating it as an
/// error. Errors are real failures (database, cover IO).
pub async fn import_file(
    pool: &SqlitePool,
    path: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
) -> Result<Option<ImportOutcome>, AppError> {
    let previous_cover = existing_cover(pool, path).await?;
    let parsed = match parse_book(path) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(None),
    };
    let new_book = new_book_from_parsed(
        path,
        &parsed,
        covers_dir,
        pdfium_dirs,
        previous_cover.as_deref(),
    )?;
    let upserted = books::upsert_file(pool, &new_book).await?;
    // Record the fresh parse as source truth and re-merge the effective
    // view, so user metadata overrides survive file changes (milestone 7).
    crate::repository::metadata::record_imported_source(pool, upserted.file_id, &new_book).await?;
    let book = finalize_import(pool, upserted.file_id).await?;
    // ADR 0018 D1: only the re-import path mints a file_version, and only
    // when the hash changed. The guard lives in the mint.
    if !upserted.inserted {
        crate::sync::file_version::mint_after_reimport(pool, upserted.file_id).await?;
    }
    Ok(Some(ImportOutcome {
        book,
        inserted: upserted.inserted,
    }))
}

/// Hash a freshly imported file before the row is published to the UI
/// (ADR 0014 D8). A failed hash does not fail the import: the book keeps its
/// record, `hash_state` says failed, and a later remove/unwatch may proceed
/// with the book marked as needing a relink.
async fn finalize_import(pool: &SqlitePool, file_id: i64) -> Result<crate::domain::Book, AppError> {
    match crate::sync::identity::ensure_book_identity(pool, file_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            crate::services::hash_backfill::mark_failed(pool, file_id).await?;
        }
        Err(err) => {
            eprintln!("import: could not hash book file {file_id}: {err}");
            crate::services::hash_backfill::mark_failed(pool, file_id).await?;
        }
    }
    let id = books::durable_id_for_file(pool, file_id)
        .await?
        .ok_or_else(|| AppError::InvalidInput("imported book has no durable record".into()))?;
    books::get_book(pool, id).await?.ok_or(AppError::NotFound)
}

fn bump(report: &mut ImportReport, inserted: bool) {
    if inserted {
        report.imported += 1;
    } else {
        report.updated += 1;
    }
}
