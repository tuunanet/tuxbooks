mod commands;
pub mod db;
pub mod domain;
pub mod epub;
pub mod error;
pub mod pdf;
pub mod repository;
pub mod rpc;
pub mod services;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;

use crate::db::connection::init_pool;
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::Reconciler;
use crate::services::library_watcher::LibraryWatcher;

#[derive(Debug, Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub db_path: PathBuf,
    pub watcher: Arc<LibraryWatcher>,
}

/// Directory where imported cover images are extracted, derived from the DB path.
pub fn covers_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("covers")
}

/// Candidate directories that may contain the PDFium dynamic library, in
/// probe order: explicit override (`PDFIUM_LIB_DIR`), next to the executable,
/// and the development checkout where `scripts/fetch-pdfium.sh` installs it.
/// Absent candidates are skipped at probe time; see `pdf/render.rs` and
/// docs/build.md. (Packaged-resource probing returns with the Electron
/// packaging work — docs/electron-migration.md.)
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
    let db_path = resolve_db_path();
    let pool = init_pool(&db_path)
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

    Ok(AppState {
        db: pool,
        db_path,
        watcher: Arc::new(watcher),
    })
}

/// Service entry point: JSON-RPC over stdio until stdin closes.
pub async fn run() -> i32 {
    rpc::serve().await
}
