use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::domain::StartupRecovery;
use crate::error::AppError;

/// Open (creating if needed) the SQLite database at `db_path`, run all embedded
/// migrations, and return a connection pool. Deterministic: calling it twice on
/// the same path yields the same schema. A broken existing file is quarantined
/// first (see `init_pool_recovering`); the recovery report is dropped here.
pub async fn init_pool(db_path: &Path) -> Result<SqlitePool, AppError> {
    let (pool, _recovery) = init_pool_recovering(db_path).await?;
    Ok(pool)
}

/// Open the database, self-healing a broken file: when the open, the
/// integrity check, or the migrations fail, move the database and its WAL and
/// shared-memory sidecars aside under a timestamped `.corrupt-*` name in the
/// same directory, then create a fresh database and migrate it. The broken
/// files are never deleted. Returns the pool and, when a quarantine happened,
/// the from/to pair so main can report it.
pub async fn init_pool_recovering(
    db_path: &Path,
) -> Result<(SqlitePool, Option<StartupRecovery>), AppError> {
    match open_checked(db_path).await {
        Ok(pool) => Ok((pool, None)),
        Err(err) => {
            // A missing path means an environment problem (permissions, a
            // missing parent), not a broken database; there is nothing to
            // quarantine and a retry would only repeat the failure.
            if !db_path.exists() {
                return Err(err);
            }
            eprintln!(
                "database at {} is not usable ({err}); quarantining it and starting fresh",
                db_path.display()
            );
            let recovery = quarantine_files(db_path)?;
            eprintln!(
                "quarantined broken database: {} -> {}",
                recovery.from, recovery.to
            );
            // One retry only: the broken file is gone, so a second failure is
            // a real environment error and propagates to the fatal path.
            let pool = open_checked(db_path).await?;
            Ok((pool, Some(recovery)))
        }
    }
}

/// Open the pool and verify the file before use: `PRAGMA quick_check(1)` runs
/// once right after connecting, and any result other than `ok` reads as
/// corruption. Migrations run last, so a schema failure is caught too.
async fn open_checked(db_path: &Path) -> Result<SqlitePool, AppError> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;

    let integrity: String = sqlx::query_scalar("PRAGMA quick_check(1)")
        .fetch_one(&pool)
        .await?;
    if integrity != "ok" {
        return Err(AppError::InvalidInput(format!(
            "database integrity check failed: {integrity}"
        )));
    }

    run_migrations(&pool).await?;
    Ok(pool)
}

async fn run_migrations(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::migrate!().run(pool).await?;
    Ok(())
}

/// Move the database and its sidecars aside without deleting them. The
/// database move is required for the fresh start; a sidecar that cannot move
/// is logged, not fatal, because the fresh database is created at the now-free
/// path either way.
fn quarantine_files(db_path: &Path) -> Result<StartupRecovery, AppError> {
    let target = quarantine_target(db_path);
    std::fs::rename(db_path, &target)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = append_suffix(db_path, suffix);
        if !sidecar.exists() {
            continue;
        }
        let sidecar_target = append_suffix(&target, suffix);
        if let Err(err) = std::fs::rename(&sidecar, &sidecar_target) {
            eprintln!(
                "could not move database sidecar {} aside: {err}",
                sidecar.display()
            );
        }
    }
    Ok(StartupRecovery {
        from: db_path.to_string_lossy().into_owned(),
        to: target.to_string_lossy().into_owned(),
    })
}

/// The quarantine timestamp format: human-readable UTC. Matches the reset
/// path's `quarantineStamp` in electron/main/resetData.ts; the two pinned
/// tests ("...matches the reset path format") keep the pair in step.
fn quarantine_stamp(now: chrono::DateTime<chrono::Utc>) -> String {
    now.format("%Y%m%dT%H%M%S%.3fZ").to_string()
}

/// Pick a free `<db filename>.corrupt-<timestamp>` name in the database's
/// directory. The timestamp is human-readable UTC; when that name already
/// exists (two recoveries in the same millisecond, or a Windows rename whose
/// target is present), a counter keeps the name unique.
fn quarantine_target(db_path: &Path) -> PathBuf {
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = db_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tuxbooks.db".to_string());
    let stamp = quarantine_stamp(chrono::Utc::now());
    for attempt in 0..1_000u32 {
        let candidate = if attempt == 0 {
            parent.join(format!("{file_name}.corrupt-{stamp}"))
        } else {
            parent.join(format!("{file_name}.corrupt-{stamp}-{attempt}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    parent.join(format!("{file_name}.corrupt-{stamp}-{nanos}"))
}

/// Append a SQLite sidecar suffix (`-wal`, `-shm`) to a full file name.
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn init_pool_is_deterministic_and_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("nested").join("tuxbooks.db");

        let pool = init_pool(&db_path).await.unwrap();
        assert!(db_path.exists());

        // Re-opening the same database must succeed (migrations are idempotent).
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn schema_contains_all_core_tables() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();

        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();

        for expected in [
            "books",
            "collections",
            "book_collections",
            "reading_progress",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn quarantine_stamp_matches_the_reset_path_format() {
        let when = chrono::DateTime::parse_from_rfc3339("2026-09-22T08:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(quarantine_stamp(when), "20260922T080000.000Z");
    }

    #[test]
    fn quarantine_moves_the_database_and_its_sidecars_without_deleting() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("tuxbooks.db");
        std::fs::write(&db_path, b"db bytes").unwrap();
        std::fs::write(tmp.path().join("tuxbooks.db-wal"), b"wal bytes").unwrap();
        std::fs::write(tmp.path().join("tuxbooks.db-shm"), b"shm bytes").unwrap();

        let recovery = quarantine_files(&db_path).unwrap();

        assert_eq!(recovery.from, db_path.to_string_lossy());
        let target = PathBuf::from(&recovery.to);
        let target_name = target.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            target_name.starts_with("tuxbooks.db.corrupt-"),
            "name was {target_name}"
        );
        assert!(!db_path.exists(), "the broken database moves away");
        assert_eq!(std::fs::read(&target).unwrap(), b"db bytes");
        for (suffix, contents) in [("-wal", b"wal bytes"), ("-shm", b"shm bytes")] {
            assert!(
                !tmp.path().join(format!("tuxbooks.db{suffix}")).exists(),
                "{suffix} sidecar moves away"
            );
            let moved = target.with_file_name(format!("{target_name}{suffix}"));
            assert_eq!(std::fs::read(&moved).unwrap(), contents);
        }
    }
}
