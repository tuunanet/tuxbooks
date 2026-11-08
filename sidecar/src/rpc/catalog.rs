//! Metadata, collection, and annotation commands.

use serde_json::Value;

use crate::commands;
use crate::AppState;

use super::{parse_params, BookIdArgs, EventEmitter, IdArgs, RpcError};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverArgs {
    book_id: i64,
    image_path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameArgs {
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionIdArgs {
    collection_id: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameCollectionArgs {
    collection_id: i64,
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionMemberArgs {
    book_id: i64,
    collection_id: i64,
}

pub(super) async fn dispatch(
    state: &AppState,
    events: &EventEmitter,
    method: &str,
    params: &Value,
) -> Result<Option<Value>, RpcError> {
    match method {
        "get_book_metadata" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::metadata::get_book_metadata(
                state, p.book_id
            ))))
        }
        "reset_book_metadata" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::metadata::reset_book_metadata(
                state, events, p.book_id
            ))))
        }
        "set_book_cover" => {
            let p: CoverArgs = parse_params(params)?;
            Ok(Some(call!(commands::metadata::set_book_cover(
                state,
                events,
                p.book_id,
                p.image_path
            ))))
        }
        "clear_book_cover_override" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::metadata::clear_book_cover_override(
                state, events, p.book_id
            ))))
        }
        "embed_book_metadata" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                book_id: i64,
                form: crate::domain::MetadataFields,
            }
            let p: Args = parse_params(params)?;
            Ok(Some(call!(commands::metadata::embed_book_metadata(
                state, events, p.book_id, p.form
            ))))
        }
        "list_collections" => Ok(Some(call!(commands::collections::list_collections(state)))),
        "create_collection" => {
            let p: NameArgs = parse_params(params)?;
            Ok(Some(call!(commands::collections::create_collection(
                state, p.name
            ))))
        }
        "delete_collection" => {
            // The wire param stays `collectionId`, as the bridge has always
            // sent it (only the annotation methods use a bare `id`).
            let p: CollectionIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::collections::delete_collection(
                state,
                p.collection_id
            ))))
        }
        "rename_collection" => {
            let p: RenameCollectionArgs = parse_params(params)?;
            Ok(Some(call!(commands::collections::rename_collection(
                state,
                p.collection_id,
                p.name
            ))))
        }
        "add_book_to_collection" => {
            let p: CollectionMemberArgs = parse_params(params)?;
            Ok(Some(call!(commands::collections::add_book_to_collection(
                state,
                p.book_id,
                p.collection_id
            ))))
        }
        "remove_book_from_collection" => {
            let p: CollectionMemberArgs = parse_params(params)?;
            Ok(Some(call!(
                commands::collections::remove_book_from_collection(
                    state,
                    p.book_id,
                    p.collection_id
                )
            )))
        }
        "list_annotations" => {
            let p: BookIdArgs = parse_params(params)?;
            Ok(Some(call!(commands::annotations::list_annotations(
                state, p.book_id
            ))))
        }
        "create_annotation" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                book_id: i64,
                annotation: commands::annotations::AnnotationInput,
            }
            let p: Args = parse_params(params)?;
            Ok(Some(call!(commands::annotations::create_annotation(
                state,
                p.book_id,
                p.annotation
            ))))
        }
        "update_annotation" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                id: i64,
                patch: commands::annotations::AnnotationPatchInput,
            }
            let p: Args = parse_params(params)?;
            Ok(Some(call!(commands::annotations::update_annotation(
                state, p.id, p.patch
            ))))
        }
        "delete_annotation" => {
            let p: IdArgs = parse_params(params)?;
            Ok(Some(call!(commands::annotations::delete_annotation(
                state, p.id
            ))))
        }
        _ => Ok(None),
    }
}
