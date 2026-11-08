//! Collection identity: merging two local shelves that share a name.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::model::EntityKind;

use super::state::merge_entity_uid;

/// Merge two local collections that share a name (the local UNIQUE constraint
/// means the user sees one shelf). The caller picks canonical ids and projects
/// the surviving row.
pub async fn merge_collection_identity(
    pool: &SqlitePool,
    loser: &str,
    winner: &str,
) -> Result<(), AppError> {
    if loser == winner {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)
        ON CONFLICT(kind, loser) DO UPDATE SET winner = excluded.winner
        "#,
    )
    .bind(loser)
    .bind(winner)
    .execute(&mut *tx)
    .await?;

    // The collection entity is field-level (name/created_at). Make sure the
    // surviving entity exists before moving fields under it.
    sqlx::query(
        "INSERT INTO sync_state_entities (kind, entity_uid) VALUES ('collection', ?1)
         ON CONFLICT(kind, entity_uid) DO NOTHING",
    )
    .bind(winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
        SELECT kind, ?2, field, value_json, hlc_wall, hlc_counter, hlc_device
        FROM sync_state_fields WHERE kind = 'collection' AND entity_uid = ?1
        ON CONFLICT(kind, entity_uid, field) DO UPDATE SET
            value_json = excluded.value_json,
            hlc_wall = excluded.hlc_wall,
            hlc_counter = excluded.hlc_counter,
            hlc_device = excluded.hlc_device
        WHERE (excluded.hlc_wall, excluded.hlc_counter, excluded.hlc_device)
            > (sync_state_fields.hlc_wall, sync_state_fields.hlc_counter,
               sync_state_fields.hlc_device)
        "#,
    )
    .bind(loser)
    .bind(winner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sync_state_fields WHERE kind = 'collection' AND entity_uid = ?1")
        .bind(loser)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sync_state_entities WHERE kind = 'collection' AND entity_uid = ?1")
        .bind(loser)
        .execute(&mut *tx)
        .await?;
    // Membership entity ids embed the collection uid.
    let memberships: Vec<String> = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities
         WHERE kind = 'membership' AND entity_uid LIKE ?1",
    )
    .bind(format!("{loser}:%"))
    .fetch_all(&mut *tx)
    .await?;
    for uid in memberships {
        if let Some((_, book)) = uid.rsplit_once(':') {
            let next = format!("{winner}:{book}");
            merge_entity_uid(&mut tx, EntityKind::Membership, &uid, &next, book).await?;
        }
    }
    sqlx::query(
        "UPDATE sync_trash SET entity_uid = ?2 WHERE kind = 'collection' AND entity_uid = ?1",
    )
    .bind(loser)
    .bind(winner)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn canonical_entity_uid(
    pool: &SqlitePool,
    kind: EntityKind,
    uid: &str,
) -> Result<String, AppError> {
    let mut current = uid.to_string();
    for _ in 0..32 {
        let next: Option<String> = sqlx::query_scalar(
            "SELECT winner FROM sync_entity_merges WHERE kind = ?1 AND loser = ?2",
        )
        .bind(kind.as_str())
        .bind(&current)
        .fetch_optional(pool)
        .await?;
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    Ok(current)
}
