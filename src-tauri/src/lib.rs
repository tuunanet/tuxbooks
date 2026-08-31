mod commands;
pub mod db;
pub mod domain;
pub mod epub;
pub mod error;
pub mod pdf;
pub mod repository;
pub mod services;

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tauri::Manager;

use crate::db::connection::init_pool;

#[derive(Debug, Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub db_path: PathBuf,
}

/// Directory where imported cover images are extracted, derived from the DB path.
pub fn covers_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("covers")
}

/// Production uses the OS app-data directory; tests override via `TEST_DATABASE_PATH`.
fn resolve_db_path(handle: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(path) = std::env::var("TEST_DATABASE_PATH") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    let dir = handle.path().app_data_dir()?;
    Ok(dir.join("tuxbooks.db"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // Test-only plugin backing @wdio/tauri-service (execute, mocking, log
    // forwarding). Debug binaries only — release builds never register it.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio::init());

    builder
        .setup(|app| {
            let db_path = resolve_db_path(app.handle())?;
            let pool = tauri::async_runtime::block_on(init_pool(&db_path)).map_err(|e| {
                anyhow::anyhow!("failed to initialize database at {db_path:?}: {e}")
            })?;

            if let Ok(library_root) = std::env::var("TEST_LIBRARY_PATH") {
                if !library_root.is_empty() {
                    let covers = covers_dir(&db_path);
                    let report = tauri::async_runtime::block_on(
                        services::book_importer::import_directory(
                            &pool,
                            Path::new(&library_root),
                            &covers,
                        ),
                    )
                    .map_err(|e| anyhow::anyhow!("failed to import library {library_root}: {e}"))?;
                    println!("imported test library: {report:?}");
                }
            }

            app.manage(AppState { db: pool, db_path });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::books::get_library_stats,
            commands::books::list_books,
            commands::library::scan_library,
            commands::reader::get_book_toc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tuxbooks");
}
