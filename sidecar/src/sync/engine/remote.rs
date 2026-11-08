//! Remote apply: replay operation files from the folder, then reproject.

use std::path::Path;

use serde_json::Value;

use crate::error::AppError;

use super::clear::resolve_issue_key;
use crate::sync::clock::now_rfc3339;
use crate::sync::identity::{canonical_book_uid, record_duplicate_bindings, record_issue};
use crate::sync::merge::{self, Affected};
use crate::sync::model::EntityKind;
use crate::sync::store;

const REMOTE_BATCH: usize = 500;
const FILE_RETRY_LIMIT: i64 = 5;

impl super::SyncService {
    pub(super) async fn sync_remote(&self, root: &Path) -> Result<(), AppError> {
        let files = store::scan_ops(root)?;
        let mut affected: Vec<Affected> = Vec::new();
        let mut identity_books: Vec<String> = Vec::new();
        let mut mark_processed: Vec<(String, i64, i64)> = Vec::new();
        let mut processed = 0usize;

        for file in files {
            let cached: Option<(i64, i64, Option<String>, i64)> = sqlx::query_as(
                "SELECT size, mtime, processed_at, failures FROM sync_remote_files
                 WHERE relative_path = ?1",
            )
            .bind(&file.relative_path)
            .fetch_optional(&self.inner.pool)
            .await?;
            if let Some((size, mtime, processed_at, _)) = cached {
                if size == file.size && mtime == file.mtime && processed_at.is_some() {
                    continue;
                }
            }
            if processed >= REMOTE_BATCH {
                break;
            }

            let mut op = match store::read_op(&file.path) {
                Ok(op) => op,
                Err(err) => {
                    self.record_file_failure(&file, &err).await?;
                    processed += 1;
                    continue;
                }
            };

            if op.kind == EntityKind::Metadata && !op.deleted {
                if let Some(name) = op.fields.get("cover_path").and_then(Value::as_str) {
                    match store::apply_cover_blob(root, &self.inner.covers_dir, name) {
                        Ok(true) => {}
                        Ok(false) => {
                            record_issue(
                                &self.inner.pool,
                                &format!("cover-missing:{name}"),
                                "cover_missing",
                                &format!(
                                    "cover {name} is not in the sync folder yet; \
                                     applying the metadata edit without it"
                                ),
                                Some(&file.relative_path),
                            )
                            .await?;
                            op.fields.insert("cover_path".into(), Value::Null);
                        }
                        Err(err) => {
                            record_issue(
                                &self.inner.pool,
                                &format!("cover-missing:{name}"),
                                "cover_missing",
                                &format!("could not read cover {name}: {err}"),
                                Some(&file.relative_path),
                            )
                            .await?;
                            op.fields.insert("cover_path".into(), Value::Null);
                        }
                    }
                }
            }

            let mut applied = merge::apply_op(&self.inner.pool, &op, &file.relative_path).await?;
            if op.kind == EntityKind::BookIdentity {
                let canonical = canonical_book_uid(&self.inner.pool, &op.entity_uid).await?;
                identity_books.push(canonical);
            }
            if applied.is_empty() {
                applied.push(Affected {
                    kind: op.kind,
                    entity_uid: op.entity_uid.clone(),
                    book_uid: op.book_uid.clone(),
                });
            }
            affected.extend(applied);
            mark_processed.push((file.relative_path.clone(), file.size, file.mtime));
            processed += 1;
        }

        let mut books = if affected.is_empty() {
            Vec::new()
        } else {
            merge::project(&self.inner.pool, root, &self.inner.covers_dir, &affected).await?
        };
        identity_books.sort();
        identity_books.dedup();
        for book_uid in identity_books {
            if let Ok(mut projected) =
                merge::project_book(&self.inner.pool, &book_uid, root, &self.inner.covers_dir).await
            {
                books.append(&mut projected);
            }
        }
        if !books.is_empty() {
            books.sort_unstable();
            books.dedup();
            self.emit_changes(&books).await;
        }
        for (relative, size, mtime) in mark_processed {
            sqlx::query(
                r#"
                INSERT INTO sync_remote_files (relative_path, size, mtime, failures, processed_at)
                VALUES (?1, ?2, ?3, 0, ?4)
                ON CONFLICT(relative_path) DO UPDATE SET
                    size = excluded.size,
                    mtime = excluded.mtime,
                    failures = 0,
                    processed_at = excluded.processed_at
                "#,
            )
            .bind(relative)
            .bind(size)
            .bind(mtime)
            .bind(now_rfc3339())
            .execute(&self.inner.pool)
            .await?;
        }
        Ok(())
    }

    /// Deleting the canonical local row of a shared book queues its uuid. If
    /// another bound row remains, project the shared state onto it so a
    /// duplicate copy does not look empty after the first copy is removed.
    pub(super) async fn reproject_queued(&self, root: &Path) -> Result<(), AppError> {
        let uids: Vec<String> = sqlx::query_scalar(
            "SELECT book_uid FROM sync_reproject ORDER BY requested_at, book_uid LIMIT 25",
        )
        .fetch_all(&self.inner.pool)
        .await?;
        let mut books = Vec::new();
        for book_uid in uids {
            let has_binding: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM sync_book_bindings WHERE book_uid = ?1 LIMIT 1")
                    .bind(&book_uid)
                    .fetch_optional(&self.inner.pool)
                    .await?;
            if has_binding.is_some() {
                match merge::project_book(&self.inner.pool, &book_uid, root, &self.inner.covers_dir)
                    .await
                {
                    Ok(mut projected) => {
                        books.append(&mut projected);
                        resolve_issue_key(&self.inner.pool, &format!("reproject:{book_uid}"))
                            .await?;
                    }
                    Err(err) => {
                        record_issue(
                            &self.inner.pool,
                            &format!("reproject:{book_uid}"),
                            "reprojection_failed",
                            &format!("could not project state for {book_uid}: {err}"),
                            None,
                        )
                        .await?;
                        continue;
                    }
                }
            } else {
                // No copy is bound any more, so there is nothing left to
                // reproject and the reported condition is gone.
                resolve_issue_key(&self.inner.pool, &format!("reproject:{book_uid}")).await?;
            }
            sqlx::query(
                "UPDATE sync_issues SET resolved_at = ?2
                 WHERE issue_key LIKE ?1 AND resolved_at IS NULL",
            )
            .bind(format!("duplicate-book:{book_uid}:%"))
            .bind(now_rfc3339())
            .execute(&self.inner.pool)
            .await?;
            record_duplicate_bindings(&self.inner.pool, &book_uid).await?;
            sqlx::query("DELETE FROM sync_reproject WHERE book_uid = ?1")
                .bind(&book_uid)
                .execute(&self.inner.pool)
                .await?;
        }
        books.sort_unstable();
        books.dedup();
        if !books.is_empty() {
            self.emit_changes(&books).await;
        }
        Ok(())
    }

    async fn record_file_failure(
        &self,
        file: &store::RemoteFile,
        detail: &str,
    ) -> Result<(), AppError> {
        let cached: Option<(i64, i64, i64)> = sqlx::query_as(
            "SELECT size, mtime, failures FROM sync_remote_files WHERE relative_path = ?1",
        )
        .bind(&file.relative_path)
        .fetch_optional(&self.inner.pool)
        .await?;
        let failures = match cached {
            Some((size, mtime, failures)) if size == file.size && mtime == file.mtime => {
                failures + 1
            }
            _ => 1,
        };
        let give_up = failures >= FILE_RETRY_LIMIT;
        sqlx::query(
            r#"
            INSERT INTO sync_remote_files (relative_path, size, mtime, failures, processed_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(relative_path) DO UPDATE SET
                size = excluded.size,
                mtime = excluded.mtime,
                failures = excluded.failures,
                processed_at = excluded.processed_at
            "#,
        )
        .bind(&file.relative_path)
        .bind(file.size)
        .bind(file.mtime)
        .bind(failures)
        .bind(if give_up { Some(now_rfc3339()) } else { None })
        .execute(&self.inner.pool)
        .await?;
        record_issue(
            &self.inner.pool,
            &format!("file:{}", file.relative_path),
            if give_up {
                "operation_rejected"
            } else {
                "operation_retrying"
            },
            if give_up {
                format!("gave up after {failures} attempts: {detail}")
            } else {
                format!("attempt {failures}: {detail}")
            }
            .as_str(),
            Some(&file.relative_path),
        )
        .await
    }
}
