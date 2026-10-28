//! Hybrid logical clock and small `sync_meta` helpers.
//!
//! `next_hlc` is a single SQLite upsert: two concurrent callers cannot hand
//! out the same `(wall, counter)`, which is what makes the device-id
//! tie-breaker rare rather than load-bearing.

use sqlx::SqlitePool;

use crate::error::AppError;

use super::model::Hlc;

pub const META_HLC: &str = "hlc";
pub const META_DEVICE_ID: &str = "device_id";
pub const META_DEVICE_NAME: &str = "device_name";
pub const META_FOLDER: &str = "folder_path";
pub const META_LIBRARY_ID: &str = "library_id";
pub const META_ENABLED: &str = "enabled";
pub const META_BASELINE_DONE: &str = "baseline_done";
pub const META_LAST_SYNC: &str = "last_sync_at";
pub const META_LAST_ERROR: &str = "last_error";

pub async fn get_meta(pool: &SqlitePool, key: &str) -> Result<Option<String>, AppError> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(value)
}

pub async fn set_meta(pool: &SqlitePool, key: &str, value: &str) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO sync_meta (key, value) VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_meta(pool: &SqlitePool, key: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM sync_meta WHERE key = ?1")
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn device_id(pool: &SqlitePool) -> Result<String, AppError> {
    if let Some(id) = get_meta(pool, META_DEVICE_ID).await? {
        if !id.is_empty() {
            return Ok(id);
        }
    }
    let id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
        .fetch_one(pool)
        .await?;
    set_meta(pool, META_DEVICE_ID, &id).await?;
    Ok(id)
}

/// Take the next clock value. The CASE reads the row it is updating, so the
/// counter only increments when the wall clock did not advance.
pub async fn next_hlc(pool: &SqlitePool) -> Result<Hlc, AppError> {
    let device = device_id(pool).await?;
    let value: String = sqlx::query_scalar(
        r#"
        INSERT INTO sync_meta (key, value)
        VALUES ('hlc', printf('%d:0', CAST(unixepoch('subsec') * 1000 AS INTEGER)))
        ON CONFLICT(key) DO UPDATE SET value =
            CASE
                WHEN CAST(substr(excluded.value, 1, instr(excluded.value, ':') - 1) AS INTEGER)
                   > CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER)
                THEN excluded.value
                ELSE printf(
                    '%d:%d',
                    CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER),
                    CAST(substr(sync_meta.value, instr(sync_meta.value, ':') + 1) AS INTEGER) + 1
                )
            END
        RETURNING value
        "#,
    )
    .fetch_one(pool)
    .await?;
    parse_hlc(&value, &device)
}

/// Move the local clock forward when a remote writer is ahead. The local
/// device id stays local; only the physical/counter components are observed.
pub async fn observe_hlc(pool: &SqlitePool, remote: &Hlc) -> Result<(), AppError> {
    let incoming = format!("{}:{}", remote.wall, remote.counter);
    sqlx::query(
        r#"
        INSERT INTO sync_meta (key, value) VALUES ('hlc', ?1)
        ON CONFLICT(key) DO UPDATE SET value =
            CASE
                WHEN CAST(substr(excluded.value, 1, instr(excluded.value, ':') - 1) AS INTEGER)
                   > CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER)
                THEN excluded.value
                WHEN CAST(substr(excluded.value, 1, instr(excluded.value, ':') - 1) AS INTEGER)
                   = CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER)
                 AND CAST(substr(excluded.value, instr(excluded.value, ':') + 1) AS INTEGER)
                   > CAST(substr(sync_meta.value, instr(sync_meta.value, ':') + 1) AS INTEGER)
                THEN excluded.value
                ELSE sync_meta.value
            END
        "#,
    )
    .bind(&incoming)
    .execute(pool)
    .await?;
    Ok(())
}

fn parse_hlc(value: &str, device: &str) -> Result<Hlc, AppError> {
    let (wall, counter) = value
        .split_once(':')
        .ok_or_else(|| AppError::InvalidInput(format!("bad hlc value: {value}")))?;
    Ok(Hlc {
        wall: wall
            .parse()
            .map_err(|_| AppError::InvalidInput(format!("bad hlc wall: {wall}")))?,
        counter: counter
            .parse()
            .map_err(|_| AppError::InvalidInput(format!("bad hlc counter: {counter}")))?,
        device: device.to_string(),
    })
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn rfc3339_millis(value: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(value)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> (tempfile::TempDir, SqlitePool) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        (tmp, pool)
    }

    #[tokio::test]
    async fn clock_is_monotonic_under_a_frozen_wall() {
        let (_tmp, pool) = pool().await;
        let first = next_hlc(&pool).await.unwrap();
        let second = next_hlc(&pool).await.unwrap();
        assert!(
            second > first,
            "second {second:?} must sort after {first:?}"
        );
        assert_eq!(second.device, first.device);
    }

    #[tokio::test]
    async fn observing_a_future_clock_moves_local_time_forward() {
        let (_tmp, pool) = pool().await;
        let remote = Hlc {
            wall: 9_999_999_999_999,
            counter: 7,
            device: "remote".into(),
        };
        observe_hlc(&pool, &remote).await.unwrap();
        let next = next_hlc(&pool).await.unwrap();
        assert!(next.wall > remote.wall || (next.wall == remote.wall && next.counter > 7));
    }

    #[tokio::test]
    async fn device_id_is_stable() {
        let (_tmp, pool) = pool().await;
        let first = device_id(&pool).await.unwrap();
        let second = device_id(&pool).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
    }
}
