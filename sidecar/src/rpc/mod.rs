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
//! camelCase parameter and result DTOs. Each command module below owns one
//! domain's arms; `dispatch` tries them in turn and falls back to
//! method-not-found, so every method name resolves by exact match.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::mpsc;

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
        ::serde_json::json!(result)
    }};
}

mod books;
mod catalog;
mod library;
mod reader;
mod sync;

/// Extract one method's typed arguments from the `params` object.
fn parse_params<T: DeserializeOwned>(value: &Value) -> Result<T, RpcError> {
    serde_json::from_value(value.clone()).map_err(|err| RpcError::invalid_params(err.to_string()))
}

/// Shared id-typed arguments. `IdArgs` is the bare-`id` shape (annotations,
/// sync issue rows); `BookIdArgs` and `BookUidArgs` carry the book name most
/// methods use.
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
struct BookUidArgs {
    book_uid: String,
}

/// The method table. Returns the JSON value to send as the request's result.
/// Every command module answers by exact method name; an unknown name is
/// method-not-found, exactly as before the split.
async fn dispatch(
    state: &AppState,
    events: &EventEmitter,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    if method == "ping" {
        return Ok(json!("pong"));
    }
    if let Some(result) = books::dispatch(state, events, method, &params).await? {
        return Ok(result);
    }
    if let Some(result) = library::dispatch(state, events, method, &params).await? {
        return Ok(result);
    }
    if let Some(result) = reader::dispatch(state, events, method, &params).await? {
        return Ok(result);
    }
    if let Some(result) = catalog::dispatch(state, events, method, &params).await? {
        return Ok(result);
    }
    if let Some(result) = sync::dispatch(state, events, method, &params).await? {
        return Ok(result);
    }
    Err(RpcError::method_not_found(method))
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

    if let Some(sync) = &state.sync {
        sync.shutdown().await;
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
mod tests;
