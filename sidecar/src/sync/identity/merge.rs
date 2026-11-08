//! Folding two book identities into one: the durable-record merge.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::clock::META_LIBRARY_RELOAD;
use crate::sync::model::EntityKind;

use super::alias::{canonical_book_uid, forgotten_replacement};
use super::state::{merge_entity_uid, merge_self_keyed};

/// Re-key every shared row from `loser` to `winner`. This is how two devices
/// that imported the same bytes before meeting converge on one identity.
pub async fn merge_book_identity(
    pool: &SqlitePool,
    loser: &str,
    winner: &str,
) -> Result<(), AppError> {
    let winner = canonical_book_uid(pool, winner).await?;
    let loser = canonical_book_uid(pool, loser).await?;
    if loser == winner {
        return Ok(());
    }
    // Delete wins. Folding a live or forgotten identity into a forgotten one
    // would resurrect the old uuid through sync_book_merges; leave the two
    // identities alone until an explicit restore clears the tombstone.
    if forgotten_replacement(pool, &winner).await?.is_some()
        || forgotten_replacement(pool, &loser).await?.is_some()
    {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    // A merge can move a visible file row to a different record id. Mark the
    // reload as part of the merge transaction, so a later pass still repairs
    // the renderer if this pass aborts before it can emit.
    sqlx::query(
        "INSERT INTO sync_meta (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'",
    )
    .bind(META_LIBRARY_RELOAD)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)
        ON CONFLICT(loser) DO UPDATE SET winner = excluded.winner
        "#,
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE sync_book_bindings SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sync_book_aliases SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;

    // Fold the losing durable record into the winner and point every local
    // file row at it. Progress uses the winner's value (the deterministic
    // canonical identity), annotation counts add up, and the latest opened
    // timestamp wins.
    sqlx::query(
        r#"
        INSERT INTO book_records (
            uid, created_at, title, subtitle, author, publisher, language,
            isbn, description, publication_date, series, series_index,
            cover_path, last_opened_at, progress_percent, annotation_count,
            metadata_state
        )
        SELECT
            ?2,
            COALESCE(
                (SELECT created_at FROM book_records WHERE uid = ?2),
                (SELECT created_at FROM book_records WHERE uid = ?1),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            ),
            COALESCE(
                (SELECT title FROM book_records WHERE uid = ?2),
                (SELECT title FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT subtitle FROM book_records WHERE uid = ?2),
                (SELECT subtitle FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT author FROM book_records WHERE uid = ?2),
                (SELECT author FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT publisher FROM book_records WHERE uid = ?2),
                (SELECT publisher FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT language FROM book_records WHERE uid = ?2),
                (SELECT language FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT isbn FROM book_records WHERE uid = ?2),
                (SELECT isbn FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT description FROM book_records WHERE uid = ?2),
                (SELECT description FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT publication_date FROM book_records WHERE uid = ?2),
                (SELECT publication_date FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT series FROM book_records WHERE uid = ?2),
                (SELECT series FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT series_index FROM book_records WHERE uid = ?2),
                (SELECT series_index FROM book_records WHERE uid = ?1)
            ),
            COALESCE(
                (SELECT cover_path FROM book_records WHERE uid = ?2),
                (SELECT cover_path FROM book_records WHERE uid = ?1)
            ),
            (SELECT MAX(last_opened_at) FROM book_records WHERE uid IN (?1, ?2)),
            COALESCE(
                (SELECT progress_percent FROM book_records WHERE uid = ?2),
                (SELECT progress_percent FROM book_records WHERE uid = ?1)
            ),
            COALESCE((SELECT annotation_count FROM book_records WHERE uid = ?2), 0)
                + COALESCE((SELECT annotation_count FROM book_records WHERE uid = ?1), 0),
            CASE
                WHEN COALESCE(
                    (SELECT metadata_state FROM book_records WHERE uid = ?2), ''
                ) = 'available'
                OR COALESCE(
                    (SELECT metadata_state FROM book_records WHERE uid = ?1), ''
                ) = 'available'
                THEN 'available'
                ELSE 'waiting_for_file'
            END
        WHERE EXISTS (SELECT 1 FROM book_records WHERE uid IN (?1, ?2))
        ON CONFLICT(uid) DO UPDATE SET
            created_at = excluded.created_at,
            title = excluded.title,
            subtitle = excluded.subtitle,
            author = excluded.author,
            publisher = excluded.publisher,
            language = excluded.language,
            isbn = excluded.isbn,
            description = excluded.description,
            publication_date = excluded.publication_date,
            series = excluded.series,
            series_index = excluded.series_index,
            cover_path = excluded.cover_path,
            last_opened_at = excluded.last_opened_at,
            progress_percent = excluded.progress_percent,
            annotation_count = excluded.annotation_count,
            metadata_state = excluded.metadata_state
        "#,
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE books SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;

    // User state moved to the durable key in 0018. Annotations from both
    // copies are kept (union; duplicate highlights are possible). Progress
    // keeps the newest saved position; a tie falls back deterministically to
    // the losing copy's row so exactly one survives.
    sqlx::query("UPDATE annotations SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM reading_progress WHERE book_uid = ?2 AND EXISTS (
             SELECT 1 FROM reading_progress l
             WHERE l.book_uid = ?1
               AND l.updated_at >= reading_progress.updated_at
         )",
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE OR IGNORE reading_progress SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM reading_progress WHERE book_uid = ?1")
        .bind(&loser)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE book_records SET
             progress_percent = (SELECT progress_percent FROM reading_progress WHERE book_uid = ?2),
             annotation_count = (SELECT COUNT(*) FROM annotations WHERE book_uid = ?2)
         WHERE uid = ?2",
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;

    // Metadata overrides and collection membership now belong to the durable
    // book too. The newest copy's overrides win; a tie keeps the winner.
    // Memberships from both copies are unioned.
    let (winner_newest, loser_newest): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT
             (SELECT MAX(modified_at) FROM books WHERE book_uid = ?2),
             (SELECT MAX(modified_at) FROM books WHERE book_uid = ?1)",
    )
    .bind(&loser)
    .bind(&winner)
    .fetch_one(&mut *tx)
    .await?;
    let winner_has_overrides: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM book_metadata_overrides WHERE book_uid = ?1)",
    )
    .bind(&winner)
    .fetch_one(&mut *tx)
    .await?;
    let loser_has_overrides: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM book_metadata_overrides WHERE book_uid = ?1)",
    )
    .bind(&loser)
    .fetch_one(&mut *tx)
    .await?;
    let loser_is_newer = match (&loser_newest, &winner_newest) {
        (Some(loser), Some(winner)) => loser > winner,
        (Some(_), None) => true,
        _ => false,
    };
    if loser_has_overrides && (!winner_has_overrides || loser_is_newer) {
        sqlx::query("DELETE FROM book_authors WHERE book_uid = ?1")
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM book_subjects WHERE book_uid = ?1")
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM book_metadata_overrides WHERE book_uid = ?1")
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE book_metadata_overrides SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&loser)
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE book_authors SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&loser)
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE book_subjects SET book_uid = ?2 WHERE book_uid = ?1")
            .bind(&loser)
            .bind(&winner)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "INSERT OR IGNORE INTO book_collections (book_uid, collection_id, added_at)
         SELECT ?2, collection_id, added_at FROM book_collections WHERE book_uid = ?1",
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM book_records WHERE uid = ?1")
        .bind(&loser)
        .execute(&mut *tx)
        .await?;

    for kind in [
        EntityKind::Progress,
        EntityKind::Metadata,
        EntityKind::Opened,
        EntityKind::FileVersion,
    ] {
        merge_self_keyed(&mut tx, kind, &loser, &winner).await?;
    }
    sqlx::query("UPDATE sync_state_entities SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;

    // Memberships are keyed collection:book, so the suffix changes too.
    let memberships: Vec<String> = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities
         WHERE kind = 'membership' AND book_uid = ?1",
    )
    .bind(&winner)
    .fetch_all(&mut *tx)
    .await?;
    for uid in memberships {
        if let Some((collection, _)) = uid.rsplit_once(':') {
            let next = format!("{collection}:{winner}");
            merge_entity_uid(&mut tx, EntityKind::Membership, &uid, &next, &winner).await?;
        }
    }

    sqlx::query("UPDATE sync_trash SET book_uid = ?2 WHERE book_uid = ?1")
        .bind(&loser)
        .bind(&winner)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // The surviving book's effective metadata may now come from the newer
    // copy's source and overrides, so recompute it once the durable rows have
    // settled.
    if let Some(file_id) = crate::repository::metadata::primary_file_id(pool, &winner).await? {
        crate::repository::metadata::recompute_effective(pool, &winner, file_id).await?;
    }
    Ok(())
}
