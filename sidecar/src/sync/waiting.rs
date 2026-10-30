//! Books whose shared state is waiting for their content on this machine.
//!
//! The mirror can hold progress, annotations, metadata, and last-opened state
//! for a durable book that has no local file binding. The sync status counts
//! them, and Settings > Sync lists them so the user can identify an orphaned
//! book. "Forget on this device" hides one here without deleting the shared
//! copy in the folder; importing the exact bytes can still project the state.

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::AppError;

/// One book with mirror state but no local file binding.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingBook {
    pub book_uid: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub progress_percent: Option<f64>,
    pub annotation_count: i64,
    pub last_opened_at: Option<String>,
    /// First annotation text, for identifying a book with no metadata.
    pub sample_annotation: Option<String>,
}

const WAITING_UIDS: &str = r#"
    SELECT DISTINCT e.book_uid
    FROM sync_state_entities e
    WHERE e.book_uid IS NOT NULL
      AND e.book_uid NOT IN (SELECT book_uid FROM sync_book_bindings)
      AND e.book_uid NOT IN (SELECT book_uid FROM sync_ignored_books)
      AND NOT EXISTS (
          SELECT 1 FROM sync_state_entities b
          WHERE b.book_uid = e.book_uid
            AND b.kind = 'book'
            AND b.deleted = 1
      )
"#;

/// Count the waiting books without loading their details.
pub async fn count(pool: &SqlitePool) -> Result<i64, AppError> {
    let sql = format!("SELECT COUNT(*) FROM ({WAITING_UIDS})");
    let count = sqlx::query_scalar(&sql).fetch_one(pool).await?;
    Ok(count)
}

/// List the waiting books, newest-looking first by title or uid.
pub async fn list(pool: &SqlitePool) -> Result<Vec<WaitingBook>, AppError> {
    let sql = format!("{WAITING_UIDS} ORDER BY book_uid LIMIT 500");
    let uids: Vec<String> = sqlx::query_scalar(&sql).fetch_all(pool).await?;
    let mut books = Vec::with_capacity(uids.len());
    for book_uid in uids {
        let fields: Vec<(String, String)> = sqlx::query_as(
            "SELECT f.field, f.value_json
             FROM sync_state_fields f
             JOIN sync_state_entities e ON e.kind = f.kind AND e.entity_uid = f.entity_uid
             WHERE e.book_uid = ?1 AND e.kind = 'metadata' AND e.deleted = 0",
        )
        .bind(&book_uid)
        .fetch_all(pool)
        .await?;

        let mut title = None;
        let mut author = None;
        for (field, raw) in fields {
            let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            match field.as_str() {
                "title" => title = value.as_str().map(str::to_string),
                "authors" => {
                    author = value.as_array().map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    });
                }
                _ => {}
            }
        }

        let progress_percent = value_field(pool, &book_uid, "progress", "progress_percent")
            .await?
            .and_then(|value| value.as_f64());
        let last_opened_at = value_field(pool, &book_uid, "opened", "last_opened_at")
            .await?
            .and_then(|value| value.as_str().map(str::to_string));
        let sample_annotation = value_field(pool, &book_uid, "annotation", "text")
            .await?
            .and_then(|value| value.as_str().map(str::to_string));
        let annotation_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_state_entities
             WHERE book_uid = ?1 AND kind = 'annotation' AND deleted = 0",
        )
        .bind(&book_uid)
        .fetch_one(pool)
        .await?;

        books.push(WaitingBook {
            book_uid,
            title,
            author,
            progress_percent,
            annotation_count,
            last_opened_at,
            sample_annotation,
        });
    }
    Ok(books)
}

async fn value_field(
    pool: &SqlitePool,
    book_uid: &str,
    kind: &str,
    field: &str,
) -> Result<Option<Value>, AppError> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT f.value_json
         FROM sync_state_fields f
         JOIN sync_state_entities e ON e.kind = f.kind AND e.entity_uid = f.entity_uid
         WHERE e.book_uid = ?1 AND e.kind = ?2 AND e.deleted = 0
           AND f.field = ?3 AND f.value_json <> 'null'
         LIMIT 1",
    )
    .bind(book_uid)
    .bind(kind)
    .bind(field)
    .fetch_optional(pool)
    .await?;
    let parsed: Option<Value> = raw.and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(parsed.filter(|value| !value.is_null()))
}

/// Hide every waiting book on this device. The mirror state stays in the
/// folder for a future import; other devices are untouched.
pub async fn forget_all(pool: &SqlitePool) -> Result<usize, AppError> {
    let sql = format!(
        "INSERT OR IGNORE INTO sync_ignored_books (book_uid)
         SELECT book_uid FROM ({WAITING_UIDS})"
    );
    let result = sqlx::query(&sql).execute(pool).await?;
    Ok(result.rows_affected() as usize)
}

/// Hide a waiting book on this device. The mirror state stays in place so the
/// same bytes can still project it later. Returns false when the uid is not
/// currently waiting.
pub async fn forget(pool: &SqlitePool, book_uid: &str) -> Result<bool, AppError> {
    let sql = format!("SELECT 1 FROM ({WAITING_UIDS}) WHERE book_uid = ?1");
    let waiting: Option<i64> = sqlx::query_scalar(&sql)
        .bind(book_uid)
        .fetch_optional(pool)
        .await?;
    if waiting.is_none() {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO sync_ignored_books (book_uid) VALUES (?1)
         ON CONFLICT(book_uid) DO NOTHING",
    )
    .bind(book_uid)
    .execute(pool)
    .await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAITING: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const IGNORED: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TOMBSTONED: &str = "cccccccccccccccccccccccccccccccc";

    async fn insert_entity(pool: &SqlitePool, kind: &str, uid: &str, book_uid: &str) {
        sqlx::query(
            "INSERT INTO sync_state_entities (kind, entity_uid, book_uid) VALUES (?1, ?2, ?3)",
        )
        .bind(kind)
        .bind(uid)
        .bind(book_uid)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_field(pool: &SqlitePool, kind: &str, uid: &str, field: &str, value: &str) {
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES (?1, ?2, ?3, ?4, 1, 0, 'test')",
        )
        .bind(kind)
        .bind(uid)
        .bind(field)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn list_reports_the_metadata_progress_and_annotation_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        insert_entity(&pool, "metadata", WAITING, WAITING).await;
        insert_field(&pool, "metadata", WAITING, "title", "\"Waiting Title\"").await;
        insert_field(
            &pool,
            "metadata",
            WAITING,
            "authors",
            "[\"Alice\", \"Bob\", 7]",
        )
        .await;
        insert_entity(&pool, "progress", "p1", WAITING).await;
        insert_field(&pool, "progress", "p1", "progress_percent", "42.5").await;
        insert_entity(&pool, "opened", "o1", WAITING).await;
        insert_field(
            &pool,
            "opened",
            "o1",
            "last_opened_at",
            "\"2026-01-02T03:04:05.000Z\"",
        )
        .await;
        insert_entity(&pool, "annotation", "a1", WAITING).await;
        insert_field(&pool, "annotation", "a1", "text", "\"the first highlight\"").await;
        // A second annotation raises the count but is not the named sample.
        insert_entity(&pool, "annotation", "a2", WAITING).await;

        // Deleted annotations do not count.
        insert_entity(&pool, "annotation", "a3", WAITING).await;
        sqlx::query(
            "UPDATE sync_state_entities SET deleted = 1 WHERE kind = 'annotation' AND entity_uid = 'a3'",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Hidden books and books with a shared tombstone never appear.
        insert_entity(&pool, "progress", "p2", IGNORED).await;
        sqlx::query("INSERT INTO sync_ignored_books (book_uid) VALUES (?1)")
            .bind(IGNORED)
            .execute(&pool)
            .await
            .unwrap();
        insert_entity(&pool, "progress", "p3", TOMBSTONED).await;
        sqlx::query(
            "INSERT INTO sync_state_entities (kind, entity_uid, book_uid, deleted)
             VALUES ('book', ?1, ?1, 1)",
        )
        .bind(TOMBSTONED)
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(count(&pool).await.unwrap(), 1);

        let listed = list(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        let book = &listed[0];
        assert_eq!(book.book_uid, WAITING);
        assert_eq!(book.title.as_deref(), Some("Waiting Title"));
        assert_eq!(book.author.as_deref(), Some("Alice, Bob"));
        assert_eq!(book.progress_percent, Some(42.5));
        assert_eq!(
            book.last_opened_at.as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        assert_eq!(
            book.sample_annotation.as_deref(),
            Some("the first highlight")
        );
        assert_eq!(book.annotation_count, 2);
    }

    #[tokio::test]
    async fn forgetting_hides_one_book_and_reports_unknown_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        insert_entity(&pool, "progress", "p1", WAITING).await;

        assert!(
            !forget(&pool, IGNORED).await.unwrap(),
            "a uid that is not waiting cannot be forgotten"
        );
        assert!(forget(&pool, WAITING).await.unwrap());
        assert!(list(&pool).await.unwrap().is_empty());
        assert_eq!(count(&pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn forget_all_reports_how_many_books_it_hid() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        insert_entity(&pool, "progress", "p1", WAITING).await;
        insert_entity(&pool, "progress", "p2", "dddddddddddddddddddddddddddddddd").await;

        assert_eq!(forget_all(&pool).await.unwrap(), 2);
        assert!(list(&pool).await.unwrap().is_empty());
        assert_eq!(forget_all(&pool).await.unwrap(), 0);
    }
}
