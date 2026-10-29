//! Cloud-folder sync commands. The engine owns the work; these functions only
//! translate the JSON-RPC surface.

use crate::error::AppError;
use crate::sync::engine::{SyncConnectResult, SyncIssue, SyncService, SyncStatus, SyncTrashEntry};
use crate::AppState;

fn service(state: &AppState) -> Result<&SyncService, AppError> {
    state
        .sync
        .as_deref()
        .ok_or_else(|| AppError::InvalidInput("cloud sync is not available".into()))
}

pub async fn status(state: &AppState) -> Result<SyncStatus, AppError> {
    service(state)?.status().await
}

pub async fn connect(
    state: &AppState,
    path: String,
    device_name: Option<String>,
    confirm_library_id: Option<String>,
) -> Result<SyncConnectResult, AppError> {
    service(state)?
        .connect(&path, device_name, confirm_library_id)
        .await
}

pub async fn disconnect(state: &AppState) -> Result<SyncStatus, AppError> {
    service(state)?.disconnect().await
}

pub async fn sync_now(state: &AppState) -> Result<SyncStatus, AppError> {
    service(state)?.sync_now().await
}

pub async fn issues(state: &AppState) -> Result<Vec<SyncIssue>, AppError> {
    service(state)?.issues().await
}

pub async fn dismiss_issue(state: &AppState, id: i64) -> Result<bool, AppError> {
    service(state)?.dismiss_issue(id).await
}

pub async fn trash(state: &AppState) -> Result<Vec<SyncTrashEntry>, AppError> {
    service(state)?.trash().await
}

pub async fn restore(state: &AppState, id: i64) -> Result<bool, AppError> {
    service(state)?.restore(id).await
}

pub async fn set_device_name(state: &AppState, name: String) -> Result<SyncStatus, AppError> {
    service(state)?.set_device_name(&name).await
}
