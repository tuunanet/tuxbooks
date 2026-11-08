//! Merge remote operations into the shared-state mirror.
//!
//! Field-level last-writer-wins for annotations, metadata, and collections;
//! entity-level last-writer-wins for reading progress, membership, and
//! last-opened; delete-wins tombstones for annotations and collections, with
//! an explicit restore path.

mod book;
mod catalog;
mod conflict;
mod project;
mod state;
#[cfg(test)]
mod tests;

pub use book::book_lifecycle_state;
pub use conflict::record_tombstone_conflict;
pub use project::{project, project_book, retry_book_lifecycle};
pub use state::load_state;

use crate::error::AppError;

use super::clock::observe_hlc;
use super::model::{EntityKind, Op};

use book::{apply_book, apply_identity};
use state::apply_state_op;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Affected {
    pub kind: EntityKind,
    pub entity_uid: String,
    pub book_uid: Option<String>,
}

/// Apply one operation idempotently. The caller records the file it came from
/// so the dedupe table can explain where an op was first seen.
pub async fn apply_op(
    pool: &sqlx::SqlitePool,
    op: &Op,
    file_name: &str,
) -> Result<Vec<Affected>, AppError> {
    let already: Option<String> =
        sqlx::query_scalar("SELECT op_id FROM sync_applied_ops WHERE op_id = ?1")
            .bind(&op.op_id)
            .fetch_optional(pool)
            .await?;
    if already.is_some() {
        return Ok(Vec::new());
    }
    observe_hlc(pool, &op.hlc).await?;

    if op.kind == EntityKind::BookIdentity {
        let affected = apply_identity(pool, op).await?;
        sqlx::query(
            "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, file_name)
             VALUES (?1, ?2, ?3)",
        )
        .bind(&op.op_id)
        .bind(&op.device_id)
        .bind(file_name)
        .execute(pool)
        .await?;
        return Ok(affected);
    }

    if op.kind == EntityKind::Book {
        let affected = apply_book(pool, op).await?;
        sqlx::query(
            "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, file_name)
             VALUES (?1, ?2, ?3)",
        )
        .bind(&op.op_id)
        .bind(&op.device_id)
        .bind(file_name)
        .execute(pool)
        .await?;
        return Ok(affected);
    }

    // A whole-book Forget wins over any in-flight edit. The losing value is
    // not resurrected; the user asked to erase the identity.
    if let Some(book_uid) = &op.book_uid {
        let canonical = super::identity::canonical_book_uid(pool, book_uid).await?;
        if super::identity::forgotten_replacement(pool, &canonical)
            .await?
            .is_some()
        {
            sqlx::query(
                "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, file_name)
                 VALUES (?1, ?2, ?3)",
            )
            .bind(&op.op_id)
            .bind(&op.device_id)
            .bind(file_name)
            .execute(pool)
            .await?;
            return Ok(Vec::new());
        }
    }

    let mut tx = pool.begin().await?;
    let affected = apply_state_op(&mut tx, op).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, file_name) VALUES (?1, ?2, ?3)",
    )
    .bind(&op.op_id)
    .bind(&op.device_id)
    .bind(file_name)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(affected)
}
