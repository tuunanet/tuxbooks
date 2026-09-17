#![no_main]

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use libfuzzer_sys::fuzz_target;
use serde_json::{json, Value};
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::NewBook;
use tuxbooks_lib::repository::books::insert_book;
use tuxbooks_lib::rpc::{handle_request_line, EventEmitter, RequestLineOutcome};
use tuxbooks_lib::services::library_reconciler::Reconciler;
use tuxbooks_lib::services::library_watcher::{LibraryWatcher, WatcherConfig};
use tuxbooks_lib::AppState;

struct FuzzEnv {
    library_dir: PathBuf,
    state: Arc<AppState>,
    events: EventEmitter,
    runtime: tokio::runtime::Runtime,
}

/// One process-lifetime service state in a scratch directory: empty library
/// directory, seeded book row, real SQLite schema. Mutated requests run
/// against it exactly like they would against the sidecar. The scratch
/// stays inside the fuzz target dir (in-workspace, gitignored) and is wiped
/// at init, so repeated runs never accumulate and nothing is written
/// outside the workspace.
fn env() -> &'static FuzzEnv {
    static ENV: OnceLock<FuzzEnv> = OnceLock::new();
    ENV.get_or_init(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("fuzz runtime");
        let scratch = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/json-rpc-scratch");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).expect("fuzz scratch dir");
        let library_dir = scratch.join("library");
        std::fs::create_dir_all(&library_dir).expect("fuzz library dir");
        let state = runtime.block_on(build_state(&scratch, &library_dir));
        FuzzEnv {
            library_dir,
            state: Arc::new(state),
            events: EventEmitter::new(|_, _| {}),
            runtime,
        }
    })
}

async fn build_state(root: &Path, library_dir: &Path) -> AppState {
    let db_path = root.join("fuzz.db");
    let pool = init_pool(&db_path).await.expect("fuzz database");
    let reconciler = Arc::new(Reconciler::new(
        pool.clone(),
        tuxbooks_lib::covers_dir(&db_path),
        Vec::new(),
        tokio::runtime::Handle::current(),
        Box::new(|_| {}),
    ));
    let watcher = LibraryWatcher::start(WatcherConfig {
        reconciler,
        debounce: std::time::Duration::from_millis(50),
    })
    .expect("fuzz watcher");
    let state = AppState {
        db: pool,
        db_path,
        watcher: Arc::new(watcher),
    };
    let book = NewBook {
        path: library_dir.join("seed.epub").to_string_lossy().into_owned(),
        title: "Fuzz Seed".into(),
        subtitle: None,
        author: Some("Ada Lovelace".into()),
        authors: vec!["Ada Lovelace".into()],
        subjects: Vec::new(),
        publisher: None,
        language: Some("en".into()),
        isbn: None,
        description: None,
        cover_path: None,
        publication_date: None,
        series: None,
        series_index: None,
        file_size: 1,
        file_mtime: 1_700_000_000,
    };
    insert_book(&state.db, &book).await.expect("fuzz seed book");
    state
}

/// Filesystem-path parameters are pinned into the scratch directory before
/// the request runs, so mutated paths can never point outside it. Values
/// that are not the expected string shape stay untouched: param decoding
/// fails with -32602 before anything reaches the filesystem.
fn gate_filesystem_paths(method: &str, request: &mut Value, library_dir: &Path) {
    let Some(params) = request.get_mut("params") else {
        return;
    };
    let in_scratch = |name: &str| json!(library_dir.join(name).to_string_lossy());
    let is_string = |params: &Value, key: &str| {
        params
            .get(key)
            .map(Value::is_string)
            .unwrap_or(false)
    };
    match method {
        "scan_library" => {
            if is_string(params, "path") {
                params["path"] = json!(library_dir.to_string_lossy());
            }
        }
        "import_paths" => {
            let all_strings = params
                .get("paths")
                .and_then(Value::as_array)
                .map(|paths| paths.iter().all(Value::is_string))
                .unwrap_or(false);
            if all_strings {
                params["paths"] = json!([library_dir.to_string_lossy()]);
            }
        }
        "reconnect_book" => {
            if is_string(params, "path") {
                params["path"] = in_scratch("seed.epub");
            }
        }
        "set_book_cover" => {
            if is_string(params, "imagePath") {
                params["imagePath"] = in_scratch("cover.png");
            }
        }
        "create_collection" => {
            if is_string(params, "name") {
                params["name"] = json!("fuzz-collection");
            }
        }
        _ => {}
    }
}

fuzz_target!(|data: &[u8]| {
    let env = env();
    let mut line = String::from_utf8_lossy(data).into_owned();
    if let Ok(mut request) = serde_json::from_str::<Value>(&line) {
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(method) = method.as_deref() {
            gate_filesystem_paths(method, &mut request, &env.library_dir);
            line = request.to_string();
        }
    }
    match env
        .runtime
        .block_on(handle_request_line(&env.state, &env.events, &line))
    {
        RequestLineOutcome::Response(response) => {
            let parsed: Value = serde_json::from_str(response.trim_end())
                .expect("every JSON-RPC response line is valid JSON");
            let _ = parsed;
        }
        RequestLineOutcome::Malformed(_) => {}
    }
});
