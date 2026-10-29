mod commands;
pub mod db;
pub mod domain;
pub mod epub;
pub mod error;
pub mod limits;
pub mod pdf;
pub mod repository;
pub mod rpc;
pub mod services;
pub mod sync;
pub mod worker;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::sync::watch;

use crate::db::connection::init_pool_recovering;
use crate::domain::{LibraryLocationStatus, StartupRecovery};
use crate::repository::library_locations::is_under;
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::Reconciler;
use crate::services::library_watcher::LibraryWatcher;
use crate::sync::engine::SyncService;

/// One folder import in flight. Unwatch cancels it and waits for
/// `finished` before purging, so the scan cannot write rows after the
/// folder and its books are gone.
#[derive(Clone)]
pub struct ImportRun {
    cancel: Arc<AtomicBool>,
    finished: Arc<watch::Sender<bool>>,
    /// 0 = a new folder's first scan, 1 = re-scanning a watched folder.
    mode: Arc<AtomicU8>,
}

impl ImportRun {
    pub fn new() -> Self {
        let (finished, _) = watch::channel(false);
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(finished),
            mode: Arc::new(AtomicU8::new(0)),
        }
    }

    pub fn mark_refreshing(&self) {
        self.mode.store(1, Ordering::Relaxed);
    }

    pub fn scan_status(&self) -> LibraryLocationStatus {
        if self.mode.load(Ordering::Relaxed) == 1 {
            LibraryLocationStatus::Refreshing
        } else {
            LibraryLocationStatus::Importing
        }
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// The flag the importer polls between files and batches.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    /// Called once the scan has stopped. A watch channel is used instead of
    /// a bare notification so an unwatch that arrives after this point
    /// still observes the finished state.
    pub fn finish(&self) {
        let _ = self.finished.send(true);
    }

    pub async fn wait_finished(&self) {
        let mut finished = self.finished.subscribe();
        if *finished.borrow() {
            return;
        }
        // A dropped sender means the run ended too.
        let _ = finished.wait_for(|done| *done).await;
    }
}

impl Default for ImportRun {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for ImportRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportRun")
            .field("cancelled", &self.cancelled())
            .finish_non_exhaustive()
    }
}

/// The shared import/unwatch handshake. Both sides take the same lock, so an
/// unwatch that starts before a scan is registered still blocks that scan
/// from registering, and a scan that starts first is visible to the unwatch.
#[derive(Debug, Clone, Default)]
pub struct ImportRegistry {
    inner: Arc<Mutex<ImportRegistryState>>,
}

#[derive(Debug, Default)]
struct ImportRegistryState {
    running: HashMap<String, ImportRun>,
    /// Roots an unwatch is cancelling and purging. A new scan that overlaps
    /// one of these waits until the purge clears it.
    blocking: HashSet<String>,
}

impl ImportRegistry {
    /// Register a scan, or refuse when the folder overlaps a running scan or
    /// an unwatch that is still purging.
    pub fn start(&self, root: &str) -> Result<ImportRun, String> {
        let mut inner = self.inner.lock().expect("importing mutex poisoned");
        if inner.blocking.iter().any(|blocked| overlaps(blocked, root))
            || inner.running.keys().any(|busy| overlaps(busy, root))
        {
            return Err(format!("{root} is already importing or being unwatched"));
        }
        let run = ImportRun::new();
        inner.running.insert(root.to_string(), run.clone());
        Ok(run)
    }

    /// Unregister a finished scan. Only `start` inserts running entries and
    /// it refuses overlaps, so the entry belongs to this run.
    pub fn finish(&self, root: &str) {
        self.inner
            .lock()
            .expect("importing mutex poisoned")
            .running
            .remove(root);
    }

    /// Block the roots for the duration of an unwatch and return the scans
    /// that overlap them. The caller must call [`clear_blocking`] when the
    /// purge is done, on every exit path.
    pub fn block(&self, roots: &[String]) -> (Vec<ImportRun>, Vec<String>) {
        let mut inner = self.inner.lock().expect("importing mutex poisoned");
        let runs = inner
            .running
            .iter()
            .filter(|(busy, _)| roots.iter().any(|root| overlaps(busy, root)))
            .map(|(_, run)| run.clone())
            .collect();
        let mut newly_blocked = Vec::new();
        for root in roots {
            if inner.blocking.insert(root.clone()) {
                newly_blocked.push(root.clone());
            }
        }
        (runs, newly_blocked)
    }

    pub fn clear_blocking(&self, roots: &[String]) {
        let mut inner = self.inner.lock().expect("importing mutex poisoned");
        for root in roots {
            inner.blocking.remove(root);
        }
    }

    /// The scan state of every folder with an import in flight, keyed by
    /// the same path the watch list stores.
    pub fn statuses(&self) -> HashMap<String, LibraryLocationStatus> {
        let inner = self.inner.lock().expect("importing mutex poisoned");
        inner
            .running
            .iter()
            .map(|(path, run)| (path.clone(), run.scan_status()))
            .collect()
    }
}

fn overlaps(left: &str, right: &str) -> bool {
    left == right || is_under(left, right) || is_under(right, left)
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub db_path: PathBuf,
    pub watcher: Arc<LibraryWatcher>,
    /// Set once at startup when a broken database was quarantined; read by
    /// `get_startup_recovery` so main can name the file in the dialog.
    pub startup_recovery: Option<StartupRecovery>,
    /// Background cloud-folder sync. `None` in unit tests that construct the
    /// state by hand; production wires it in `init_state`.
    pub sync: Option<Arc<SyncService>>,
    /// Folder imports in flight, keyed by root. Unwatch cancels and waits
    /// for these before purging so a scan cannot race the purge.
    pub importing: ImportRegistry,
}

/// Directory where imported cover images are extracted, derived from the DB path.
pub fn covers_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("covers")
}

/// Monotonic suffix so concurrent writes never collide on the temp name.
static ATOMIC_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `<path>.bak` beside the original (e.g. `book.epub.bak`).
pub(crate) fn backup_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

/// Copy `path` to `<path>.bak` the first time a file is about to be rewritten,
/// so the backup always holds the pre-embed original. No-op (and no error)
/// when a backup already exists; a failed copy is an error, so the caller
/// aborts without modifying the source. An existing path that is not a regular
/// file is an error rather than a silent skip. The copy itself is atomic (temp
/// + rename), so a crash can never leave a truncated backup.
pub(crate) fn backup_file_once(path: &Path) -> std::io::Result<Option<PathBuf>> {
    let backup = backup_path(path);
    match std::fs::metadata(&backup) {
        Ok(meta) if meta.is_file() => return Ok(None),
        Ok(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("backup path {} is not a regular file", backup.display()),
            ))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let unique = ATOMIC_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".tuxbooks-backup-{unique}.tmp"));
    std::fs::copy(path, &temp)?;
    if let Err(err) = std::fs::rename(&temp, &backup) {
        let _ = std::fs::remove_file(&temp);
        return Err(err);
    }
    Ok(Some(backup))
}

/// Replace `path` with `bytes` without ever leaving a partially written file
/// at the destination: the bytes land in a hidden same-directory temp file,
/// are flushed to disk, and then renamed over the target. Used when rewriting
/// a source book file after a metadata embed (EPUB/PDF). On Windows a rename
/// over an existing file fails, so the destination is removed and the rename
/// retried — the only non-atomic window, and still never a truncated file.
pub(crate) fn atomic_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "book".to_string());
    let unique = ATOMIC_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{file_name}.tuxbooks-{unique}.tmp"));

    let write = (|| -> std::io::Result<()> {
        let mut handle = std::fs::File::create(&temp)?;
        handle.write_all(bytes)?;
        handle.sync_all()
    })();
    if let Err(err) = write {
        let _ = std::fs::remove_file(&temp);
        return Err(err);
    }

    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(first) => {
            // Windows: rename does not replace an existing destination.
            if std::fs::remove_file(path).is_ok() && std::fs::rename(&temp, path).is_ok() {
                return Ok(());
            }
            let _ = std::fs::remove_file(&temp);
            Err(first)
        }
    }
}

/// Candidate directories that may contain the PDFium dynamic library, in
/// probe order: explicit override (`PDFIUM_LIB_DIR`), next to the executable,
/// and the development checkout where `scripts/fetch-pdfium.sh` installs it.
/// Absent candidates are skipped at probe time; see `pdf/render.rs` and
/// docs/BUILD.md.
pub fn pdfium_library_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("PDFIUM_LIB_DIR") {
        if !dir.is_empty() {
            dirs.push(PathBuf::from(dir));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium"));
    dirs
}

/// Production uses the OS app-data directory; tests override via `TEST_DATABASE_PATH`.
fn resolve_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("TEST_DATABASE_PATH") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    app_data_dir().join("tuxbooks.db")
}

/// The per-user app-data directory. On Linux this is the XDG data home
/// (`$XDG_DATA_HOME` or `~/.local/share`) plus the app identifier — the
/// location established by the app's first releases and kept stable.
fn app_data_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".local/share"))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("com.tuxbooks.app")
}

/// Initialize the service state: database pool, test-library seeding,
/// reconciliation watcher, and the startup artwork sweep. The `events`
/// callback receives every service-layer change (`library-changed`) — the
/// JSON-RPC server forwards it to the Electron main process.
pub async fn init_state(events: EventEmitter) -> Result<AppState, anyhow::Error> {
    let sync_events = events.clone();
    let db_path = resolve_db_path();
    let (pool, startup_recovery) = init_pool_recovering(&db_path)
        .await
        .map_err(|e| anyhow::anyhow!("failed to initialize database at {db_path:?}: {e}"))?;

    if let Ok(library_root) = std::env::var("TEST_LIBRARY_PATH") {
        if !library_root.is_empty() {
            // No progress callback: the client is not listening yet.
            let report = services::book_importer::import_directory(
                &pool,
                Path::new(&library_root),
                &covers_dir(&db_path),
                &pdfium_library_dirs(),
                &|_| {},
            )
            .await
            .map_err(|e| anyhow::anyhow!("failed to import library {library_root}: {e}"))?;
            eprintln!("imported test library: {report:?}");
        }
    }

    // Library reconciliation (milestone 3): one reconciler shared by
    // the watcher thread and the method table; its change callback is the
    // single place that turns service-layer changes into IPC events.
    let reconciler = Arc::new(Reconciler::new(
        pool.clone(),
        covers_dir(&db_path),
        pdfium_library_dirs(),
        tokio::runtime::Handle::current(),
        Box::new(move |change| {
            events.emit("library-changed", change);
        }),
    ));

    let watcher = LibraryWatcher::start(crate::services::library_watcher::WatcherConfig {
        reconciler: reconciler.clone(),
        debounce: Duration::from_millis(600),
    })?;

    // Incremental startup reconciliation: watched locations are diffed
    // against the database (only new/changed files parse), so events missed
    // while the app was closed are caught up here. Registration of the
    // watched roots stays synchronous — the method table going live must
    // never outrun the watcher (a file added in that window would go unseen
    // until an unrelated event). The diff walk itself is background work:
    // the UI consumes `library-changed` events live, so catch-up does not
    // need to block `service ready` (and with it, the whole window).
    let locations = crate::repository::library_locations::list_locations(&pool).await?;
    for location in &locations {
        watcher.watch(Path::new(location));
    }

    // The test library is registered like a user import so E2E can
    // exercise live synchronization against a real watched root.
    let mut catchup_roots = locations;
    if let Ok(library_root) = std::env::var("TEST_LIBRARY_PATH") {
        if !library_root.is_empty() {
            crate::repository::library_locations::add_location(&pool, &library_root).await?;
            watcher.watch(Path::new(&library_root));
            catchup_roots.push(library_root);
        }
    }

    // Artwork-cache GC (milestone 4): content-addressed covers stop being
    // referenced when their source changes or their book is removed;
    // unreferenced files are swept once at startup, after the catch-up walk
    // (a new book's cover file exists before its row commits — sweeping
    // first could race an in-flight import). One summary line — never
    // per-file noise — with counts the reconciler reported accurately.
    let reconciler = reconciler.clone();
    let reconciler_pool = pool.clone();
    let covers = covers_dir(&db_path);
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let mut report = services::library_reconciler::ReconcileReport::default();
        for root in catchup_roots {
            // Errors are logged inside; a missing location skips cleanly.
            match reconciler.reconcile_location(Path::new(&root)).await {
                Ok(passed) => {
                    report.imported += passed.imported;
                    report.updated += passed.updated;
                    report.failed += passed.failed;
                    report.changes += passed.changes;
                }
                Err(err) => eprintln!("reconciler: catch-up failed: {err}"),
            }
        }
        match services::artwork_cache::sweep_unreferenced_covers(&reconciler_pool, &covers).await {
            Ok(0) => {}
            Ok(removed) => eprintln!("swept {removed} unreferenced cover file(s)"),
            Err(err) => eprintln!("cover sweep failed: {err}"),
        }
        eprintln!(
            "[startup] catch-up complete imported={} updated={} failed={} duration={}ms",
            report.imported,
            report.updated,
            report.failed,
            started.elapsed().as_millis()
        );
    });

    let sync = Arc::new(
        SyncService::new(pool.clone(), &db_path, sync_events)
            .await
            .map_err(|err| anyhow::anyhow!("failed to initialize cloud sync: {err}"))?,
    );
    sync.start();

    Ok(AppState {
        db: pool,
        db_path,
        watcher: Arc::new(watcher),
        startup_recovery,
        sync: Some(sync),
        importing: ImportRegistry::default(),
    })
}

/// Service entry point: JSON-RPC over stdio until stdin closes.
pub async fn run() -> i32 {
    rpc::serve().await
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    #[test]
    fn the_first_backup_wins_and_later_writes_keep_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::write(&path, b"original").unwrap();

        let backup = backup_file_once(&path).unwrap().expect("a backup is made");
        assert_eq!(std::fs::read(&backup).unwrap(), b"original");

        std::fs::write(&path, b"edited").unwrap();
        assert!(backup_file_once(&path).unwrap().is_none());
        assert_eq!(
            std::fs::read(&backup).unwrap(),
            b"original",
            "a second embed keeps the first backup"
        );
    }

    #[test]
    fn a_directory_at_the_backup_path_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("book.epub");
        std::fs::write(&path, b"original").unwrap();
        std::fs::create_dir(backup_path(&path)).unwrap();

        let err = backup_file_once(&path).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"original",
            "the source is untouched"
        );
    }
}
