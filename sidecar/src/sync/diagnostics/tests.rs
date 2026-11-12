//! Diagnostics snapshot tests.

use std::fs;
use std::path::Path;

use sqlx::SqlitePool;

use super::*;

async fn pool_in(dir: &Path) -> SqlitePool {
    crate::db::connection::init_pool(&dir.join("t.db"))
        .await
        .unwrap()
}

fn enabled_status(folder: &Path) -> SyncStatus {
    SyncStatus {
        enabled: true,
        folder: Some(folder.to_string_lossy().into_owned()),
        library_id: None,
        device_id: None,
        device_name: None,
        state: SyncState::Idle,
        last_sync_at: Some("2026-10-31T10:00:00.000Z".into()),
        last_error: None,
        pending_local: 0,
        waiting_books: 0,
        issues: 0,
        trash: 0,
        auto_retry: true,
    }
}

fn disabled_status() -> SyncStatus {
    SyncStatus {
        enabled: false,
        folder: None,
        library_id: None,
        device_id: None,
        device_name: None,
        state: SyncState::Disabled,
        last_sync_at: None,
        last_error: None,
        pending_local: 9,
        waiting_books: 9,
        issues: 9,
        trash: 9,
        auto_retry: false,
    }
}

async fn add_failed_book(pool: &SqlitePool, title: &str, path: &str, attempts: i64) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO books (path, title, hash_state, hash_attempts, hash_retry_at)
         VALUES (?1, ?2, 'failed', ?3, '2999-01-01T00:00:00.000Z')
         RETURNING id",
    )
    .bind(path)
    .bind(title)
    .bind(attempts)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn enabled_payload_reports_live_status_counts_lists_and_versions() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    store::connect(&folder, "a".repeat(32).as_str(), "Laptop", "now").unwrap();
    let mut status = enabled_status(&folder);
    status.pending_local = 4;
    status.waiting_books = 2;
    status.issues = 3;
    status.trash = 1;

    let book_id = add_failed_book(&pool, "Example", "/books/example.epub", 2).await;
    sqlx::query("INSERT INTO book_records (uid, title) VALUES (?1, 'Example')")
        .bind("b".repeat(32))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
         VALUES ('annotation', 'e', ?1)",
    )
    .bind("b".repeat(32))
    .execute(&pool)
    .await
    .unwrap();
    // Six open diagnostic rows are counted from the table itself: the live
    // status payload no longer carries a conflicts count. A resolved row
    // stays out of the count; a progress row counts like any other.
    sqlx::query(
        "INSERT INTO sync_conflicts
            (kind, entity_uid, field, winner_json, loser_json,
             winner_wall, winner_count, winner_dev,
             loser_wall, loser_count, loser_dev, created_at)
         VALUES ('annotation', 'e', 'note', '\"kept secret\"', '\"lost secret\"',
                 2, 0, 'aaa', 1, 0, 'bbb', '2026-10-31T09:00:00.000Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    for entity in ["e2", "e3", "e4", "e5"] {
        sqlx::query(
            "INSERT INTO sync_conflicts
                (kind, entity_uid, field, winner_json, loser_json,
                 winner_wall, winner_count, winner_dev,
                 loser_wall, loser_count, loser_dev, created_at)
             VALUES ('annotation', ?1, 'note', '\"kept secret\"', '\"lost secret\"',
                     2, 0, 'aaa', 1, 0, 'bbb', '2026-10-30T09:00:00.000Z')",
        )
        .bind(entity)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO sync_conflicts
            (kind, entity_uid, field, winner_json, loser_json,
             winner_wall, winner_count, winner_dev,
             loser_wall, loser_count, loser_dev, created_at, resolved_at)
         VALUES ('annotation', 'e-resolved', 'note', '\"w\"', '\"l\"',
                 2, 0, 'aaa', 1, 0, 'bbb', '2026-10-31T09:00:00.000Z',
                 '2026-10-31T09:30:00.000Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_conflicts
            (kind, entity_uid, field, winner_json, loser_json,
             winner_wall, winner_count, winner_dev,
             loser_wall, loser_count, loser_dev, created_at)
         VALUES ('progress', 'e-progress', '__entity__', '\"w\"', '\"l\"',
                 2, 0, 'aaa', 1, 0, 'bbb', '2026-10-31T09:00:00.000Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
        .bind("c".repeat(32))
        .bind("d".repeat(32))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)",
    )
    .bind("f".repeat(32))
    .bind("a".repeat(32))
    .execute(&pool)
    .await
    .unwrap();
    // An in-flight auto-retry row: the dump carries the attempts and the
    // scheduled next try so support can read the budget from the report.
    sqlx::query(
        "INSERT INTO sync_issues (issue_key, kind, detail, file_name,
                auto_attempts, next_auto_retry_at, created_at)
         VALUES ('cover-missing:x.png', 'cover_missing',
                 'cover publish failed (auto-retry 2/5)', 'x.png',
                 2, '2026-11-08T12:00:00.000Z', '2026-11-08T11:00:00.000Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let report = collect(&pool, Some(&status)).await.unwrap();
    assert!(report.sync.enabled);
    assert_eq!(report.sync.state, SyncState::Idle);
    assert!(report.sync.auto_retry, "the toggle state is on the report");
    assert_eq!(report.sync.counts.pending_local, 4);
    assert_eq!(report.sync.counts.waiting_books, 2);
    assert_eq!(report.sync.counts.issues, 3);
    assert_eq!(report.sync.counts.trash, 1);
    assert_eq!(report.sync.counts.conflicts, 6);
    assert_eq!(report.hash_failed.len(), 1);
    assert_eq!(report.hash_failed[0].book_id, book_id);
    assert_eq!(report.hash_failed[0].title, "Example");
    assert_eq!(report.hash_failed[0].path, "/books/example.epub");
    assert_eq!(report.hash_failed[0].attempts, 2);
    assert_eq!(report.open_conflicts.len(), 6);
    let note_conflict = report
        .open_conflicts
        .iter()
        .find(|conflict| conflict.field == "note")
        .expect("the annotation rows are sampled");
    assert_eq!(note_conflict.kind, "annotation");
    assert_eq!(note_conflict.book_title.as_deref(), Some("Example"));
    assert_eq!(report.issues.len(), 1);
    assert_eq!(report.issues[0].kind, "cover_missing");
    assert_eq!(
        report.issues[0].detail,
        "cover publish failed (auto-retry 2/5)"
    );
    assert_eq!(report.issues[0].file_name.as_deref(), Some("x.png"));
    assert_eq!(report.issues[0].auto_attempts, 2);
    assert_eq!(
        report.issues[0].next_auto_retry_at.as_deref(),
        Some("2026-11-08T12:00:00.000Z")
    );
    assert_eq!(report.recent_merges.books.len(), 1);
    assert_eq!(report.recent_merges.books[0].loser, "c".repeat(32));
    assert_eq!(report.recent_merges.entities[0].kind, "collection");
    assert_eq!(report.versions.library_marker, Some(OP_SCHEMA));
    assert_eq!(report.versions.op_schema, OP_SCHEMA);
    assert_eq!(report.versions.db_migration, max_migration(&pool).await);

    // The conflict values and any annotation text never appear.
    let json = serde_json::to_string(&report).unwrap();
    assert!(!json.contains("kept secret"));
    assert!(!json.contains("lost secret"));
    assert!(!json.contains("winnerJson"));
    assert!(!json.contains("loserJson"));
}

#[tokio::test]
async fn progress_conflicts_are_counted_and_sampled() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    store::connect(&folder, "a".repeat(32).as_str(), "Laptop", "now").unwrap();
    let status = enabled_status(&folder);

    sqlx::query("INSERT INTO book_records (uid, title) VALUES (?1, 'Example')")
        .bind("b".repeat(32))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
         VALUES ('progress', 'e-progress', ?1)",
    )
    .bind("b".repeat(32))
    .execute(&pool)
    .await
    .unwrap();
    let conflict_id: i64 = sqlx::query_scalar(
        "INSERT INTO sync_conflicts
            (kind, entity_uid, field, winner_json, loser_json,
             winner_wall, winner_count, winner_dev,
             loser_wall, loser_count, loser_dev, created_at)
         VALUES ('progress', 'e-progress', 'progress_percent', '\"w\"', '\"l\"',
                 2, 0, 'aaa', 1, 0, 'bbb', '2026-10-31T09:00:00.000Z')
         RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let report = collect(&pool, Some(&status)).await.unwrap();
    assert_eq!(
        report.sync.counts.conflicts, 1,
        "SYNC_ISSUES.md counts every open conflict"
    );
    let conflict = report
        .open_conflicts
        .iter()
        .find(|conflict| conflict.kind == "progress")
        .expect("the sample lists progress rows like any other kind");
    assert_eq!(conflict.id, conflict_id);
    assert_eq!(conflict.field, "progress_percent");
    assert_eq!(conflict.book_title.as_deref(), Some("Example"));
    assert_eq!(conflict.created_at, "2026-10-31T09:00:00.000Z");
}

#[tokio::test]
async fn a_running_pass_reports_syncing() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    let mut status = enabled_status(&folder);
    status.state = SyncState::Syncing;

    let report = collect(&pool, Some(&status)).await.unwrap();
    assert_eq!(report.sync.state, SyncState::Syncing);
}

#[tokio::test]
async fn disabled_sync_returns_zero_counts_and_local_version_data() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    add_failed_book(&pool, "Dangling", "/books/dangling.epub", 1).await;
    sqlx::query(
        "INSERT INTO sync_issues (issue_key, kind, detail, auto_attempts)
         VALUES ('cover-missing:y.png', 'cover_missing', 'test detail', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let status = disabled_status();

    let report = collect(&pool, Some(&status)).await.unwrap();
    assert!(!report.sync.enabled);
    assert_eq!(report.sync.state, SyncState::Disabled);
    assert!(report.sync.folder.is_none());
    assert!(!report.sync.auto_retry);
    assert_eq!(report.sync.counts.pending_local, 0);
    assert_eq!(report.sync.counts.waiting_books, 0);
    assert_eq!(report.sync.counts.issues, 0);
    assert_eq!(report.sync.counts.trash, 0);
    assert_eq!(report.sync.counts.conflicts, 0);
    assert!(report.open_conflicts.is_empty());
    assert!(
        report.issues.is_empty(),
        "issues are sync data: off means empty"
    );
    assert!(report.recent_merges.books.is_empty());
    assert!(report.recent_merges.entities.is_empty());
    assert_eq!(report.hash_failed.len(), 1);
    assert!(report.versions.library_marker.is_none());
    assert_eq!(report.versions.op_schema, OP_SCHEMA);
    assert!(report.versions.db_migration > 0);
}

#[tokio::test]
async fn all_empty_snapshot_still_reports_versions() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    store::connect(&folder, "a".repeat(32).as_str(), "Laptop", "now").unwrap();
    let status = enabled_status(&folder);

    let report = collect(&pool, Some(&status)).await.unwrap();
    assert!(report.hash_failed.is_empty());
    assert!(report.open_conflicts.is_empty());
    assert!(report.recent_merges.books.is_empty());
    assert!(report.recent_merges.entities.is_empty());
    assert_eq!(report.versions.library_marker, Some(OP_SCHEMA));
    assert_eq!(report.versions.op_schema, OP_SCHEMA);
    assert_eq!(report.versions.db_migration, max_migration(&pool).await);
}

#[tokio::test]
async fn missing_service_is_disabled_with_zero_counts() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;

    let report = collect(&pool, None).await.unwrap();
    assert!(!report.sync.enabled);
    assert_eq!(report.sync.state, SyncState::Disabled);
    assert!(report.sync.folder.is_none());
    assert_eq!(report.sync.counts.pending_local, 0);
    assert_eq!(report.sync.counts.issues, 0);
    assert!(report.hash_failed.is_empty());
    assert!(report.open_conflicts.is_empty());
    assert_eq!(report.versions.op_schema, OP_SCHEMA);
    assert!(report.versions.db_migration > 0);
}

#[tokio::test]
async fn a_missing_or_unreadable_marker_is_null_without_failing() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    let status = enabled_status(&folder);

    // No library.json yet.
    let report = collect(&pool, Some(&status)).await.unwrap();
    assert!(report.versions.library_marker.is_none());

    // Present but not valid JSON.
    fs::create_dir_all(folder.join("TuxBooks")).unwrap();
    fs::write(folder.join("TuxBooks/library.json"), b"{not json").unwrap();
    let report = collect(&pool, Some(&status)).await.unwrap();
    assert!(report.versions.library_marker.is_none());
}

#[tokio::test]
async fn lists_are_capped_at_the_limit_with_the_newest_kept() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    let status = enabled_status(&folder);

    let mut newest_id = 0;
    for index in 0..(LIST_LIMIT + 3) {
        newest_id = add_failed_book(
            &pool,
            &format!("Book {index}"),
            &format!("/books/{index}.epub"),
            1,
        )
        .await;
    }
    for index in 0..(LIST_LIMIT + 3) {
        sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
            .bind(format!("loser-{index}"))
            .bind(format!("winner-{index}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    for index in 0..(LIST_LIMIT + 3) {
        sqlx::query(
            "INSERT INTO sync_conflicts
                (kind, entity_uid, field, winner_json, loser_json,
                 winner_wall, winner_count, winner_dev,
                 loser_wall, loser_count, loser_dev, created_at)
             VALUES ('annotation', ?1, 'note', 'null', 'null', 2, 0, 'aaa',
                     1, 0, 'bbb', '2026-10-31T09:00:00.000Z')",
        )
        .bind(format!("entity-{index}"))
        .execute(&pool)
        .await
        .unwrap();
    }

    let report = collect(&pool, Some(&status)).await.unwrap();
    assert_eq!(report.hash_failed.len(), LIST_LIMIT as usize);
    assert_eq!(report.open_conflicts.len(), LIST_LIMIT as usize);
    assert_eq!(report.recent_merges.books.len(), LIST_LIMIT as usize);
    // Hash failures come newest first, so the newest failing book survives
    // the cap and the oldest is dropped.
    assert_eq!(report.hash_failed[0].book_id, newest_id);
    assert!(!report.hash_failed.iter().any(|book| book.title == "Book 0"));
}

#[tokio::test]
async fn an_error_status_keeps_the_error_and_a_relative_folder_has_no_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let mut status = enabled_status(Path::new("relative/path"));
    status.state = SyncState::Error;
    status.last_error = Some("sync folder is unavailable".into());

    let report = collect(&pool, Some(&status)).await.unwrap();
    assert_eq!(report.sync.state, SyncState::Error);
    assert_eq!(
        report.sync.last_error.as_deref(),
        Some("sync folder is unavailable")
    );
    assert!(report.versions.library_marker.is_none());
}

async fn max_migration(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap()
}
