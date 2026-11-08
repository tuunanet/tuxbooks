//! Connect, disconnect, and device naming for the sync folder.

use std::path::Path;

use crate::error::AppError;

use super::default_device_name;
use super::{SyncConnectResult, SyncMismatch, SyncStatus};
use crate::sync::clock::{
    device_id, get_meta, now_rfc3339, set_meta, META_BASELINE_DONE, META_DEVICE_NAME, META_ENABLED,
    META_FOLDER, META_LIBRARY_ID,
};
use crate::sync::store;

impl super::SyncService {
    pub async fn connect(
        &self,
        folder: &str,
        device_name: Option<String>,
        confirm_library_id: Option<String>,
        start_new: bool,
    ) -> Result<SyncConnectResult, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let path = Path::new(folder);
        if !path.is_absolute() {
            return Err(AppError::InvalidInput(
                "sync folder must be an absolute path".into(),
            ));
        }
        let name = device_name
            .or_else(|| self.status_snapshot().device_name)
            .unwrap_or_else(default_device_name);
        let name = validate_device_name(&name)?;
        let id = device_id(&self.inner.pool).await?;
        let now = now_rfc3339();
        let archived = if start_new {
            store::archive_existing_library(path, &now)?
        } else {
            None
        };
        let info = store::connect(path, &id, &name, &now)?;
        let local_library = get_meta(&self.inner.pool, META_LIBRARY_ID).await?;
        let archived_library_path = archived.map(|path| path.to_string_lossy().into_owned());
        if let Some(local) = &local_library {
            if local != &info.library.library_id {
                // A library this connect just created is ours to adopt. Only a
                // library that already existed can belong to another machine.
                if info.existed
                    && confirm_library_id.as_deref() != Some(info.library.library_id.as_str())
                {
                    self.refresh_status().await?;
                    return Ok(SyncConnectResult {
                        status: self.status_snapshot(),
                        mismatch: Some(SyncMismatch {
                            local_library_id: local.clone(),
                            remote_library_id: info.library.library_id.clone(),
                        }),
                        archived_library_path: None,
                    });
                }
                self.reset_sync_state().await?;
            }
        }

        let folder_display = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned();
        set_meta(&self.inner.pool, META_LIBRARY_ID, &info.library.library_id).await?;
        set_meta(&self.inner.pool, META_FOLDER, &folder_display).await?;
        set_meta(&self.inner.pool, META_DEVICE_NAME, &name).await?;
        set_meta(&self.inner.pool, META_ENABLED, "1").await?;
        if local_library.is_none()
            || get_meta(&self.inner.pool, META_BASELINE_DONE)
                .await?
                .as_deref()
                != Some("1")
        {
            set_meta(&self.inner.pool, META_BASELINE_DONE, "0").await?;
        }
        self.clear_error().await;
        self.refresh_status().await?;
        self.wake();
        // The sync root is known (or has changed): (re)start the folder
        // watcher against it.
        self.restart_watcher();
        Ok(SyncConnectResult {
            status: self.status_snapshot(),
            mismatch: None,
            archived_library_path,
        })
    }

    async fn reset_sync_state(&self) -> Result<(), AppError> {
        let mut tx = self.inner.pool.begin().await?;
        for table in [
            "sync_state_fields",
            "sync_state_entities",
            "sync_book_aliases",
            "sync_book_bindings",
            "sync_book_merges",
            "sync_entity_merges",
            "sync_ops",
            "sync_applied_ops",
            "sync_remote_files",
            "sync_issues",
            "sync_conflicts",
            "sync_trash",
            "sync_book_trash",
            "sync_dirty",
            "sync_reproject",
        ] {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        set_meta(&self.inner.pool, META_BASELINE_DONE, "0").await?;
        Ok(())
    }

    pub async fn disconnect(&self) -> Result<SyncStatus, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        set_meta(&self.inner.pool, META_ENABLED, "0").await?;
        self.clear_error().await;
        self.refresh_status().await?;
        self.set_state(super::SyncState::Disabled);
        self.emit_status();
        // No folder to watch while disconnected.
        self.stop_watcher();
        Ok(self.status_snapshot())
    }

    pub async fn set_device_name(&self, name: &str) -> Result<SyncStatus, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let name = validate_device_name(name)?;
        set_meta(&self.inner.pool, META_DEVICE_NAME, &name).await?;
        if let Some(folder) = self.status_snapshot().folder {
            let id = device_id(&self.inner.pool).await?;
            let _ = store::connect(Path::new(&folder), &id, &name, &now_rfc3339());
        }
        self.refresh_status().await?;
        self.emit_status();
        Ok(self.status_snapshot())
    }
}

fn validate_device_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("device name is empty".into()));
    }
    if name.chars().count() > 80 {
        return Err(AppError::InvalidInput("device name is too long".into()));
    }
    Ok(name.to_string())
}
