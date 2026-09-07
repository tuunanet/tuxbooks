//! JSON-RPC 2.0 over stdio: the IPC boundary between the Electron main
//! process and the native service (docs/electron-migration.md).
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
        Self::app(err)
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
        "get_reading_progress" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::progress::get_reading_progress(
                state, p.book_id
            )))
        }
        "save_reading_progress" => {
            let p: SaveProgressArgs = parse_params(params)?;
            Ok(call!(commands::progress::save_reading_progress(
                state, p.book_id, p.progress
            )))
        }
        "mark_book_finished" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(call!(commands::progress::mark_book_finished(
                state, p.book_id
            )))
        }
        "get_book_bytes" => {
            let p: BookBytesArgs = parse_params(params)?;
            Ok(call!(commands::reader::get_book_bytes(
                state, p.book_id, p.offset, p.length
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
            let p: IdArgs = parse_params(params)?;
            Ok(call!(commands::collections::delete_collection(state, p.id)))
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

/// Parse one request line and dispatch it. Malformed JSON without an id
/// cannot be answered (JSON-RPC id is required here), so it is logged.
fn handle_line(
    state: &Arc<AppState>,
    events: &EventEmitter,
    tx: &mpsc::UnboundedSender<String>,
    line: &str,
) {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("malformed request: {err}");
            return;
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method.to_string(),
        None => {
            let err = RpcError {
                code: -32600,
                message: "request is missing the method field".into(),
            };
            let _ignored = tx.send(format!("{}\n", err.error_response(id)));
            return;
        }
    };
    let params = request.get("params").cloned().unwrap_or(json!({}));

    let state = state.clone();
    let events = events.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let line = match dispatch(&state, &events, &method, params).await {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string(),
            Err(err) => err.error_response(id).to_string(),
        };
        let _ignored = tx.send(format!("{line}\n"));
    });
}
