//! Confirmed cross-edition links (ADR 0014 D9, ticket tuxbooks-ip6.8).
//!
//! Two different editions stay two durable books. Linking them records the
//! relation, copies the source percentage into a progress row that carries no
//! locator, and moves provider links/status to the current edition.
//! Annotations, files, collections, and metadata overrides never move.

use sqlx::SqlitePool;

use crate::domain::{EditionBook, EditionLinkOutcome};
use crate::error::AppError;

#[derive(Debug, Clone)]
struct BookIdentity {
    id: i64,
    uid: String,
}

async fn identity(pool: &SqlitePool, book_id: i64) -> Result<Option<BookIdentity>, AppError> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id, uid FROM book_records WHERE id = ?1")
            .bind(book_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(id, uid)| BookIdentity { id, uid }))
}

/// Link two durable books as editions. The operation is atomic: a duplicate
/// link, a provider that the current edition already owns, or a missing book
/// changes nothing.
///
/// `source` is the edition that already carries the reading state; `target`
/// is the edition the user is reading now. Only the source percentage and
/// provider links move. Annotations stay with the source, and the target's
/// old locator is replaced by the percentage-only row.
pub async fn link_editions(
    pool: &SqlitePool,
    source_book_id: i64,
    target_book_id: i64,
) -> Result<EditionLinkOutcome, AppError> {
    let source = identity(pool, source_book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let target = identity(pool, target_book_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if source.id == target.id {
        return Err(AppError::InvalidInput(
            "a book cannot be linked as an edition of itself".into(),
        ));
    }

    // Store the pair in one deterministic order. Both directions mean the
    // same relation, so a second call with the arguments swapped is a
    // duplicate, not a second row.
    let (uid_a, uid_b) = if source.uid < target.uid {
        (source.uid.as_str(), target.uid.as_str())
    } else {
        (target.uid.as_str(), source.uid.as_str())
    };

    let mut tx = pool.begin().await?;

    let already_linked: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM book_edition_links \
         WHERE (book_uid_a = ?1 AND book_uid_b = ?2) \
            OR (book_uid_a = ?2 AND book_uid_b = ?1)",
    )
    .bind(uid_a)
    .bind(uid_b)
    .fetch_optional(&mut *tx)
    .await?;
    if already_linked.is_some() {
        return Err(AppError::InvalidInput(
            "these books are already linked as editions".into(),
        ));
    }

    // A target link for the same provider cannot be overwritten: that would
    // silently drop the remote work the current edition already tracks. The
    // caller gets an explicit conflict and can unlink deliberately.
    let conflicting_providers: Vec<String> = sqlx::query_scalar(
        "SELECT s.provider FROM book_provider_links s \
         WHERE s.book_uid = ?1 AND EXISTS ( \
             SELECT 1 FROM book_provider_links t \
             WHERE t.book_uid = ?2 AND t.provider = s.provider \
         ) ORDER BY s.provider",
    )
    .bind(&source.uid)
    .bind(&target.uid)
    .fetch_all(&mut *tx)
    .await?;
    if !conflicting_providers.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "the current edition is already linked to {}; unlink it before moving the provider link",
            conflicting_providers.join(", ")
        )));
    }

    let moved_providers: Vec<String> = sqlx::query_scalar(
        "SELECT provider FROM book_provider_links WHERE book_uid = ?1 ORDER BY provider",
    )
    .bind(&source.uid)
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO book_edition_links (book_uid_a, book_uid_b) VALUES (?1, ?2)")
        .bind(uid_a)
        .bind(uid_b)
        .execute(&mut *tx)
        .await?;

    // Parent link rows move by update, not insert: `(provider, remote_id)` is
    // unique across the table, so copying before deleting would collide with
    // the source row. The queued rows are captured and re-inserted because
    // the composite FK has no ON UPDATE cascade.
    let queued: Vec<(String, f64, String)> = sqlx::query_as(
        "SELECT provider, progress_percent, queued_at \
         FROM book_provider_pending_progress WHERE book_uid = ?1",
    )
    .bind(&source.uid)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM book_provider_pending_progress WHERE book_uid = ?1")
        .bind(&source.uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE book_provider_links SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&source.uid)
        .bind(&target.uid)
        .execute(&mut *tx)
        .await?;
    for (provider, progress_percent, queued_at) in queued {
        sqlx::query(
            "INSERT INTO book_provider_pending_progress \
                 (book_uid, provider, progress_percent, queued_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(book_uid, provider) DO UPDATE SET \
                 progress_percent = excluded.progress_percent, \
                 queued_at = excluded.queued_at",
        )
        .bind(&target.uid)
        .bind(provider)
        .bind(progress_percent)
        .bind(queued_at)
        .execute(&mut *tx)
        .await?;
    }

    // Percentage only: no cfi, chapter href, page, progression, locations,
    // engine marker, or locator JSON crosses editions. The target's own
    // position is replaced by the source percentage, so opening the newly
    // linked edition starts at that percentage rather than at an old locator.
    let source_percent: Option<f64> = sqlx::query_scalar::<_, Option<f64>>(
        "SELECT progress_percent FROM reading_progress WHERE book_uid = ?1",
    )
    .bind(&source.uid)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let copied_progress_percent = match source_percent {
        Some(percent) => {
            sqlx::query(
                "INSERT INTO reading_progress (book_uid, progress_percent) VALUES (?1, ?2) \
                 ON CONFLICT(book_uid) DO UPDATE SET \
                     chapter_href = NULL, \
                     cfi = NULL, \
                     character_offset = NULL, \
                     page_number = NULL, \
                     scroll_offset = NULL, \
                     progress_percent = excluded.progress_percent, \
                     locator = NULL, \
                     progression = NULL, \
                     locations = NULL, \
                     engine = NULL, \
                     schema_version = NULL, \
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            )
            .bind(&target.uid)
            .bind(percent)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE book_records SET progress_percent = ?2 WHERE uid = ?1")
                .bind(&target.uid)
                .bind(percent)
                .execute(&mut *tx)
                .await?;
            Some(percent)
        }
        None => None,
    };

    tx.commit().await?;

    Ok(EditionLinkOutcome {
        source_book_id: source.id,
        target_book_id: target.id,
        source_book_uid: source.uid,
        target_book_uid: target.uid,
        copied_progress_percent,
        moved_providers,
    })
}

/// Every edition linked to one durable book, newest activity first. A linked
/// edition with no file row is still listed; `inLibrary` tells the UI which
/// surface it belongs to.
pub async fn list_editions(pool: &SqlitePool, book_id: i64) -> Result<Vec<EditionBook>, AppError> {
    let uid = identity(pool, book_id)
        .await?
        .ok_or(AppError::NotFound)?
        .uid;
    let editions = sqlx::query_as::<_, EditionBook>(
        "SELECT br.id, br.uid AS book_uid, br.title, br.author, \
                CASE WHEN EXISTS ( \
                    SELECT 1 FROM books b WHERE b.book_uid = br.uid \
                ) THEN 1 ELSE 0 END AS in_library \
         FROM book_edition_links el \
         JOIN book_records br ON br.uid = CASE \
             WHEN el.book_uid_a = ?1 THEN el.book_uid_b ELSE el.book_uid_a \
         END \
         WHERE el.book_uid_a = ?1 OR el.book_uid_b = ?1 \
         ORDER BY COALESCE(br.last_opened_at, br.created_at) DESC, br.id",
    )
    .bind(&uid)
    .fetch_all(pool)
    .await?;
    Ok(editions)
}
