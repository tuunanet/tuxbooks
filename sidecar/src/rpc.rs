//! JSON-RPC 2.0 over stdio: the IPC boundary between the Electron main
//! process and the native service (docs/ARCHITECTURE.md).
//!
//! Framing is newline-delimited JSON. Clients send request objects
//! (`{jsonrpc, id, method, params}`); the service answers per request with
//! `{jsonrpc, id, result}` or `{jsonrpc, id, error}`. Server-initiated
//! events (library changes, import progress) arrive as notifications:
//! `{jsonrpc, method: "event", params: {name, payload}}`.
//!
//! The method table is one method per former Tauri command, with the same
//! camelCase parameter and result DTOs.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::mpsc;

use crate::commands;
use crate::error::AppError;
use crate::{init_state, AppState};

/// Callback through which service-layer changes reach the client. Cloneable
/// and thread-safe: the filesystem watcher thread emits through the same
/// instance that request handlers use.
#[derive(Clone)]
pub struct EventEmitter {
    send: Arc<dyn Fn(&'static str, Value) + Send + Sync>,
}

impl EventEmitter {
    pub fn new<F>(send: F) -> Self
    where
        F: Fn(&'static str, Value) + Send + Sync + 'static,
    {
        Self {
            send: Arc::new(send),
        }
    }

    /// Serialize and forward one event. Serialization of the app's own DTOs
    /// cannot fail, so an error is only logged, never propagated.
    pub fn emit<T: Serialize>(&self, name: &'static str, payload: &T) {
        match serde_json::to_value(payload) {
            Ok(value) => (self.send)(name, value),
            Err(err) => eprintln!("failed to serialize event {name}: {err}"),
        }
    }
}

/// JSON-RPC error object: a transport-protocol code plus a human-readable
/// message (the `AppError` display string at the boundary).
#[derive(Debug)]
struct RpcError {
    code: i32,
    message: String,
}

impl RpcError {
    fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("unknown method: {method}"),
        }
    }

    fn invalid_params(detail: String) -> Self {
        Self {
            code: -32602,
            message: detail,
        }
    }

    fn app(err: AppError) -> Self {
        Self {
            code: -32000,
            message: err.to_string(),
        }
    }

    fn error_response(self, id: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "error": {"code": self.code, "message": self.message}})
    }
}

impl From<AppError> for RpcError {
    fn from(err: AppError) -> Self {
        // Worker-sourced failures map by kind (Task 2 ledger): deadline
        // -32001, limit -32002, sandbox -32003, other worker failures
        // -32004. All other app errors keep the generic -32000.
        match err {
            AppError::Worker(worker) => Self {
                code: worker.rpc_code(),
                message: worker.to_string(),
            },
            other => Self::app(other),
        }
    }
}

/// Await one service call, mapping `AppError` into the JSON-RPC error and
/// wrapping the result as a JSON value.
macro_rules! call {
    ($expr:expr) => {{
        let result = $expr.await?;
        json!(result)
    }};
}

/// Extract one method's typed arguments from the `params` object.
fn parse_params<T: DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|err| RpcError::invalid_params(err.to_string()))
}

/// Shared id-typed argument (most methods name a book or annotation row).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookIdArgs {
    book_id: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionIdArgs {
    collection_id: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryArgs {
    query: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathsArgs {
    paths: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameArgs {
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReconnectArgs {
    book_id: i64,
    path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverArgs {
    book_id: i64,
    image_path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionMemberArgs {
    book_id: i64,
    collection_id: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookBytesArgs {
    book_id: i64,
    offset: Option<u64>,
    length: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookResourceArgs {
    book_id: i64,
    path: String,
    offset: Option<u64>,
    length: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProgressArgs {
    book_id: i64,
    progress: commands::progress::ProgressInput,
}

/// The method table. Returns the JSON value to send as the request's result.
async fn dispatch(
    state: &AppState,
    events: &EventEmitter,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    match method {
        "ping" => Ok(json!("pong")),
        "get_library_stats" => Ok(call!(commands::books::get_library_stats(state))),
        "get_storage_stats" => Ok(call!(commands::library::get_storage_stats(state))),
        "get_startup_recovery" => Ok(call!(commands::library::get_startup_recovery(state))),
        "list_books" => Ok(call!(commands::books::list_books(state))),
        "search_books" => {
            let p: QueryArgs = parse_params(params)?;
            Ok(call!(commands::books::search_books(state, p.query)))
        }
        "remove_book" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::books::remove_book(
                state, events, p.book_id
            )))
        }
        "scan_library" => {
            let p: PathArgs = parse_params(params)?;
            Ok(call!(commands::library::scan_library(
                state, events, p.path
            )))
        }
        "import_paths" => {
            let p: PathsArgs = parse_params(params)?;
            Ok(call!(commands::library::import_paths(
                state, events, p.paths
            )))
        }
        "reconnect_book" => {
            let p: ReconnectArgs = parse_params(params)?;
            Ok(call!(commands::library::reconnect_book(
                state, events, p.book_id, p.path
            )))
        }
        "get_book_metadata" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::metadata::get_book_metadata(
                state, p.book_id
            )))
        }
        "get_book_file_properties" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::metadata::get_book_file_properties(
                state, p.book_id
            )))
        }
        "update_book_metadata" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                book_id: i64,
                form: crate::domain::MetadataFields,
            }
            let p: Args = parse_params(params)?;
            Ok(call!(commands::metadata::update_book_metadata(
                state, events, p.book_id, p.form
            )))
        }
        "set_metadata_field_source" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                book_id: i64,
                field: String,
                source: Option<crate::domain::MetadataFieldSource>,
            }
            let p: Args = parse_params(params)?;
            Ok(call!(commands::metadata::set_metadata_field_source(
                state, events, p.book_id, p.field, p.source
            )))
        }
        "reset_book_metadata" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::metadata::reset_book_metadata(
                state, events, p.book_id
            )))
        }
        "set_book_cover" => {
            let p: CoverArgs = parse_params(params)?;
            Ok(call!(commands::metadata::set_book_cover(
                state,
                events,
                p.book_id,
                p.image_path
            )))
        }
        "clear_book_cover_override" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::metadata::clear_book_cover_override(
                state, events, p.book_id
            )))
        }
        "embed_book_metadata" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                book_id: i64,
                form: crate::domain::MetadataFields,
            }
            let p: Args = parse_params(params)?;
            Ok(call!(commands::metadata::embed_book_metadata(
                state, events, p.book_id, p.form
            )))
        }
        "get_reading_progress" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::progress::get_reading_progress(
                state, p.book_id
            )))
        }
        "save_reading_progress" => {
            let p: SaveProgressArgs = parse_params(params)?;
            Ok(call!(commands::progress::save_reading_progress(
                state, events, p.book_id, p.progress
            )))
        }
        "mark_book_finished" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::progress::mark_book_finished(
                state, events, p.book_id
            )))
        }
        "mark_book_opened" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::progress::mark_book_opened(
                state, events, p.book_id
            )))
        }
        "get_book_bytes" => {
            let p: BookBytesArgs = parse_params(params)?;
            Ok(call!(commands::reader::get_book_bytes(
                state, p.book_id, p.offset, p.length
            )))
        }
        "get_epub_session" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::reader::get_epub_session(state, p.book_id)))
        }
        "get_book_resource" => {
            let p: BookResourceArgs = parse_params(params)?;
            Ok(call!(commands::reader::get_book_resource(
                state, p.book_id, &p.path, p.offset, p.length
            )))
        }
        "list_collections" => Ok(call!(commands::collections::list_collections(state))),
        "create_collection" => {
            let p: NameArgs = parse_params(params)?;
            Ok(call!(commands::collections::create_collection(
                state, p.name
            )))
        }
        "delete_collection" => {
            // The wire param stays `collectionId`, as the bridge has always
            // sent it (only the annotation methods use a bare `id`).
            let p: CollectionIdArgs = parse_params(params)?;
            Ok(call!(commands::collections::delete_collection(
                state,
                p.collection_id
            )))
        }
        "add_book_to_collection" => {
            let p: CollectionMemberArgs = parse_params(params)?;
            Ok(call!(commands::collections::add_book_to_collection(
                state,
                p.book_id,
                p.collection_id
            )))
        }
        "remove_book_from_collection" => {
            let p: CollectionMemberArgs = parse_params(params)?;
            Ok(call!(commands::collections::remove_book_from_collection(
                state,
                p.book_id,
                p.collection_id
            )))
        }
        "list_annotations" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::annotations::list_annotations(
                state, p.book_id
            )))
        }
        "create_annotation" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                book_id: i64,
                annotation: commands::annotations::AnnotationInput,
            }
            let p: Args = parse_params(params)?;
            Ok(call!(commands::annotations::create_annotation(
                state,
                p.book_id,
                p.annotation
            )))
        }
        "update_annotation" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                id: i64,
                patch: commands::annotations::AnnotationPatchInput,
            }
            let p: Args = parse_params(params)?;
            Ok(call!(commands::annotations::update_annotation(
                state, p.id, p.patch
            )))
        }
        "delete_annotation" => {
            let p: IdArgs = parse_params(params)?;
            Ok(call!(commands::annotations::delete_annotation(state, p.id)))
        }
        other => Err(RpcError::method_not_found(other)),
    }
}

/// Run the service: initialize state, then serve JSON-RPC requests over
/// stdio until stdin closes. Returns the process exit code.
pub async fn serve() -> i32 {
    // Outbound lines (responses and events) flow through one channel into a
    // dedicated writer task, so concurrent request handlers and the watcher
    // thread never interleave partial writes.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut out = BufWriter::new(tokio::io::stdout());
        while let Some(line) = rx.recv().await {
            if out.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if out.flush().await.is_err() {
                break;
            }
        }
    });

    let request_tx = tx.clone();
    let events = EventEmitter::new(move |name, payload| {
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "event",
            "params": {"name": name, "payload": payload},
        });
        let _ignored = tx.send(format!("{notification}\n"));
    });

    let state = match init_state(events.clone()).await {
        Ok(state) => Arc::new(state),
        Err(err) => {
            eprintln!("tuxbooks service failed to start: {err}");
            return 1;
        }
    };
    eprintln!("tuxbooks service ready");

    // stdin closed → the client is gone; drop the sender so the writer
    // task drains and exits.
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                handle_line(&state, &events, &request_tx, trimmed);
            }
            Ok(None) => break,
            Err(err) => {
                eprintln!("failed to read request: {err}");
                break;
            }
        }
    }

    drop(request_tx);
    let _ignored = writer.await;
    0
}

/// Outcome of one request line through the boundary logic.
pub enum RequestLineOutcome {
    /// A formatted JSON-RPC response line (result or error object).
    Response(String),
    /// Not decodable JSON: nothing is answerable. `handle_line` logs it.
    Malformed(String),
}

/// One request line taken through decode, envelope validation, dispatch,
/// and response formatting. Split out from `handle_line` so the fuzz
/// target (issue #88) drives the exact boundary code instead of a mirror
/// of it.
pub async fn handle_request_line(
    state: &Arc<AppState>,
    events: &EventEmitter,
    line: &str,
) -> RequestLineOutcome {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => return RequestLineOutcome::Malformed(err.to_string()),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method.to_string(),
        None => {
            let err = RpcError {
                code: -32600,
                message: "request is missing the method field".into(),
            };
            return RequestLineOutcome::Response(format!("{}\n", err.error_response(id)));
        }
    };
    let params = request.get("params").cloned().unwrap_or(json!({}));
    let body = match dispatch(state, events, &method, params).await {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string(),
        Err(err) => err.error_response(id).to_string(),
    };
    RequestLineOutcome::Response(format!("{body}\n"))
}

/// Parse one request line and dispatch it. Malformed JSON without an id
/// cannot be answered (JSON-RPC id is required here), so it is logged.
fn handle_line(
    state: &Arc<AppState>,
    events: &EventEmitter,
    tx: &mpsc::UnboundedSender<String>,
    line: &str,
) {
    let state = state.clone();
    let events = events.clone();
    let tx = tx.clone();
    let line = line.to_string();
    tokio::spawn(async move {
        match handle_request_line(&state, &events, &line).await {
            RequestLineOutcome::Response(response) => {
                let _ignored = tx.send(response);
            }
            RequestLineOutcome::Malformed(err) => eprintln!("malformed request: {err}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

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

    #[tokio::test(flavor = "multi_thread")]
    async fn saving_progress_emits_library_changed_with_the_updated_book() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let id = seed_book(&state, "Progress Book").await;
        let (events, fired) = capturing_events();

        dispatch(
            &state,
            &events,
            "save_reading_progress",
            json!({"bookId": id, "progress": {"progressPercent": 42.5}}),
        )
        .await
        .unwrap();

        let fired = fired.lock().unwrap();
        assert_eq!(fired.len(), 1, "one event per persisted save");
        let (name, payload) = &fired[0];
        assert_eq!(*name, "library-changed");
        assert_eq!(payload["kind"], "changed");
        assert_eq!(payload["book"]["id"], json!(id));
        assert_eq!(payload["book"]["progressPercent"], json!(42.5));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn marking_finished_emits_library_changed_with_full_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let id = seed_book(&state, "Finished Book").await;
        let (events, fired) = capturing_events();

        dispatch(&state, &events, "mark_book_finished", json!({"bookId": id}))
            .await
            .unwrap();

        let fired = fired.lock().unwrap();
        assert_eq!(fired.len(), 1);
        let (name, payload) = &fired[0];
        assert_eq!(*name, "library-changed");
        assert_eq!(payload["kind"], "changed");
        assert_eq!(payload["book"]["progressPercent"], json!(100.0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn marking_opened_stamps_last_opened_and_emits_library_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let id = seed_book(&state, "Opened Book").await;
        let (events, fired) = capturing_events();
        let book = crate::repository::books::get_book(&state.db, id)
            .await
            .unwrap()
            .unwrap();
        assert!(book.last_opened_at.is_none(), "seed starts unopened");

        dispatch(&state, &events, "mark_book_opened", json!({"bookId": id}))
            .await
            .unwrap();

        let book = crate::repository::books::get_book(&state.db, id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            book.last_opened_at.is_some(),
            "lastOpenedAt must be stamped"
        );
        let fired = fired.lock().unwrap();
        assert_eq!(fired.len(), 1);
        let (name, payload) = &fired[0];
        assert_eq!(*name, "library-changed");
        assert_eq!(payload["kind"], "changed");
        assert_eq!(payload["book"]["id"], json!(id));
        assert!(payload["book"]["lastOpenedAt"].as_str().is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn import_paths_streams_batched_progress_events() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("library");
        std::fs::create_dir_all(&lib).unwrap();
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Batch Book</dc:title><dc:language>en</dc:language></metadata>
<manifest/><spine/></package>"#;
        for name in ["one.epub", "two.epub"] {
            crate::epub::parser::tests_support::write_zip(
                &lib.join(name),
                &[
                    ("mimetype", "application/epub+zip".as_bytes()),
                    (
                        "META-INF/container.xml",
                        br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                    ),
                    ("content.opf", opf.as_bytes()),
                ],
            );
        }
        let state = test_state(tmp.path()).await;
        let (events, fired) = capturing_events();

        let result = dispatch(
            &state,
            &events,
            "import_paths",
            json!({"paths": [lib.to_string_lossy()]}),
        )
        .await
        .unwrap();

        assert_eq!(result["imported"], json!(2));
        let fired = fired.lock().unwrap();
        assert_eq!(
            fired.len(),
            1,
            "batched: one event for both books, not one per book"
        );
        let (name, payload) = &fired[0];
        assert_eq!(*name, "import-progress");
        let books = payload["books"].as_array().expect("payload.books array");
        assert_eq!(books.len(), 2);
        for book in books {
            assert!(book["id"].as_i64().unwrap() > 0);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn embed_book_metadata_accepts_the_form_param() {
        // The bridge sends `{bookId, form}`; a bad shape would fail param
        // parsing (-32602). The seeded row has no file on disk, so the call
        // reaches the service and fails there (-32000) — proving the method
        // and its form argument are wired.
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let id = seed_book(&state, "Embed Book").await;
        let err = dispatch(
            &state,
            &test_events(),
            "embed_book_metadata",
            json!({
                "bookId": id,
                "form": {
                    "title": "Embed Book",
                    "subtitle": null,
                    "publisher": null,
                    "language": null,
                    "isbn": null,
                    "description": null,
                    "publicationDate": null,
                    "series": null,
                    "seriesIndex": null,
                    "authors": ["Author"],
                    "subjects": []
                }
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, -32000, "reached the service, not param parsing");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ping_answers_pong() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let result = dispatch(&state, &test_events(), "ping", json!({}))
            .await
            .unwrap();
        assert_eq!(result, json!("pong"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_storage_stats_reports_the_wire_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let result = dispatch(&state, &test_events(), "get_storage_stats", json!({}))
            .await
            .unwrap();
        assert_eq!(result["locations"], json!([]));
        assert_eq!(result["bookTotalBytes"], json!(0));
        assert_eq!(
            result["catalog"],
            json!({
                "books": 0,
                "authors": 0,
                "collections": 0,
                "annotations": 0,
                "readingProgress": 0,
            })
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_startup_recovery_is_null_for_a_healthy_database() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let result = dispatch(&state, &test_events(), "get_startup_recovery", json!({}))
            .await
            .unwrap();
        assert_eq!(result, json!(null));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_startup_recovery_reports_the_quarantine_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let mut recovered = (*state).clone();
        recovered.startup_recovery = Some(crate::domain::StartupRecovery {
            from: "/data/tuxbooks.db".into(),
            to: "/data/tuxbooks.db.corrupt-20260922T080000.000Z".into(),
        });
        let recovered = Arc::new(recovered);

        let result = dispatch(
            &recovered,
            &test_events(),
            "get_startup_recovery",
            json!({}),
        )
        .await
        .unwrap();
        assert_eq!(result["from"], json!("/data/tuxbooks.db"));
        assert_eq!(
            result["to"],
            json!("/data/tuxbooks.db.corrupt-20260922T080000.000Z")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unknown_methods_are_method_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let err = dispatch(&state, &test_events(), "nope", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code, -32601);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn delete_collection_takes_the_bridge_wire_param() {
        // The bridge has always sent `collectionId` (the Tauri-era camelCase
        // param); the method table must keep accepting exactly that shape —
        // a bare `id` here silently breaks collection deletion client-side.
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let events = test_events();
        let created = dispatch(&state, &events, "create_collection", json!({"name": "Q"}))
            .await
            .unwrap();
        let id = created["id"].as_i64().unwrap();

        let deleted = dispatch(
            &state,
            &events,
            "delete_collection",
            json!({"collectionId": id}),
        )
        .await
        .unwrap();
        assert_eq!(deleted, json!(true));

        let malformed = dispatch(&state, &events, "delete_collection", json!({"id": id}))
            .await
            .unwrap_err();
        assert_eq!(malformed.code, -32602);
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
}
