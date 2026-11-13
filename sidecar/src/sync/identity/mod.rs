//! Book identity: a shared uuid linked to content hashes.
//!
//! Paths and row ids are machine-specific. A book's shared identity is a uuid;
//! the SHA-256 of its bytes is only a discovery key. A metadata embed rewrites
//! the file, so the same uuid gains a new hash alias instead of becoming a new
//! book.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::kind::SyncIssueKind;

mod alias;
mod bind;
mod collection;
mod merge;
mod state;

pub use alias::canonical_book_uid;
pub(crate) use alias::{alias_book_uid, forgotten_replacement};
pub use bind::{bind_hash, ensure_book_identity, mark_identity_dirty};
pub(crate) use bind::{hash_file, record_duplicate_bindings};
pub use collection::{canonical_entity_uid, merge_collection_identity};
pub use merge::merge_book_identity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookIdentity {
    pub book_id: i64,
    pub book_uid: String,
    pub content_hash: String,
    pub size: i64,
    pub mtime: i64,
}

/// Record an issue without duplicating an open row for the same key. The SQL
/// lives in `repository::sync_issues` because services also record hash
/// failures; this wrapper keeps the historical call sites readable.
pub async fn record_issue(
    pool: &SqlitePool,
    key: &str,
    kind: SyncIssueKind,
    detail: &str,
    file_name: Option<&str>,
) -> Result<(), AppError> {
    crate::repository::sync_issues::record(pool, key, kind, detail, file_name).await
}

pub async fn touch_last_sync(pool: &SqlitePool) -> Result<(), AppError> {
    crate::sync::clock::set_meta(
        pool,
        crate::sync::clock::META_LAST_SYNC,
        &crate::sync::clock::now_rfc3339(),
    )
    .await
}

#[cfg(test)]
mod tests;
