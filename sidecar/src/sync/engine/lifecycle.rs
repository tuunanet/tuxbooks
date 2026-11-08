//! The tokio pass loop: periodic and woken passes, ordered shutdown.

use std::sync::Arc;
use std::time::{Duration, Instant};

const PASS_INTERVAL: Duration = Duration::from_secs(10);
const DIRTY_POLL: Duration = Duration::from_secs(2);

impl super::SyncService {
    pub fn start(self: &Arc<Self>) {
        let service = self.clone();
        let mut shutdown = self.inner.shutdown.subscribe();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let mut last_pass = Instant::now() - PASS_INTERVAL;
            loop {
                let woken = tokio::select! {
                    changed = shutdown.changed() => {
                        let _ = changed;
                        break;
                    }
                    _ = service.inner.wake.notified() => true,
                    _ = tokio::time::sleep(DIRTY_POLL) => false,
                };
                if !service.status_snapshot().enabled {
                    continue;
                }
                let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
                    .fetch_one(&service.inner.pool)
                    .await
                    .unwrap_or(0);
                if woken || dirty > 0 || last_pass.elapsed() >= PASS_INTERVAL {
                    let _ = service.run_pass().await;
                    last_pass = Instant::now();
                }
            }
        });
        *self
            .inner
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(task);
        // The watcher lives as long as the engine: if a folder
        // is already connected, remote files now wake the loop directly.
        self.restart_watcher();
    }

    /// Flush once with a deadline, then stop the loop. Called from `serve` on
    /// stdin EOF so the last reading position reaches the folder.
    pub async fn shutdown(&self) {
        if self.status_snapshot().enabled {
            let _ = tokio::time::timeout(Duration::from_secs(3), self.run_pass()).await;
        }
        let _ = self.inner.shutdown.send(true);
        let task = self
            .inner
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(task) = task {
            let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
        }
        // Stop the watcher last, after the loop it wakes is gone. Dropping
        // the handle joins the debounce thread, so nothing outlives the
        // engine.
        self.stop_watcher();
    }

    pub fn wake(&self) {
        self.inner.wake.notify_one();
    }
}
