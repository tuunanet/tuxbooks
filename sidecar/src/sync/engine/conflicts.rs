//! The conflict review RPC surface: list open conflicts, settle one.

use crate::error::AppError;

use crate::sync::conflict;
use crate::sync::merge;
use crate::sync::store;

impl super::SyncService {
    /// Open, unexpired conflicts newest first, with the values, device names,
    /// and clocks the review UI needs.
    pub async fn list_conflicts(&self) -> Result<Vec<conflict::SyncConflict>, AppError> {
        self.refresh_status().await?;
        let root = self.sync_root();
        conflict::list(&self.inner.pool, root.as_deref()).await
    }

    /// Settle one conflict. `keep_winner` leaves the applied state alone;
    /// `apply_loser` publishes the losing value as a fresh synced write so
    /// every device converges on it.
    pub async fn resolve_conflict(&self, id: i64, resolution: &str) -> Result<bool, AppError> {
        let Some(resolution) = conflict::Resolution::parse(resolution) else {
            return Err(AppError::InvalidInput(format!(
                "unknown conflict resolution {resolution:?}"
            )));
        };
        let _guard = self.inner.pass_lock.lock().await;
        conflict::expire(&self.inner.pool).await?;
        let Some(open) = conflict::open(&self.inner.pool, id).await? else {
            return Ok(false);
        };
        let mut books = Vec::new();
        let mut applied = false;
        if resolution == conflict::Resolution::ApplyLoser {
            if let Some(reason) = conflict::apply_blocked_reason(open.kind, &open.field) {
                return Err(AppError::InvalidInput(reason.into()));
            }
            let Some(folder) = self.status_snapshot().folder else {
                return Err(AppError::InvalidInput(
                    "sync is not connected; re-apply the value from its original screen".into(),
                ));
            };
            let root = store::resolve_root(std::path::Path::new(&folder))?;
            let affected = conflict::apply_loser(&self.inner.pool, &root, &open).await?;
            books = merge::project(
                &self.inner.pool,
                &root,
                &self.inner.covers_dir,
                std::slice::from_ref(&affected),
            )
            .await?;
            applied = true;
        }
        let settled = conflict::settle(&self.inner.pool, id, &open).await?;
        self.emit_changes(&books).await;
        self.refresh_status().await?;
        self.emit_status();
        Ok(applied || settled)
    }
}
