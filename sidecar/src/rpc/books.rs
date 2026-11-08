//! Book, trash, and provider-link commands.

use serde_json::Value;

use crate::commands;
use crate::domain::RestoreMode;
use crate::AppState;

use super::{parse_params, BookIdArgs, BookUidArgs, EventEmitter, RpcError};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookFileArgs {
    book_id: i64,
    file_id: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditionLinkArgs {
    source_book_id: i64,
    target_book_id: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookIdsArgs {
    book_ids: Vec<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreBookArgs {
    trash_id: i64,
    #[serde(default)]
    mode: Option<RestoreMode>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryArgs {
    query: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingHistoryArgs {
    #[serde(default)]
    query: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderLinkArgs {
    book_uid: String,
    provider: String,
    remote_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUnlinkArgs {
    book_uid: String,
    provider: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUpdateArgs {
    book_uid: String,
    provider: String,
    #[serde(default)]
    status: Option<crate::domain::ProviderReadingStatus>,
    #[serde(default)]
    progress_percent: Option<f64>,
}

pub(super) async fn dispatch(
    state: &AppState,
    events: &EventEmitter,
    method: &str,
    params: &Value,
) -> Result<Option<Value>, RpcError> {
    match method {
        "get_library_stats" => Ok(Some(call!(commands::books::get_library_stats(state)))),
        "list_books" => Ok(Some(call!(commands::books::list_books(state)))),
        "list_book_files" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::list_book_files(
                state, p.book_id
            ))))
        }
        "list_book_editions" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::list_book_editions(
                state, p.book_id
            ))))
        }
        "link_book_edition" => {
            let p: EditionLinkArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::link_book_edition(
                state,
                events,
                p.source_book_id,
                p.target_book_id
            ))))
        }
        "remove_book_file" => {
            let p: BookFileArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::remove_book_file(
                state, events, p.book_id, p.file_id
            ))))
        }
        "list_reading_history" => {
            let p: ReadingHistoryArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::list_reading_history(
                state, p.query
            ))))
        }
        "list_provider_links" => {
            let p: BookUidArgs = parse_params(params)?;
            Ok(Some(call!(commands::providers::list_provider_links(
                state, p.book_uid
            ))))
        }
        "link_provider_book" => {
            let p: ProviderLinkArgs = parse_params(params)?;
            Ok(Some(call!(commands::providers::link_provider_book(
                state,
                p.book_uid,
                p.provider,
                p.remote_id
            ))))
        }
        "unlink_provider_book" => {
            let p: ProviderUnlinkArgs = parse_params(params)?;
            Ok(Some(call!(commands::providers::unlink_provider_book(
                state, p.book_uid, p.provider
            ))))
        }
        "apply_provider_reading_update" => {
            let p: ProviderUpdateArgs = parse_params(params)?;
            Ok(Some(call!(
                commands::providers::apply_provider_reading_update(
                    state,
                    p.book_uid,
                    p.provider,
                    p.status,
                    p.progress_percent
                )
            )))
        }
        "search_books" => {
            let p: QueryArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::search_books(state, p.query))))
        }
        "remove_book" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::remove_book(
                state, events, p.book_id
            ))))
        }
        "reset_book_reading_data" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::reset_book_reading_data(
                state, events, p.book_id
            ))))
        }
        "retry_indexing" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::retry_indexing(
                state, events, p.book_id
            ))))
        }
        "forget_book" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::forget_book(
                state, events, p.book_id
            ))))
        }
        "forget_books" => {
            let p: BookIdsArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::forget_books(
                state, events, p.book_ids
            ))))
        }
        "list_book_trash" => Ok(Some(call!(commands::books::list_book_trash(state)))),
        "restore_book" => {
            let p: RestoreBookArgs = parse_params(params)?;
            Ok(Some(call!(commands::books::restore_book(
                state, events, p.trash_id, p.mode
            ))))
        }
        _ => Ok(None),
    }
}
