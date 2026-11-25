use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use crate::commands::books::delete_file_row_and_notify;
use crate::commands::emit_changed_book;
use crate::domain::{StartupRecovery, StorageStats};
use crate::error::AppError;
use crate::repository::books;
use crate::repository::library_locations;
use crate::repository::storage;
use crate::rpc::EventEmitter;
use crate::services::book_importer::{import_directory_with_cancel, ImportReport};
use crate::services::library_reconciler::reconnect_book as reconnect;
use crate::services::library_scanner::has_book_extension;
use crate::{covers_dir, pdfium_library_dirs, AppState};

/// Progress events are batched: the renderer coalesces its commits anyway,
/// so 1,500 individual IPC events per import are pure overhead (issue #61).
/// A batch flushes at `EVENT_BATCH_BOOKS` books or `EVENT_BATCH_WINDOW_MS`,
/// whichever comes first; the caller flushes the remainder after the run.
const EVENT_BATCH_BOOKS: usize = 25;
const EVENT_BATCH_WINDOW_MS: u128 = 250;

/// Wire shape of one batched `import-progress` event.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgressBatch {
    books: Vec<crate::domain::Book>,
}

/// Wire shape of one `unwatch-progress` event: `removed` books are gone out
/// of the `total` the dialog promised to remove.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnwatchProgress {
    removed: usize,
    total: usize,
}

/// Accumulates persisted books and emits them as batched `import-progress`
/// events. `Mutex` (not `RefCell`) because the importer requires the
/// callback to be `Sync`.
struct ProgressBatcher<'a> {
    events: &'a EventEmitter,
    books: Vec<crate::domain::Book>,
    last_flush: Instant,
}

impl<'a> ProgressBatcher<'a> {
    fn new(events: &'a EventEmitter) -> Self {
        Self {
            events,
            books: Vec::new(),
            last_flush: Instant::now(),
        }
    }

    fn push(&mut self, book: crate::domain::Book) {
        self.books.push(book);
        if self.books.len() >= EVENT_BATCH_BOOKS
            || self.last_flush.elapsed().as_millis() >= EVENT_BATCH_WINDOW_MS
        {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.books.is_empty() {
            return;
        }
        self.events.emit(
            "import-progress",
            &ImportProgressBatch {
                books: std::mem::take(&mut self.books),
            },
        );
        self.last_flush = Instant::now();
    }
}

/// Scan the directory at `path` for EPUB and PDF files and import them into
/// the library. Persisted books are streamed to the UI as batched
/// `import-progress` events so books and covers appear while the scan is
/// still running.
///
/// The directory is also registered as a watched library location before
/// its books are imported, so an interrupted scan leaves the folder watched
/// and startup catch-up finishes it (milestone 3).
pub async fn scan_library(
    state: &AppState,
    events: &EventEmitter,
    path: String,
) -> Result<ImportReport, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("library path is empty".into()));
    }
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "library path is not a directory: {}",
            root.display()
        )));
    }
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let batch = Mutex::new(ProgressBatcher::new(events));
    let mut report = ImportReport::default();
    register_and_import_folder(
        state,
        events,
        &root,
        &covers,
        &pdfium_dirs,
        &|book| {
            batch.lock().unwrap().push(book.clone());
        },
        &mut report,
    )
    .await?;
    batch.lock().unwrap().flush();
    Ok(report)
}

/// Import a mixed batch of files and/or folders (milestone 10). Every folder
/// is registered and watched before its books land, so an interrupted import
/// leaves a watched folder that startup catch-up finishes. A plain file's
/// parent gets the same folder treatment and the scan imports the picked
/// file with its siblings (ADR 0009), so every catalog book comes from a
/// watched folder. Registering an already-watched folder is idempotent: no
/// duplicate rows, no error, and no second disclosure. Persisted books
/// stream out as batched `import-progress` events; per-path failures come
/// back in the report so the UI can surface them honestly, and every folder
/// this run newly watched is listed in the report so the UI can disclose it.
pub async fn import_paths(
    state: &AppState,
    events: &EventEmitter,
    paths: Vec<String>,
) -> Result<ImportReport, AppError> {
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let batch = Mutex::new(ProgressBatcher::new(events));
    let emit_progress = |book: &crate::domain::Book| {
        batch.lock().unwrap().push(book.clone());
    };

    let mut report = ImportReport::default();
    let mut folders: Vec<PathBuf> = Vec::new();
    let mut seen_folders: HashSet<PathBuf> = HashSet::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        if path.as_os_str().is_empty() {
            report
                .failed
                .push(crate::services::book_importer::FailedImport {
                    path: raw,
                    error: "path is empty".into(),
                });
            continue;
        }
        if path.is_dir() {
            queue_folder(&mut folders, &mut seen_folders, path);
        } else if path.is_file() {
            if !has_book_extension(&path) {
                report
                    .failed
                    .push(crate::services::book_importer::FailedImport {
                        path: path.to_string_lossy().into_owned(),
                        error: "not a supported book file (.epub/.pdf)".into(),
                    });
                continue;
            }
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    queue_folder(&mut folders, &mut seen_folders, parent.to_path_buf());
                }
            }
        } else {
            report
                .failed
                .push(crate::services::book_importer::FailedImport {
                    path: raw,
                    error: "path does not exist".into(),
                });
        }
    }
    for folder in folders {
        if let Err(err) = register_and_import_folder(
            state,
            events,
            &folder,
            &covers,
            &pdfium_dirs,
            &emit_progress,
            &mut report,
        )
        .await
        {
            report
                .failed
                .push(crate::services::book_importer::FailedImport {
                    path: folder.to_string_lossy().into_owned(),
                    error: err.to_string(),
                });
        }
    }
    batch.lock().unwrap().flush();
    Ok(report)
}

/// Add a folder to the scan queue once, preserving the order the caller
/// named it.
fn queue_folder(folders: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, folder: PathBuf) {
    if seen.insert(folder.clone()) {
        folders.push(folder);
    }
}

/// Register `root` as a watched location, then import its books — the one
/// folder treatment both folder imports and picked files' parents get (ADR
/// 0009). Registration comes first so a quit during the scan leaves a
/// watched folder, not catalog rows no location owns; the next launch's
/// catch-up finishes the import. A scan that fails keeps the watch for the
/// same reason: it is visible and retryable, and removing it would strand
/// whatever rows already landed. Book counts and per-path failures merge
/// into `report`; a folder this run newly registered is disclosed in
/// `report.watched`. Registration is idempotent: an already-watched folder
/// produces no disclosure and no duplicate row.
async fn register_and_import_folder(
    state: &AppState,
    events: &EventEmitter,
    root: &Path,
    covers: &Path,
    pdfium_dirs: &[PathBuf],
    emit_progress: &(dyn Fn(&crate::domain::Book) + Send + Sync),
    report: &mut ImportReport,
) -> Result<(), AppError> {
    let root_key = root.to_string_lossy().into_owned();
    let run = state
        .importing
        .start(&root_key)
        .map_err(AppError::InvalidInput)?;
    let (registration, result) = {
        // Unregister on every exit path, panics included, or an unwatch waits forever for a dead run.
        let _guard = ImportGuard {
            importing: state.importing.clone(),
            root: root_key,
            run: run.clone(),
        };

        let registration = register_location(state, root, report).await?;
        if !registration.newly_added {
            run.mark_refreshing();
        }
        if registration.watch {
            events.emit("watched-folders-changed", &());
        }

        let outcome = import_directory_with_cancel(
            &state.db,
            root,
            covers,
            pdfium_dirs,
            emit_progress,
            Some(run.cancel_flag()),
        )
        .await;
        // Watch only after the scan so the watcher cannot import the same files;
        // a cancelled scan gets none, or a late event could write rows after the purge.
        let cancelled = run.cancelled();
        let result = match outcome {
            Ok(mut folder_report) => {
                if registration.watch && !cancelled {
                    state.watcher.watch(root);
                }
                report.imported += folder_report.imported;
                report.updated += folder_report.updated;
                report.skipped += folder_report.skipped;
                report.cancelled |= folder_report.cancelled;
                report.failed.append(&mut folder_report.failed);
                Ok(())
            }
            Err(err) => {
                if registration.watch && !cancelled {
                    state.watcher.watch(root);
                }
                Err(err)
            }
        };
        (registration, result)
    };

    if registration.watch {
        events.emit("watched-folders-changed", &());
    }
    result
}

/// Removes a folder's entry from the in-flight registry and wakes anything
/// waiting for it, including on an early return or unwind.
struct ImportGuard {
    importing: crate::ImportRegistry,
    root: String,
    run: crate::ImportRun,
}

impl Drop for ImportGuard {
    fn drop(&mut self) {
        self.run.finish();
        self.importing.finish(&self.root);
    }
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

struct LocationRegistration {
    /// The caller should start a filesystem watch for this root.
    watch: bool,
    /// The row was added by this call, so this is a first import.
    newly_added: bool,
}

/// Register `root` as a watched location without starting its filesystem
/// watcher yet — the caller starts the watcher after the scan. The row must
/// exist before any book lands so a quit leaves a watched folder that
/// startup catch-up finishes. A watched ancestor already covering `root`
/// returns `watch: false` (ADR 0010), so no separate watch is needed.
async fn register_location(
    state: &AppState,
    root: &Path,
    report: &mut ImportReport,
) -> Result<LocationRegistration, AppError> {
    let root = root.to_string_lossy().into_owned();
    if covered_by_watched_ancestor(&state.db, &root).await? {
        if !report.covered.contains(&root) {
            report.covered.push(root);
        }
        return Ok(LocationRegistration {
            watch: false,
            newly_added: false,
        });
    }
    // Add the parent before dropping nested rows: the reverse order would orphan
    // their books if the process dies in between.
    let added = library_locations::add_location(&state.db, &root).await?;
    if added {
        report.watched.push(root.clone());
    }
    let collapsed = library_locations::collapse_descendants(&state.db, &root).await?;
    for gone in &collapsed {
        state.watcher.unwatch(Path::new(gone));
    }
    Ok(LocationRegistration {
        watch: true,
        newly_added: added,
    })
}

/// True when `path` is already inside a watched folder, which watches the
/// whole subtree recursively and so needs no row of its own (ADR 0010). A
/// sibling sharing a string prefix is never inside it, since the split is
/// on a path separator.
async fn covered_by_watched_ancestor(pool: &SqlitePool, path: &str) -> Result<bool, AppError> {
    let registered = library_locations::list_locations(pool).await?;
    Ok(registered
        .iter()
        .any(|candidate| candidate != path && library_locations::is_under(path, candidate)))
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

/// Reconnect an unavailable book to a new file chosen by the user. The book
/// keeps its id — and therefore metadata, collections, and reading progress —
/// while path and parsed metadata are refreshed from the located file.
pub async fn reconnect_book(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
    path: String,
) -> Result<crate::domain::Book, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("book path is empty".into()));
    }
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let book = reconnect(
        &state.db,
        book_id,
        std::path::Path::new(&path),
        &covers,
        &pdfium_dirs,
    )
    .await?;
    emit_changed_book(events, book.clone());
    Ok(book)
}

/// Relink a Reading-history book to a file chosen by the user (ADR 0014 D6).
/// The book keeps its durable identity and every piece of state while the new
/// file row makes it a library membership again.
pub async fn relink_book(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
    path: String,
) -> Result<crate::domain::Book, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("book path is empty".into()));
    }
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let book = crate::services::library_reconciler::relink_book(
        &state.db,
        book_id,
        std::path::Path::new(&path),
        &covers,
        &pdfium_dirs,
        None,
    )
    .await?;
    emit_changed_book(events, book.clone());
    Ok(book)
}

/// Aggregate stats for the Application Data tab (data-management spec): each
/// watched location with its book count and total book bytes, the library's
/// total book bytes, and the catalog row counts.
pub async fn get_storage_stats(state: &AppState) -> Result<StorageStats, AppError> {
    let mut stats = storage::storage_stats(&state.db).await?;
    let statuses = state.importing.statuses();
    for location in &mut stats.locations {
        location.status = statuses.get(&location.path).copied().unwrap_or_default();
    }
    Ok(stats)
}

/// Where a broken database was moved at startup, or `null` when the database
/// was healthy. Read-only: the sidecar records the quarantine once during
/// `init_state`, so this cannot trigger another.
pub async fn get_startup_recovery(state: &AppState) -> Result<Option<StartupRecovery>, AppError> {
    Ok(state.startup_recovery.clone())
}
