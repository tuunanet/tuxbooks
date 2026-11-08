//! The trash surface: list expiring deletes, restore a prior snapshot.

use std::path::Path;

use serde_json::Value;

use crate::error::AppError;

use super::SyncTrashEntry;
use crate::sync::capture;
use crate::sync::clock::now_rfc3339;
use crate::sync::merge::{self, Affected};
use crate::sync::model::{canonical_from_snapshot, state_display, EntityKind};
use crate::sync::store;

impl super::SyncService {
    pub async fn trash(&self) -> Result<Vec<SyncTrashEntry>, AppError> {
        let rows: Vec<(i64, String, String, String, String)> = sqlx::query_as(
            "SELECT id, kind, prior_json, deleted_at, expires_at FROM sync_trash
             WHERE restored_at IS NULL AND expires_at > ?1
             ORDER BY deleted_at DESC, id DESC LIMIT 100",
        )
        .bind(now_rfc3339())
        .fetch_all(&self.inner.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, kind, prior_json, deleted_at, expires_at)| {
                let kind = EntityKind::parse(&kind)?;
                let prior: serde_json::Map<String, Value> =
                    serde_json::from_str(&prior_json).ok()?;
                let state = canonical_from_snapshot(kind, &prior);
                Some(SyncTrashEntry {
                    id,
                    kind: kind.as_str().to_string(),
                    label: state_display(kind, &state),
                    deleted_at,
                    expires_at,
                })
            })
            .collect())
    }

    pub async fn restore(&self, trash_id: i64) -> Result<bool, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let row: Option<(String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT kind, entity_uid, book_uid, prior_json FROM sync_trash
             WHERE id = ?1 AND restored_at IS NULL AND expires_at > ?2",
        )
        .bind(trash_id)
        .bind(now_rfc3339())
        .fetch_optional(&self.inner.pool)
        .await?;
        let Some((kind, entity_uid, book_uid, prior_json)) = row else {
            return Ok(false);
        };
        let Some(kind) = EntityKind::parse(&kind) else {
            return Ok(false);
        };
        let prior: serde_json::Map<String, Value> = serde_json::from_str(&prior_json)
            .map_err(|err| AppError::InvalidInput(format!("trash entry is not readable: {err}")))?;
        let Some(folder) = self.status_snapshot().folder else {
            return Err(AppError::InvalidInput("sync is not connected".into()));
        };
        let root = store::resolve_root(Path::new(&folder))?;
        capture::write_restore(
            &self.inner.pool,
            &root,
            kind,
            &entity_uid,
            book_uid.as_deref(),
            &prior,
        )
        .await?;
        sqlx::query("UPDATE sync_trash SET restored_at = ?2 WHERE id = ?1")
            .bind(trash_id)
            .bind(now_rfc3339())
            .execute(&self.inner.pool)
            .await?;
        let affected = vec![Affected {
            kind,
            entity_uid,
            book_uid,
        }];
        let books =
            merge::project(&self.inner.pool, &root, &self.inner.covers_dir, &affected).await?;
        self.emit_changes(&books).await;
        self.refresh_status().await?;
        self.emit_status();
        Ok(true)
    }
}
