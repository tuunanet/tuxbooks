//! rpc tests: the stdio envelope and error mapping. Method-level tests live
//! in `dispatch`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;

mod dispatch;

async fn test_state(dir: &std::path::Path) -> Arc<AppState> {
    let pool = crate::db::connection::init_pool(&dir.join("t.db"))
        .await
        .unwrap();
    let reconciler = Arc::new(crate::services::library_reconciler::Reconciler::new(
        pool.clone(),
        dir.join("covers"),
        Vec::new(),
        tokio::runtime::Handle::current(),
        Box::new(|_| {}),
    ));
    let watcher = crate::services::library_watcher::LibraryWatcher::start(
        crate::services::library_watcher::WatcherConfig {
            reconciler,
            debounce: std::time::Duration::from_millis(50),
        },
    )
    .unwrap();
    Arc::new(AppState {
        db: pool,
        db_path: dir.join("t.db"),
        watcher: Arc::new(watcher),
        startup_recovery: None,
        sync: None,
        importing: Default::default(),
    })
}

fn test_events() -> EventEmitter {
    EventEmitter::new(|_, _| {})
}

/// Everything one test captured: `(event name, serialized payload)`.
type FiredEvents = Vec<(&'static str, Value)>;

/// EventEmitter paired with the events it fired, for asserting what a
/// method pushes to the client.
fn capturing_events() -> (EventEmitter, Arc<Mutex<FiredEvents>>) {
    let fired: Arc<Mutex<FiredEvents>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&fired);
    let events = EventEmitter::new(move |name, payload| {
        sink.lock().unwrap().push((name, payload));
    });
    (events, fired)
}

/// Seed one book row through the repository (the importer needs files on
/// disk); returns its id.
async fn seed_book(state: &AppState, title: &str) -> i64 {
    let book = crate::domain::NewBook {
        path: format!("/library/{title}.epub"),
        title: title.into(),
        subtitle: None,
        author: Some("Author".into()),
        authors: vec!["Author".into()],
        subjects: Vec::new(),
        publisher: None,
        language: Some("en".into()),
        isbn: None,
        description: None,
        cover_path: None,
        publication_date: None,
        series: None,
        series_index: None,
        file_size: 100,
        file_mtime: 1_700_000_000,
    };
    crate::repository::books::insert_book(&state.db, &book)
        .await
        .unwrap()
}

/// Pull one response line off the channel (or None on timeout/close).
async fn next_response(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Option<Value> {
    let line = tokio::time::timeout(std::time::Duration::from_millis(2_000), rx.recv())
        .await
        .ok()??;
    serde_json::from_str(&line).ok()
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_json_lines_are_ignored_without_crashing() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    handle_line(&state, &test_events(), &tx, "{not json");
    handle_line(&state, &test_events(), &tx, "");
    // Nothing answerable was sent; no response may be produced.
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), rx.recv())
            .await
            .is_err()
    );
    // And the service is still alive.
    let answered = dispatch(&state, &test_events(), "ping", json!({}))
        .await
        .unwrap();
    assert_eq!(answered, json!("pong"));
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_without_a_method_field_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    handle_line(&state, &test_events(), &tx, r#"{"jsonrpc":"2.0","id":9}"#);
    let response = next_response(&mut rx).await.expect("error response");
    assert_eq!(response["id"], json!(9));
    assert_eq!(response["error"]["code"], json!(-32600));
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_params_are_rejected_and_the_service_stays_alive() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    handle_line(
        &state,
        &test_events(),
        &tx,
        r#"{"jsonrpc":"2.0","id":3,"method":"scan_library","params":{"path":42}}"#,
    );
    let response = next_response(&mut rx).await.expect("error response");
    assert_eq!(response["id"], json!(3));
    assert_eq!(response["error"]["code"], json!(-32602));
    // Same channel, next request: the sidecar is unaffected.
    let answered = dispatch(&state, &test_events(), "ping", json!({}))
        .await
        .unwrap();
    assert_eq!(answered, json!("pong"));
}

#[test]
fn worker_failures_map_to_typed_rpc_codes() {
    use crate::worker::client::WorkerError;
    assert_eq!(WorkerError::Deadline.rpc_code(), -32001);
    assert_eq!(
        WorkerError::Limit(crate::limits::LimitExceeded {
            limit: "max_parse_seconds",
            detail: "x".into(),
        })
        .rpc_code(),
        -32002
    );
    assert_eq!(WorkerError::Sandbox("no".into()).rpc_code(), -32003);
    assert_eq!(
        WorkerError::Unavailable("missing".into()).rpc_code(),
        -32004
    );
}

#[test]
fn app_error_worker_branch_carries_the_worker_code() {
    let err = AppError::Worker(crate::worker::client::WorkerError::Deadline);
    let rpc = RpcError::from(err);
    assert_eq!(rpc.code, -32001);
}
