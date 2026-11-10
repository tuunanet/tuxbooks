//! Drain local dirty markers into immutable operation files. The trigger
//! snapshot is the source of truth here, not the current row.

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::error::AppError;

use super::clock::{device_id, next_hlc, now_rfc3339};
use super::identity::canonical_book_uid;
use super::merge;
use super::model::{EntityKind, Hlc, Op, OP_SCHEMA};
use super::store;

mod drain;
mod file_version;
mod lifecycle;
mod publish;

pub use drain::drain;
pub use publish::{write_fields, write_restore};

#[cfg(test)]
mod tests;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CaptureReport {
    pub written: usize,
    pub pending_identity: usize,
}

struct DirtyRow {
    kind: String,
    entity_key: String,
    op: String,
    old_json: Option<String>,
    new_json: Option<String>,
    /// The clock the write transaction minted (migration 0030, ADR 0017 D3).
    /// `None` only for rows written before that migration or inserted by hand.
    hlc_wall: Option<i64>,
    hlc_counter: Option<i64>,
}

enum Captured {
    Written,
    PendingIdentity,
    Skipped,
}

type DirtyRowTuple = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
);

/// The write-time clock of a dirty row, when it carries one. `Hlc::device`
/// is a placeholder here; `build_op` stamps the local device id before the
/// op is published.
fn stored_clock(row: &DirtyRow) -> Option<Hlc> {
    match (row.hlc_wall, row.hlc_counter) {
        (Some(wall), Some(counter)) => Some(Hlc {
            wall,
            counter: u32::try_from(counter).expect("counter slot is a small non-negative count"),
            device: String::new(),
        }),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn build_op(
    pool: &SqlitePool,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: Option<&str>,
    deleted: bool,
    restore: bool,
    fields: Map<String, Value>,
    prior: Option<Map<String, Value>>,
    clock: Option<Hlc>,
) -> Result<Op, AppError> {
    // ADR 0017 D3: the op dates the write, not the drain. Dirty rows carry
    // the clock their write transaction minted; a clockless row only means
    // it was written before migration 0030 (or inserted by hand), and the
    // old publish-time mint is kept as the fallback for exactly that case.
    let hlc = match clock {
        Some(clock) => Hlc {
            device: device_id(pool).await?,
            ..clock
        },
        None => next_hlc(pool).await?,
    };
    let op_id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
        .fetch_one(pool)
        .await?;
    Ok(Op {
        schema: OP_SCHEMA,
        op_id,
        device_id: hlc.device.clone(),
        hlc,
        kind,
        entity_uid: entity_uid.to_string(),
        book_uid: book_uid.map(ToString::to_string),
        deleted,
        restore,
        fields,
        prior,
        created_at: now_rfc3339(),
    })
}

/// Publish one captured write: the op file, its ledger row, then the mirror
/// apply — that order is what keeps the folder and the ledger coherent. A
/// failed apply leaves the op published and ledgered, so the row's
/// recapture finds it and re-drives the recorded op instead of minting a
/// twin file (tuxbooks-a3y); a failed ledger write compensates by removing
/// the file, since nothing has consumed the write yet.
async fn write_and_apply(
    pool: &SqlitePool,
    root: &std::path::Path,
    op: &Op,
) -> Result<(), AppError> {
    if let Some((payload, file_name)) = published_write(pool, op).await? {
        let prior: Op = serde_json::from_str(&payload).map_err(|err| {
            AppError::InvalidInput(format!("recorded op is not valid JSON: {err}"))
        })?;
        return merge::apply_op(pool, &prior, &file_name).await.map(|_| ());
    }

    let relative = store::write_op(root, op)?;
    let payload = serde_json::to_string(op)
        .map_err(|err| AppError::InvalidInput(format!("cannot serialize op: {err}")))?;
    if let Err(err) = sqlx::query(
        r#"
        INSERT INTO sync_ops
            (op_id, device_id, hlc_wall, hlc_counter, kind, entity_uid, book_uid,
             deleted, payload_json, file_name)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(op_id) DO NOTHING
        "#,
    )
    .bind(&op.op_id)
    .bind(&op.device_id)
    .bind(op.hlc.wall)
    .bind(op.hlc.counter as i64)
    .bind(op.kind.as_str())
    .bind(&op.entity_uid)
    .bind(&op.book_uid)
    .bind(op.deleted)
    .bind(&payload)
    .bind(&relative)
    .execute(pool)
    .await
    {
        // Best effort: if even the unlink fails, or the process dies
        // between the file and this row, an orphan survives the recapture
        // cannot match and the next pass mints a twin. Bounding the window
        // to one statement is the most this seam can do without a folder
        // transaction (tuxbooks-a3y).
        let _ = std::fs::remove_file(root.join(&relative));
        return Err(err.into());
    }
    merge::apply_op(pool, op, &relative).await?;
    Ok(())
}

/// The ledger row of an earlier capture of the same write, keyed by the
/// write's own identity: device, entity, and its minted clock. Remote ops
/// never enter `sync_ops`, so a hit is always this device's prior capture.
/// Two rows for one write exist only from a build that predates the
/// twin-guard; both name the same write, so whichever `LIMIT 1` returns
/// satisfies the reuse.
async fn published_write(pool: &SqlitePool, op: &Op) -> Result<Option<(String, String)>, AppError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT payload_json, file_name FROM sync_ops
         WHERE device_id = ?1 AND kind = ?2 AND entity_uid = ?3
           AND hlc_wall = ?4 AND hlc_counter = ?5
         LIMIT 1",
    )
    .bind(&op.device_id)
    .bind(op.kind.as_str())
    .bind(&op.entity_uid)
    .bind(op.hlc.wall)
    .bind(op.hlc.counter as i64)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

async fn clear_row(pool: &SqlitePool, row: &DirtyRow) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM sync_dirty WHERE kind = ?1 AND entity_key = ?2 AND op = ?3
         AND COALESCE(old_json, '') = COALESCE(?4, '')
         AND COALESCE(new_json, '') = COALESCE(?5, '')",
    )
    .bind(&row.kind)
    .bind(&row.entity_key)
    .bind(&row.op)
    .bind(&row.old_json)
    .bind(&row.new_json)
    .execute(pool)
    .await?;
    Ok(())
}

async fn durable_exists(pool: &SqlitePool, uid: &str) -> Result<bool, AppError> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM book_records WHERE uid = ?1")
        .bind(uid)
        .fetch_optional(pool)
        .await?;
    Ok(exists.is_some())
}

async fn durable_uid(pool: &SqlitePool, book_id: i64) -> Result<Option<String>, AppError> {
    let uid: Option<String> = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(pool)
        .await?;
    match uid {
        Some(uid) => Ok(Some(canonical_book_uid(pool, &uid).await?)),
        None => Ok(None),
    }
}

async fn collection_exists(pool: &SqlitePool, collection_id: i64) -> Result<bool, AppError> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM collections WHERE id = ?1")
        .bind(collection_id)
        .fetch_optional(pool)
        .await?;
    Ok(exists.is_some())
}

fn parse_snapshot(value: Option<&str>) -> Option<Map<String, Value>> {
    let text = value?;
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn snapshot_for(row: &DirtyRow) -> Option<Map<String, Value>> {
    match row.op.as_str() {
        "delete" => parse_snapshot(row.old_json.as_deref()),
        _ => parse_snapshot(row.new_json.as_deref()),
    }
}
