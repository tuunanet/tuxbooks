//! The waiting-book RPC surface: list, forget, and attach a located file.

use std::path::{Path, PathBuf};

use crate::error::AppError;

use crate::sync::identity::{canonical_book_uid, record_issue};
use crate::sync::merge;
use crate::sync::store;
use crate::sync::waiting;

impl super::SyncService {
    pub async fn waiting_books(&self) -> Result<Vec<waiting::WaitingBook>, AppError> {
        waiting::list(&self.inner.pool).await
    }

    pub async fn forget_waiting_book(&self, book_uid: &str) -> Result<bool, AppError> {
        let ignored = waiting::forget(&self.inner.pool, book_uid).await?;
        if ignored {
            self.refresh_status().await?;
        }
        Ok(ignored)
    }

    pub async fn forget_all_waiting_books(&self) -> Result<usize, AppError> {
        let ignored = waiting::forget_all(&self.inner.pool).await?;
        if ignored > 0 {
            self.refresh_status().await?;
        }
        Ok(ignored)
    }

    /// Attach a waiting book to the file the user located. The content hash
    /// decides: the bytes must already carry an alias for the waiting uid, so a
    /// different edition can never inherit this book's state. `relink_book`
    /// hashes once and enforces that; a mismatch leaves the waiting row
    /// untouched.
    pub async fn attach_waiting_book(
        &self,
        book_uid: &str,
        path: &Path,
        pdfium_dirs: &[PathBuf],
    ) -> Result<crate::domain::Book, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let status = self.status_snapshot();
        let Some(folder) = status.folder else {
            return Err(AppError::InvalidInput(
                "cloud sync is not connected on this device".into(),
            ));
        };
        if !status.enabled {
            return Err(AppError::InvalidInput(
                "cloud sync is turned off on this device".into(),
            ));
        }
        let pool = &self.inner.pool;
        let book_uid = canonical_book_uid(pool, book_uid).await?;
        if waiting::is_ignored(pool, &book_uid).await? {
            return Err(AppError::InvalidInput(
                "that waiting book is hidden on this device".into(),
            ));
        }
        if !waiting::is_waiting(pool, &book_uid).await? {
            return Err(AppError::InvalidInput(
                "that book is not waiting for a file".into(),
            ));
        }
        if !path.is_file() {
            return Err(AppError::InvalidInput(format!(
                "no file exists at {}",
                path.display()
            )));
        }
        if crate::repository::books::find_file_id_by_path(pool, &path.to_string_lossy())
            .await?
            .is_some()
        {
            return Err(AppError::InvalidInput(
                "that file is already in the library".into(),
            ));
        }

        // A machine that never imported the book has mirror state but no
        // durable record yet. Create the record under the same uid so the file
        // attaches to the waiting identity instead of minting a new one.
        let (book_id, created) =
            crate::repository::books::ensure_durable_record(pool, &book_uid).await?;
        let book = match crate::services::library_reconciler::relink_book(
            pool,
            book_id,
            path,
            &self.inner.covers_dir,
            pdfium_dirs,
            Some(&book_uid),
        )
        .await
        {
            Ok(book) => book,
            Err(err) => {
                // This attempt created the placeholder and nothing points at
                // it yet, so a rejected file must not leave a phantom
                // Reading-history row.
                if created {
                    crate::repository::books::discard_empty_durable_record(
                        pool, book_id, &book_uid,
                    )
                    .await?;
                }
                return Err(err);
            }
        };
        let root = store::resolve_root(Path::new(&folder))?;
        // The file is attached by now. A projection failure must not undo that,
        // so record the issue the Retry action repairs and return the book.
        // The key carries the durable uid because the retry projects by uid.
        if let Err(err) = merge::project_book(pool, &book_uid, &root, &self.inner.covers_dir).await
        {
            record_issue(
                pool,
                &format!("reproject:{book_uid}"),
                "reprojection_failed",
                &format!("could not project state for {book_uid}: {err}"),
                None,
            )
            .await?;
        }
        self.refresh_status().await?;
        self.emit_status();
        crate::repository::books::get_book(pool, book.id)
            .await?
            .ok_or(AppError::NotFound)
    }
}
