//! Sync commands: connect, status, waiting books, issues, trash.

use serde_json::Value;

use crate::commands;
use crate::AppState;

use super::{parse_params, BookUidArgs, EventEmitter, IdArgs, RpcError};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncConnectArgs {
    path: String,
    device_name: Option<String>,
    confirm_library_id: Option<String>,
    #[serde(default)]
    start_new: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncDeviceNameArgs {
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncAutoRetryArgs {
    enabled: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachWaitingBookArgs {
    book_uid: String,
    path: String,
}

pub(super) async fn dispatch(
    state: &AppState,
    events: &EventEmitter,
    method: &str,
    params: &Value,
) -> Result<Option<Value>, RpcError> {
    match method {
        "sync_status" => Ok(Some(call!(commands::sync::status(state)))),
        "sync_connect" => {
            let p: SyncConnectArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::connect(
                state,
                p.path,
                p.device_name,
                p.confirm_library_id,
                p.start_new
            ))))
        }
        "sync_disconnect" => Ok(Some(call!(commands::sync::disconnect(state)))),
        "sync_now" => Ok(Some(call!(commands::sync::sync_now(state)))),
        "list_waiting_books" => Ok(Some(call!(commands::sync::waiting_books(state)))),
        "forget_waiting_book" => {
            let p: BookUidArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::forget_waiting_book(
                state, p.book_uid
            ))))
        }
        "forget_all_waiting_books" => {
            Ok(Some(call!(commands::sync::forget_all_waiting_books(state))))
        }
        "attach_waiting_book" => {
            let p: AttachWaitingBookArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::attach_waiting_book(
                state, events, p.book_uid, p.path
            ))))
        }
        "sync_issues" => Ok(Some(call!(commands::sync::issues(state)))),
        "dismiss_all_sync_issues" => Ok(Some(call!(commands::sync::dismiss_all_issues(state)))),
        "sync_dismiss_issue" => {
            let p: IdArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::dismiss_issue(state, p.id))))
        }
        "sync_retry_issue" => {
            let p: IdArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::retry_issue(state, p.id))))
        }
        "sync_trash" => Ok(Some(call!(commands::sync::trash(state)))),
        "sync_restore" => {
            let p: IdArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::restore(state, p.id))))
        }
        "sync_set_device_name" => {
            let p: SyncDeviceNameArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::set_device_name(state, p.name))))
        }
        "sync_set_auto_retry" => {
            let p: SyncAutoRetryArgs = parse_params(params)?;
            Ok(Some(call!(commands::sync::set_auto_retry(
                state, p.enabled
            ))))
        }
        "sync_diagnostics" => Ok(Some(call!(commands::sync::diagnostics(state)))),
        _ => Ok(None),
    }
}
