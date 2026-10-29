//! Durable-book upgrade seam (ADR 0014, ticket tuxbooks-ip6.1).
//!
//! These tests build a pre-change database with a migrator that stops at
//! migration 0016, seed the state a real user would have, then open it through
//! the normal startup path. The assertions go through the repository API, not
//! private tables, except where the ticket names a durable record explicitly.

use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tuxbooks_lib::db::connection::{init_pool, init_pool_recovering};
use tuxbooks_lib::domain::NewBook;
use tuxbooks_lib::error::AppError;
use tuxbooks_lib::repository::{annotations, books, collections, migration, reading_progress};
use tuxbooks_lib::services::hash_backfill;

const SHARED_UID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECOVERED_UID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WAITING_UID: &str = "cccccccccccccccccccccccccccccccc";

/// A copy of the migration set up to and including `max_version`, so a test
/// can create the schema an earlier release shipped.
async fn migrator_through(dir: &Path, max_version: u64) -> sqlx::migrate::Migrator {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let target = dir.join(format!("migrations-{max_version}"));
    std::fs::create_dir_all(&target).unwrap();
    for entry in std::fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = name
            .strip_prefix('0')
            .and_then(|rest| rest.split('_').next())
            .and_then(|digits| digits.parse::<u64>().ok())
        else {
            continue;
        };
        if version <= max_version {
            std::fs::copy(entry.path(), target.join(&name)).unwrap();
        }
    }
    sqlx::migrate::Migrator::new(target).await.unwrap()
}

async fn pre_change_migrator(dir: &Path) -> sqlx::migrate::Migrator {
    migrator_through(dir, 16).await
}

async fn pre_change_pool(dir: &Path) -> (PathBuf, SqlitePool) {
    let db_path = dir.join("tuxbooks.db");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    pre_change_migrator(dir).await.run(&pool).await.unwrap();
    (db_path, pool)
}

async fn seed_user_library(pool: &SqlitePool) {
    sqlx::query(
        r#"
        INSERT INTO books (id, path, title, author, last_opened_at, file_size, file_mtime, modified_at)
        VALUES
            (1, '/library/alpha.epub', 'Alpha Override', 'Ada', '2026-01-02T00:00:00.000Z', 11, 101, '2026-01-03T00:00:00.000Z'),
            (2, '/library/beta.epub', 'Beta', 'Bob', '2026-01-05T00:00:00.000Z', 22, 202, '2026-01-04T00:00:00.000Z'),
            (3, '/library/gamma.epub', 'Gamma', 'Cleo', NULL, 33, 303, '2026-01-01T00:00:00.000Z')
        "#,
    )
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        r#"
        INSERT INTO reading_progress (book_id, chapter_href, progress_percent)
        VALUES (1, 'chapter-1.xhtml', 25.0)
        "#,
    )
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        r#"
        INSERT INTO annotations (book_id, kind, cfi, text, note)
        VALUES (1, 'highlight', 'epubcfi(/6/2!/4/2)', 'a passage', 'kept')
        "#,
    )
    .execute(pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO collections (id, name) VALUES (1, 'Favorites')")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO book_collections (book_id, collection_id) VALUES (1, 1)")
        .execute(pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO book_metadata_overrides (book_id, title) VALUES (1, 'Alpha Override')",
    )
    .execute(pool)
    .await
    .unwrap();

    // Two file rows already share one sync identity; the third is unbound.
    for (book_id, hash, size, mtime) in [
        (1, "1".repeat(64), 11_i64, 101_i64),
        (2, "2".repeat(64), 22, 202),
    ] {
        sqlx::query(
            r#"
            INSERT INTO sync_book_bindings
                (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(book_id)
        .bind(SHARED_UID)
        .bind(hash)
        .bind(size)
        .bind(mtime)
        .execute(pool)
        .await
        .unwrap();
    }

    // Mirror state for a book that was unwatched before the upgrade, with
    // metadata; and one whose metadata never arrived.
    for (uid, with_metadata) in [(RECOVERED_UID, true), (WAITING_UID, false)] {
        sqlx::query(
            "INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
             VALUES ('progress', ?1, ?1)",
        )
        .bind(uid)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
             VALUES ('annotation', ?1, ?1)",
        )
        .bind(uid)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES ('progress', ?1, 'progress_percent', '42.5', 1, 1, 'device')",
        )
        .bind(uid)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES ('opened', ?1, 'last_opened_at',
                     '\"2025-12-24T00:00:00.000Z\"', 1, 1, 'device')",
        )
        .bind(uid)
        .execute(pool)
        .await
        .unwrap();
        if with_metadata {
            for (field, value) in [
                ("title", "\"Recovered from sync\""),
                ("authors", "[\"Ada\"]"),
                ("publisher", "\"Mirror Press\""),
            ] {
                sqlx::query(
                    "INSERT INTO sync_state_fields
                        (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
                     VALUES ('metadata', ?1, ?2, ?3, 1, 1, 'device')",
                )
                .bind(uid)
                .bind(field)
                .bind(value)
                .execute(pool)
                .await
                .unwrap();
            }
        }
    }
}

fn backup_files(dir: &Path) -> Vec<PathBuf> {
    let mut backups: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().contains(".pre-migration-"))
        })
        .collect();
    backups.sort();
    backups
}

async fn count_backup_books(path: &Path) -> i64 {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(path).read_only(true))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;
    count
}

#[tokio::test]
async fn upgrade_preserves_user_state_assigns_identity_and_writes_a_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let (db_path, fixture) = pre_change_pool(tmp.path()).await;
    seed_user_library(&fixture).await;
    fixture.close().await;

    let (pool, recovery) = init_pool_recovering(&db_path).await.unwrap();
    assert!(recovery.is_none(), "a healthy upgrade is not quarantine");

    // The pre-change backup is consistent and still has the old schema.
    let backups = backup_files(tmp.path());
    assert_eq!(backups.len(), 1, "one backup per upgrade: {backups:?}");
    assert_eq!(count_backup_books(&backups[0]).await, 3);

    // Everything the user sees survives through the repository API. The two
    // rows that already shared one sync identity now show as one library
    // entry (ADR 0014 D7), so three file rows mean two books.
    let listed = books::list_books(&pool).await.unwrap();
    assert_eq!(listed.len(), 2);
    let alpha = books::get_book_by_path(&pool, "/library/alpha.epub")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(alpha.title, "Alpha Override");
    let book_id = alpha.id;
    // The durable record keeps the latest last-opened across the copies.
    assert_eq!(
        alpha.last_opened_at.unwrap().to_rfc3339(),
        "2026-01-05T00:00:00+00:00"
    );
    let progress = reading_progress::get_progress(&pool, book_id)
        .await
        .unwrap();
    assert_eq!(progress.unwrap().progress_percent, Some(25.0));
    assert_eq!(
        annotations::list_annotations(&pool, book_id)
            .await
            .unwrap()
            .len(),
        1
    );
    let shelves = collections::list_collection_summaries(&pool).await.unwrap();
    assert_eq!(shelves[0].book_ids, vec![book_id]);
    let beta = books::get_book_by_path(&pool, "/library/beta.epub")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(beta.id, book_id, "both copies resolve to the same book");

    // File rows share the durable book their sync binding already named.
    let alpha_uid = alpha.book_uid.clone().expect("alpha has a bookUid");
    assert_eq!(alpha_uid, SHARED_UID);
    assert_eq!(beta.book_uid.as_deref(), Some(SHARED_UID));
    let gamma = books::get_book_by_path(&pool, "/library/gamma.epub")
        .await
        .unwrap()
        .unwrap();
    let gamma_uid = gamma.book_uid.expect("an unbound row gets a uuid");
    assert_eq!(gamma_uid.len(), 32);
    assert_ne!(gamma_uid, SHARED_UID);

    // One durable record for the shared identity, carrying the newest
    // metadata and the unioned annotation count.
    let (title, annotations, state): (String, i64, String) = sqlx::query_as(
        "SELECT title, annotation_count, metadata_state FROM book_records WHERE uid = ?1",
    )
    .bind(SHARED_UID)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        title, "Beta",
        "most recently modified row supplies metadata"
    );
    assert_eq!(annotations, 1);
    assert_eq!(state, "available");

    // The mirror-only identity is recovered; missing metadata is labelled.
    let (title, progress, state): (Option<String>, Option<f64>, String) = sqlx::query_as(
        "SELECT title, progress_percent, metadata_state FROM book_records WHERE uid = ?1",
    )
    .bind(RECOVERED_UID)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(title.as_deref(), Some("Recovered from sync"));
    assert_eq!(progress, Some(42.5));
    assert_eq!(state, "available");
    let state: String =
        sqlx::query_scalar("SELECT metadata_state FROM book_records WHERE uid = ?1")
            .bind(WAITING_UID)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(state, "waiting_for_file");

    // Bound rows are already hashed; the unbound one is queued durably.
    let hash_states: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, hash_state FROM books ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        hash_states,
        vec![
            (1, "hashed".to_string()),
            (2, "hashed".to_string()),
            (3, "pending".to_string())
        ]
    );

    // The pre-existing duplicate is visible, not silently collapsed.
    let issues = migration::list_open(&pool).await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "duplicate_identity"
            && issue.book_uid.as_deref() == Some(SHARED_UID)),
        "expected a duplicate identity issue: {issues:?}"
    );
}

#[tokio::test]
async fn the_0018_upgrade_unions_duplicate_progress_and_annotations() {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let fixture = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    migrator_through(tmp.path(), 17)
        .await
        .run(&fixture)
        .await
        .unwrap();

    // Two file rows already share one durable identity, each carrying its own
    // state. This is the shape T1 could identify but not merge.
    sqlx::query(
        r#"
        INSERT INTO books (id, book_uid, path, title)
        VALUES
            (1, ?1, '/library/alpha.epub', 'Alpha'),
            (2, ?1, '/library/beta.epub', 'Beta')
        "#,
    )
    .bind(SHARED_UID)
    .execute(&fixture)
    .await
    .unwrap();
    for (book_id, percent, updated_at) in [
        (1, 10.0, "2026-01-01T00:00:00.000Z"),
        (2, 80.0, "2026-02-01T00:00:00.000Z"),
    ] {
        sqlx::query(
            "INSERT INTO reading_progress (book_id, chapter_href, progress_percent, updated_at)
             VALUES (?1, 'chapter-1.xhtml', ?2, ?3)",
        )
        .bind(book_id)
        .bind(percent)
        .bind(updated_at)
        .execute(&fixture)
        .await
        .unwrap();
    }
    for (book_id, cfi) in [
        (1, "epubcfi(/6/2!/4/2,/1:0,/1:8)"),
        (2, "epubcfi(/6/4!/4/2,/1:0,/1:8)"),
    ] {
        sqlx::query(
            "INSERT INTO annotations (book_id, kind, cfi, text)
             VALUES (?1, 'highlight', ?2, 'passage')",
        )
        .bind(book_id)
        .bind(cfi)
        .execute(&fixture)
        .await
        .unwrap();
    }
    fixture.close().await;

    let (pool, recovery) = init_pool_recovering(&db_path).await.unwrap();
    assert!(recovery.is_none());

    let book = books::get_book_by_path(&pool, "/library/alpha.epub")
        .await
        .unwrap()
        .expect("durable book");
    // Both copies resolve to one book.
    assert_eq!(
        book.id,
        books::get_book_by_path(&pool, "/library/beta.epub")
            .await
            .unwrap()
            .unwrap()
            .id
    );

    // Newest progress wins; every annotation is kept.
    let progress = reading_progress::get_progress(&pool, book.id)
        .await
        .unwrap()
        .expect("merged progress");
    assert_eq!(progress.progress_percent, Some(80.0));
    assert_eq!(
        annotations::list_annotations(&pool, book.id)
            .await
            .unwrap()
            .len(),
        2,
        "annotations from both copies are unioned"
    );

    let issues = migration::list_open(&pool).await.unwrap();
    assert!(
        issues
            .iter()
            .any(|issue| issue.kind == "duplicate_state_merged"
                && issue.issue_key == format!("duplicate-progress:{SHARED_UID}")),
        "the merge is visible: {issues:?}"
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.kind == "duplicate_state_merged"
                && issue.issue_key == format!("duplicate-annotations:{SHARED_UID}")),
        "the annotation union is visible: {issues:?}"
    );

    // The durable record survives the last file row.
    assert!(books::delete_book(&pool, book.id).await.unwrap());
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(SHARED_UID)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept, 1);
    assert!(reading_progress::get_progress(&pool, book.id)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn a_failed_migration_fails_closed_and_keeps_the_original_database() {
    let tmp = tempfile::tempdir().unwrap();
    let (db_path, fixture) = pre_change_pool(tmp.path()).await;
    seed_user_library(&fixture).await;
    // Force 0017 to fail after the backup has been written.
    sqlx::query("CREATE TABLE book_records (uid TEXT PRIMARY KEY)")
        .execute(&fixture)
        .await
        .unwrap();
    fixture.close().await;

    let error = init_pool_recovering(&db_path).await.unwrap_err();
    assert!(
        matches!(error, AppError::Migration(_)),
        "a migration failure is reported as such, got {error:?}"
    );

    // The original database is still there, unquarantined, with its data.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .read_only(true),
        )
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 3);
    let blocker: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'book_records'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(blocker, 1, "the original schema was left in place");
    pool.close().await;

    assert!(
        std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".corrupt-")),
        "a failed migration is never quarantined"
    );
    let backups = backup_files(tmp.path());
    assert_eq!(backups.len(), 1, "the backup was taken before the failure");
    assert_eq!(count_backup_books(&backups[0]).await, 3);
}

fn sample(path: &str, title: &str, file_size: i64) -> NewBook {
    NewBook {
        path: path.into(),
        title: title.into(),
        subtitle: None,
        author: None,
        authors: Vec::new(),
        subjects: Vec::new(),
        publisher: None,
        language: None,
        isbn: None,
        description: None,
        cover_path: None,
        publication_date: None,
        series: None,
        series_index: None,
        file_size,
        file_mtime: 1_700_000_000,
    }
}

#[tokio::test]
async fn background_hash_backfill_is_resumable_and_collapses_duplicate_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("tuxbooks.db")).await.unwrap();

    let first_path = tmp.path().join("first.epub");
    let second_path = tmp.path().join("second.epub");
    let other_path = tmp.path().join("other.epub");
    std::fs::write(&first_path, b"the same exact bytes").unwrap();
    std::fs::write(&second_path, b"the same exact bytes").unwrap();
    std::fs::write(&other_path, b"other bytes").unwrap();

    let _first = books::insert_book(&pool, &sample(&first_path.to_string_lossy(), "First", 21))
        .await
        .unwrap();
    let _second = books::insert_book(&pool, &sample(&second_path.to_string_lossy(), "Second", 21))
        .await
        .unwrap();
    let other = books::insert_book(&pool, &sample(&other_path.to_string_lossy(), "Other", 11))
        .await
        .unwrap();

    let processed = hash_backfill::run_until_idle(&pool).await.unwrap();
    assert_eq!(processed, 3);
    let status = hash_backfill::status(&pool).await.unwrap();
    assert_eq!(status.total, 3);
    assert_eq!(status.hashed, 3);
    assert_eq!(status.pending, 0);
    assert_eq!(status.failed, 0);

    let uids: Vec<(i64, String)> = sqlx::query_as("SELECT id, book_uid FROM books ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    let first_uid = &uids[0].1;
    assert_eq!(&uids[1].1, first_uid, "equal bytes share one durable book");
    assert_ne!(&uids[2].1, first_uid);
    let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(first_uid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(records, 1);
    let issues = migration::list_open(&pool).await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "identity_merged"),
        "a collapse is recorded as a visible issue"
    );

    // Deleting file rows ends membership only; the durable record survives
    // the last one (ticket .2).
    let first_book = books::get_book_by_path(&pool, &first_path.to_string_lossy())
        .await
        .unwrap()
        .expect("first copy");
    let second_book = books::get_book_by_path(&pool, &second_path.to_string_lossy())
        .await
        .unwrap()
        .expect("second copy");
    assert_eq!(first_book.id, second_book.id, "equal bytes share one book");
    let first_file = books::find_file_id_by_path(&pool, &first_path.to_string_lossy())
        .await
        .unwrap()
        .expect("first file row");
    assert!(
        books::delete_file_row(&pool, first_file).await.unwrap(),
        "the first location is removed"
    );
    let still_there: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(first_uid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(still_there, 1, "another file still carries the book");
    let second_file = books::find_file_id_by_path(&pool, &second_path.to_string_lossy())
        .await
        .unwrap()
        .expect("second file row");
    assert!(books::delete_file_row(&pool, second_file).await.unwrap());
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE uid = ?1")
        .bind(first_uid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept, 1, "removing the last file keeps the durable book");

    // Resume: a pending row is picked up by the next pass, exactly as after
    // a restart. `other` remains hashed and is never re-read.
    sqlx::query("UPDATE books SET hash_state = 'pending' WHERE id = ?1")
        .bind(other)
        .execute(&pool)
        .await
        .unwrap();
    let processed = hash_backfill::run_until_idle(&pool).await.unwrap();
    assert_eq!(processed, 1);
    let state: String = sqlx::query_scalar("SELECT hash_state FROM books WHERE id = ?1")
        .bind(other)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "hashed");
}

#[tokio::test]
async fn an_unreadable_file_becomes_a_visible_hash_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("tuxbooks.db")).await.unwrap();

    let missing = tmp.path().join("vanished.epub");
    let id = books::insert_book(&pool, &sample(&missing.to_string_lossy(), "Gone", 4))
        .await
        .unwrap();

    hash_backfill::run_until_idle(&pool).await.unwrap();

    let state: String = sqlx::query_scalar("SELECT hash_state FROM books WHERE id = ?1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "failed");
    let issues = migration::list_open(&pool).await.unwrap();
    assert!(
        issues.iter().any(|issue| issue.kind == "hash_failed"),
        "a failed hash is visible: {issues:?}"
    );
}
