//! Incremental library reconciliation (ROADMAP milestone 3).
//!
//! Turns filesystem observations into minimal database transitions. The
//! library is never rebuilt wholesale: each change touches only the books
//! whose source file actually changed, keyed by path. A disappeared file
//! never deletes its row — the row becomes *unavailable* so metadata,
//! collections, and reading progress survive until the file is relocated or
//! the user removes the book.
//!
//! This module owns the *policy* (what a create/rename/modify means); the
//! watcher ([`crate::services::library_watcher`]) owns the *timing* (event
//! batching and debouncing) and drives [`Reconciler::apply`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::runtime::Handle;

use crate::domain::Book;
use crate::error::AppError;
use crate::repository::{books, library_locations};
use crate::services::book_importer::{file_stats, import_file};

/// A library mutation pushed to the frontend over IPC (`library-changed`).
/// `rename_all` covers the variant names, `rename_all_fields` the payload
/// fields, so the wire format is `{ kind, book? , bookId? }` in camelCase.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LibraryChange {
    /// A book row was created, updated, relinked, or became (un)available.
    Changed { book: Box<Book> },
    /// The user removed the book; the frontend must drop it entirely.
    Removed { book_id: i64 },
}

/// One reconciled filesystem observation, after the watcher's batch
/// processing (dedup + rename pairing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathChange {
    /// A new file (or directory tree) appeared at this path.
    Created(PathBuf),
    /// The file's content or metadata changed.
    Modified(PathBuf),
    /// The file or directory disappeared.
    Removed(PathBuf),
    /// The path moved from `from` to `to` (both ends observed).
    Renamed { from: PathBuf, to: PathBuf },
}

type OnChange = Box<dyn Fn(&LibraryChange) + Send + Sync>;

/// Applies filesystem observations to the library database.
pub struct Reconciler {
    pool: SqlitePool,
    covers_dir: PathBuf,
    pdfium_dirs: Vec<PathBuf>,
    runtime: Handle,
    on_change: OnChange,
}

impl Reconciler {
    pub fn new(
        pool: SqlitePool,
        covers_dir: PathBuf,
        pdfium_dirs: Vec<PathBuf>,
        runtime: Handle,
        on_change: OnChange,
    ) -> Self {
        Self {
            pool,
            covers_dir,
            pdfium_dirs,
            runtime,
            on_change,
        }
    }

    /// Apply a debounced batch of filesystem changes. Runs on the watcher
    /// thread; each change is independent and safe to process in any order.
    pub async fn apply(&self, changes: Vec<PathChange>) {
        for change in changes {
            match change {
                PathChange::Created(path) => {
                    // A folder appearing inside the watch (dragged in, or a
                    // rename destination whose event was lost) brings its
                    // whole subtree with it: reconcile it like a location.
                    if std::fs::metadata(&path)
                        .map(|m| m.is_dir())
                        .unwrap_or(false)
                    {
                        let _ignored = self.reconcile_location(&path).await;
                    } else {
                        self.import_created(&path).await;
                    }
                }
                PathChange::Modified(path) => self.handle_modified(&path).await,
                PathChange::Removed(path) => self.mark_removed(&path).await,
                PathChange::Renamed { from, to } => self.handle_renamed(&from, &to).await,
            }
        }
    }

    /// Run `future` to completion from a sync context (watcher thread,
    /// app startup).
    pub fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    fn emit(&self, change: LibraryChange) {
        (self.on_change)(&change);
    }

    /// A file appeared. Parse failures are almost always "still being
    /// written" — retry once, then leave the file alone and wait for the
    /// next modify event. Unknown formats are silently ignored.
    pub async fn import_created(&self, path: &Path) {
        for attempt in 0..2 {
            match import_file(&self.pool, path, &self.covers_dir, &self.pdfium_dirs).await {
                Ok(Some(outcome)) => {
                    self.emit(LibraryChange::Changed {
                        book: Box::new(outcome.book),
                    });
                    return;
                }
                Ok(None) => {
                    // Not parseable *yet* — give in-flight writers one extra
                    // beat before giving up until the next event.
                    if attempt == 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                        continue;
                    }
                    return;
                }
                Err(err) => {
                    eprintln!("reconciler: import failed for {}: {err}", path.display());
                    return;
                }
            }
        }
    }

    /// A file changed. Re-parse only when the file snapshot actually differs
    /// from the stored row — duplicate modify events (and editors that touch
    /// mtime without writing) must not trigger pointless re-parses.
    pub async fn handle_modified(&self, path: &Path) {
        let Some(stats) = file_stats(path) else {
            return;
        };
        let path_str = path.to_string_lossy().into_owned();
        match books::get_book_by_path(&self.pool, &path_str).await {
            Ok(Some(book)) => {
                if book.available && book.file_size == stats.0 && book.file_mtime == stats.1 {
                    return;
                }
            }
            Ok(None) => {}
            Err(err) => {
                eprintln!("reconciler: lookup failed for {}: {err}", path.display());
                return;
            }
        }
        self.import_created(path).await;
    }

    /// A file or directory disappeared. Mark the matching book rows
    /// unavailable (exact path plus everything under the path) — rows stay,
    /// so metadata, collections, and reading progress survive reconnection.
    pub async fn mark_removed(&self, path: &Path) {
        let path_str = path.to_string_lossy().into_owned();
        match books::set_availability_prefix(&self.pool, &path_str, false).await {
            Ok(affected) => {
                for book in affected {
                    self.emit(LibraryChange::Changed {
                        book: Box::new(book),
                    });
                }
            }
            Err(err) => eprintln!("reconciler: removal handling failed: {err}"),
        }
    }

    /// A path moved. Directories rewrite the stored prefix of every book
    /// beneath them (preserving ids); files relink the single owning row, or
    /// import when the destination is a genuinely new file.
    pub async fn handle_renamed(&self, from: &Path, to: &Path) {
        eprintln!(
            "DEBUG handle_renamed from={} to={}",
            from.display(),
            to.display()
        );
        if std::fs::metadata(to).map(|m| m.is_dir()).unwrap_or(false) {
            self.relink_directory(from, to).await;
            return;
        }

        let from_str = from.to_string_lossy().into_owned();
        let known = match books::get_book_by_path(&self.pool, &from_str).await {
            Ok(known) => known,
            Err(err) => {
                eprintln!("reconciler: rename lookup failed: {err}");
                return;
            }
        };

        let Some(book) = known else {
            // Unknown source: the destination is just a new/changed file.
            if is_book_path(to) {
                self.import_created(to).await;
            }
            return;
        };

        if !is_book_extension(to) {
            // The file is no longer a book (renamed away or replaced by
            // another format): mark it missing, preserving the row.
            self.mark_removed(from).await;
            return;
        }

        let (size, mtime) = file_stats(to).unwrap_or((book.file_size, book.file_mtime));
        let to_str = to.to_string_lossy().into_owned();
        match books::relink_book(&self.pool, book.id, &to_str, size, mtime).await {
            Ok(books::RelinkOutcome::Relinked) => {
                let Some(relinked) = books::get_book(&self.pool, book.id).await.ok().flatten()
                else {
                    return;
                };
                self.emit(LibraryChange::Changed {
                    book: Box::new(relinked),
                });
            }
            Ok(books::RelinkOutcome::PathConflict) => {
                // Another row owns the destination (overwrite): the file
                // content now belongs to that row, and this row's source is
                // gone. fs truth on both sides.
                self.import_created(to).await;
                self.mark_removed(from).await;
            }
            Err(err) => eprintln!("reconciler: relink failed: {err}"),
        }
    }

    /// Relink every book under `from` to the same relative location under
    /// `to` (a directory was renamed/moved inside the watch).
    async fn relink_directory(&self, from: &Path, to: &Path) {
        let from_str = from.to_string_lossy().into_owned();
        let to_str = to.to_string_lossy().into_owned();
        let affected = match books::list_books_in_prefix(&self.pool, &from_str).await {
            Ok(affected) => affected,
            Err(err) => {
                eprintln!("reconciler: directory rename lookup failed: {err}");
                return;
            }
        };
        for book in affected {
            let suffix = book.path.strip_prefix(&from_str).unwrap_or(&book.path);
            let suffix = suffix.strip_prefix('/').unwrap_or(suffix);
            let new_path = format!("{to_str}/{suffix}");
            let (size, mtime) = std::fs::metadata(&new_path)
                .ok()
                .and_then(|_| file_stats(Path::new(&new_path)))
                .unwrap_or((book.file_size, book.file_mtime));
            match books::relink_book(&self.pool, book.id, &new_path, size, mtime).await {
                Ok(books::RelinkOutcome::Relinked) => {
                    if let Some(updated) = books::get_book(&self.pool, book.id).await.ok().flatten()
                    {
                        self.emit(LibraryChange::Changed {
                            book: Box::new(updated),
                        });
                    }
                }
                Ok(books::RelinkOutcome::PathConflict) => {
                    eprintln!(
                        "reconciler: directory move skipped {}: target path already owned",
                        new_path
                    );
                }
                Err(err) => eprintln!("reconciler: directory move failed: {err}"),
            }
        }
    }

    /// Startup / explicit reconciliation of one watched location: a bounded
    /// diff against the database that imports new files, refreshes changed
    /// ones (snapshot check first — unchanged files are never re-parsed),
    /// and marks rows whose files vanished. Returns the number of changes.
    pub async fn reconcile_location(&self, root: &Path) -> Result<u64, AppError> {
        let files = match crate::services::library_scanner::list_book_files(root) {
            Ok(files) => files,
            // A temporarily unmounted location must not wipe the library:
            // leave rows untouched and let startup reconcile again later.
            Err(err) => {
                eprintln!(
                    "reconciler: location {} not readable, skipping: {err}",
                    root.display()
                );
                return Ok(0);
            }
        };

        let root_str = root.to_string_lossy().into_owned();
        let mut known: HashMap<String, Book> = books::list_books_in_prefix(&self.pool, &root_str)
            .await?
            .into_iter()
            .map(|book| (book.path.clone(), book))
            .collect();

        let mut changes: u64 = 0;
        for file in files {
            let file_str = file.to_string_lossy().into_owned();
            let needs_import = match known.remove(&file_str) {
                Some(book) => match file_stats(&file) {
                    Some(stats) => {
                        !book.available || book.file_size != stats.0 || book.file_mtime != stats.1
                    }
                    None => true,
                },
                None => true,
            };
            if !needs_import {
                continue;
            }
            // Move recovery: a rename whose destination event was lost
            // surfaces here as an unknown file. Relink a vanished book with
            // the same name and size instead of importing a duplicate —
            // this is what keeps identity through moves the watcher missed.
            if self.relink_if_move(&file).await {
                changes += 1;
                continue;
            }
            self.import_created(&file).await;
            changes += 1;
        }

        // Whatever is left in `known` has no file on disk anymore.
        for (_, book) in known {
            if book.available {
                let affected = books::set_availability_prefix(&self.pool, &book.path, false)
                    .await
                    .unwrap_or_default();
                for updated in affected {
                    self.emit(LibraryChange::Changed {
                        book: Box::new(updated),
                    });
                    changes += 1;
                }
            }
        }
        Ok(changes)
    }

    /// Reconcile every registered watched location. Used after anomaly
    /// signals (lost rename destination, backend rescan request) and by the
    /// startup pass, which iterates the same list.
    pub async fn reconcile_all_locations(&self) {
        let locations = match library_locations::list_locations(&self.pool).await {
            Ok(locations) => locations,
            Err(err) => {
                eprintln!("reconciler: cannot list watched locations: {err}");
                return;
            }
        };
        for location in locations {
            if let Err(err) = self.reconcile_location(Path::new(&location)).await {
                eprintln!("reconciler: location {location} failed: {err}");
            }
        }
    }

    /// Move recovery for an unknown file: relink the most plausible source
    /// book (same file name, same size, file gone from its stored path)
    /// instead of importing a duplicate row. Returns true when a relink
    /// happened. The missing source file is what distinguishes a move from
    /// an honest copy — a copied book keeps its original row untouched.
    async fn relink_if_move(&self, path: &Path) -> bool {
        let Some((size, _)) = file_stats(path) else {
            return false;
        };
        let basename = match path.file_name() {
            Some(name) => name.to_string_lossy().into_owned(),
            None => return false,
        };
        let path_str = path.to_string_lossy().into_owned();
        let candidates = match books::find_books_with_size(&self.pool, size).await {
            Ok(candidates) => candidates,
            Err(err) => {
                eprintln!("reconciler: move-recovery lookup failed: {err}");
                return false;
            }
        };
        let Some(candidate) = candidates.into_iter().find(|book| {
            book.path != path_str
                && Path::new(&book.path)
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy() == basename)
                && !Path::new(&book.path).exists()
        }) else {
            return false;
        };

        let (size, mtime) = file_stats(path).unwrap_or((candidate.file_size, candidate.file_mtime));
        match books::relink_book(&self.pool, candidate.id, &path_str, size, mtime).await {
            Ok(books::RelinkOutcome::Relinked) => {
                if let Some(relinked) = books::get_book(&self.pool, candidate.id)
                    .await
                    .ok()
                    .flatten()
                {
                    self.emit(LibraryChange::Changed {
                        book: Box::new(relinked),
                    });
                }
                true
            }
            _ => false,
        }
    }
}

/// True for paths the scanner would treat as books (`.epub`/`.pdf`).
pub(crate) fn is_book_path(path: &Path) -> bool {
    is_book_extension(path)
}

pub(crate) fn is_book_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("epub") || ext.eq_ignore_ascii_case("pdf"))
}

/// Explicitly reconnect an unavailable book to a new file: the row keeps its
/// id (and therefore progress, collections), while path, metadata, and file
/// snapshot come from the newly located file. Returns the refreshed row.
pub async fn reconnect_book(
    pool: &SqlitePool,
    book_id: i64,
    path: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
) -> Result<Book, AppError> {
    if !path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "no file exists at {}",
            path.display()
        )));
    }
    let parsed = crate::services::library_scanner::parse_book(path).map_err(|err| {
        AppError::InvalidInput(format!("that file is not a readable book: {err}"))
    })?;
    let previous_cover = books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?
        .cover_path;
    let new_book = crate::services::book_importer::new_book_from_parsed(
        path,
        &parsed,
        covers_dir,
        pdfium_dirs,
        previous_cover.as_deref(),
    )?;

    if let Some(existing) = books::find_id_by_path(pool, &new_book.path).await? {
        if existing != book_id {
            return Err(AppError::InvalidInput(
                "that file is already in the library".into(),
            ));
        }
    }
    if !books::update_book_by_id(pool, book_id, &new_book).await? {
        return Err(AppError::NotFound);
    }
    books::get_book(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// Shared reconciler handle used by the watcher thread and app state.
pub type SharedReconciler = Arc<Reconciler>;

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend keys on `kind` and `bookId`; a serialization regression
    /// here silently no-ops the whole live-update path.
    #[test]
    fn library_change_uses_the_camel_case_wire_format() {
        let removed = serde_json::to_value(LibraryChange::Removed { book_id: 7 }).unwrap();
        assert_eq!(removed["kind"], "removed");
        assert_eq!(removed["bookId"], 7);
        assert!(removed.get("book_id").is_none());
    }
}
