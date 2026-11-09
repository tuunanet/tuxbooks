//! Reader content and reading-progress commands.

use serde_json::Value;

use crate::commands;
use crate::AppState;

use super::{parse_params, BookIdArgs, EventEmitter, RpcError};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProgressArgs {
    book_id: i64,
    progress: commands::progress::ProgressInput,
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

pub(super) async fn dispatch(
    state: &AppState,
    events: &EventEmitter,
    method: &str,
    params: &Value,
) -> Result<Option<Value>, RpcError> {
    match method {
        "get_reading_progress" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::progress::get_reading_progress(
                state, p.book_id
            ))))
        }
        "save_reading_progress" => {
            let p: SaveProgressArgs = parse_params(params)?;
            Ok(Some(call!(commands::progress::save_reading_progress(
                state, events, p.book_id, p.progress
            ))))
        }
        "mark_book_finished" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::progress::mark_book_finished(
                state, events, p.book_id
            ))))
        }
        "mark_book_opened" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::progress::mark_book_opened(
                state, events, p.book_id
            ))))
        }
        "reader_opened" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::reader::reader_opened(
                state, p.book_id
            ))))
        }
        "reader_closed" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::reader::reader_closed(
                state, p.book_id
            ))))
        }
        "get_book_bytes" => {
            let p: BookBytesArgs = parse_params(params)?;
            Ok(Some(call!(commands::reader::get_book_bytes(
                state, p.book_id, p.offset, p.length
            ))))
        }
        "get_epub_session" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::reader::get_epub_session(
                state, p.book_id
            ))))
        }
        "get_book_resource" => {
            let p: BookResourceArgs = parse_params(params)?;
            Ok(Some(call!(commands::reader::get_book_resource(
                state, p.book_id, &p.path, p.offset, p.length
            ))))
        }
        _ => Ok(None),
    }
}
