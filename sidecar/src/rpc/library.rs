//! Library scan, import, and file-reconnect commands.

use serde_json::Value;

use crate::commands;
use crate::AppState;

use super::{parse_params, EventEmitter, RpcError};

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
struct ReconnectArgs {
    book_id: i64,
    path: String,
}

pub(super) async fn dispatch(
    state: &AppState,
    events: &EventEmitter,
    method: &str,
    params: &Value,
) -> Result<Option<Value>, RpcError> {
    match method {
        "get_storage_stats" => Ok(Some(call!(commands::library::get_storage_stats(state)))),
        "get_startup_recovery" => Ok(Some(call!(commands::library::get_startup_recovery(state)))),
        "scan_library" => {
            let p: PathArgs = parse_params(params)?;
            Ok(Some(call!(commands::library::scan_library(
                state, events, p.path
            ))))
        }
        "import_paths" => {
            let p: PathsArgs = parse_params(params)?;
            Ok(Some(call!(commands::library::import_paths(
                state, events, p.paths
            ))))
        }
        "unwatch_locations" => {
            let p: PathsArgs = parse_params(params)?;
            Ok(Some(call!(commands::library::unwatch_locations(
                state, events, p.paths
            ))))
        }
        "reconnect_book" => {
            let p: ReconnectArgs = parse_params(params)?;
            Ok(Some(call!(commands::library::reconnect_book(
                state, events, p.book_id, p.path
            ))))
        }
        "relink_book" => {
            let p: ReconnectArgs = parse_params(params)?;
            Ok(Some(call!(commands::library::relink_book(
                state, events, p.book_id, p.path
            ))))
        }
        _ => Ok(None),
    }
}
