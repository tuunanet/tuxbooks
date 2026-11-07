use crate::common::*;

/// A copy of the migration set up to and including `max_version`, so an
/// upgrade test can seed the schema the previous release shipped.
pub async fn migrator_through(dir: &Path, max_version: u64) -> sqlx::migrate::Migrator {
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

#[tokio::test(flavor = "multi_thread")]
async fn upgrade_preserves_mirror_clocks_and_does_not_rebaseline() {
    const OLD_UID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let sync_dir = tempfile::tempdir().unwrap();
    let a = device().await;
    connect(&a, sync_dir.path()).await;
    let library_id = a.service.status().await.unwrap().library_id.unwrap();

    // A database created by the previous release, with mirror state and
    // clocks that must survive the upgrade untouched.
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let old = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    migrator_through(tmp.path(), 22)
        .await
        .run(&old)
        .await
        .unwrap();
    sqlx::query("INSERT INTO book_records (uid, title) VALUES (?1, 'Upgraded')")
        .bind(OLD_UID)
        .execute(&old)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sync_state_entities
            (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device)
         VALUES ('progress', ?1, ?1, 111, 2, 'previous-device')",
    )
    .bind(OLD_UID)
    .execute(&old)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES ('progress', ?1, 'progress_percent', '42.5', 111, 2, 'previous-device')",
    )
    .bind(OLD_UID)
    .execute(&old)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
        .bind("b".repeat(32))
        .bind(OLD_UID)
        .execute(&old)
        .await
        .unwrap();
    for (key, value) in [
        ("baseline_done", "1".to_string()),
        ("enabled", "1".to_string()),
        ("library_id", library_id),
        (
            "folder_path",
            sync_dir.path().to_string_lossy().into_owned(),
        ),
    ] {
        sqlx::query("INSERT INTO sync_meta (key, value) VALUES (?1, ?2)")
            .bind(key)
            .bind(value)
            .execute(&old)
            .await
            .unwrap();
    }
    old.close().await;

    let upgraded = init_pool(&db_path).await.unwrap();
    let clock: (i64, i64, String, String) = sqlx::query_as(
        "SELECT hlc_wall, hlc_counter, hlc_device, value_json
         FROM sync_state_fields WHERE kind = 'progress' AND entity_uid = ?1",
    )
    .bind(OLD_UID)
    .fetch_one(&upgraded)
    .await
    .unwrap();
    assert_eq!(clock, (111, 2, "previous-device".into(), "42.5".into()));
    let baseline: String =
        sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'baseline_done'")
            .fetch_one(&upgraded)
            .await
            .unwrap();
    assert_eq!(baseline, "1", "the upgrade must not force a re-baseline");
    let merges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_merges")
        .fetch_one(&upgraded)
        .await
        .unwrap();
    assert_eq!(merges, 1, "merged identities survive the upgrade");
    let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
        .fetch_one(&upgraded)
        .await
        .unwrap();
    assert_eq!(dirty, 0, "the migration does not touch local state");

    // An older remote write must lose to the preserved clock.
    let root = sync_dir.path().join("TuxBooks");
    let manual_device = "c".repeat(32);
    let manual_dir = root.join("ops").join(&manual_device);
    std::fs::create_dir_all(&manual_dir).unwrap();
    let op = Op {
        schema: OP_SCHEMA,
        op_id: "d".repeat(32),
        device_id: manual_device.clone(),
        hlc: Hlc {
            wall: 50,
            counter: 0,
            device: manual_device.clone(),
        },
        kind: EntityKind::Progress,
        entity_uid: OLD_UID.into(),
        book_uid: Some(OLD_UID.into()),
        deleted: false,
        restore: false,
        fields: serde_json::json!({ "progress_percent": 5.0 })
            .as_object()
            .cloned()
            .unwrap(),
        prior: None,
        created_at: "2026-10-01T00:00:00.000Z".into(),
    };
    std::fs::write(
        manual_dir.join("00000000000000000050.json"),
        serde_json::to_vec(&op).unwrap(),
    )
    .unwrap();

    let events = EventEmitter::new(|_name: &'static str, _payload: Value| {});
    let service = SyncService::new(upgraded.clone(), &db_path, events)
        .await
        .unwrap();
    service.run_pass().await.unwrap();

    let after: (i64, i64, String, String) = sqlx::query_as(
        "SELECT hlc_wall, hlc_counter, hlc_device, value_json
         FROM sync_state_fields WHERE kind = 'progress' AND entity_uid = ?1",
    )
    .bind(OLD_UID)
    .fetch_one(&upgraded)
    .await
    .unwrap();
    assert_eq!(after, clock, "the preserved clock still wins after a pass");
    let baseline: String =
        sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'baseline_done'")
            .fetch_one(&upgraded)
            .await
            .unwrap();
    assert_eq!(baseline, "1", "running the engine does not re-baseline");
}

/// Migration 0029 heals the id-0 book_records row a sync-replayed restore
/// created on the affected install (tuxbooks-kcm): rows with id <= 0 re-id
/// to MAX(id)+1, the row keeps its identity and state, and a healthy row is
/// untouched. Built with the migrator-through pattern (tuxbooks-qsj), so
/// the next data-heal migration can copy this test as-is.
#[tokio::test(flavor = "multi_thread")]
async fn migration_0029_reids_a_zero_book_record_row() {
    const POISONED_UID: &str = "e7717c6fb2b0a9c7d1e4a5b6c8d9e0f1";
    const HEALTHY_UID: &str = "f8828d7fc3c1b0d8e2f5b6c7d9e0f1a2";

    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let old = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    migrator_through(tmp.path(), 28)
        .await
        .run(&old)
        .await
        .unwrap();

    // The poisoned row as the affected install held it, next to a healthy
    // row the heal must leave alone.
    sqlx::query(
        "INSERT INTO book_records
            (id, uid, created_at, title, progress_percent, annotation_count, metadata_state)
         VALUES (0, ?1, '2026-10-01T00:00:00.000Z', 'Poisoned Restore', 37.5, 2, 'available')",
    )
    .bind(POISONED_UID)
    .execute(&old)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO book_records
            (id, uid, created_at, title, annotation_count, metadata_state)
         VALUES (7, ?1, '2026-09-01T00:00:00.000Z', 'Healthy Neighbor', 0, 'available')",
    )
    .bind(HEALTHY_UID)
    .execute(&old)
    .await
    .unwrap();
    old.close().await;

    // Re-opening runs the full migration set, which applies 0029.
    let upgraded = init_pool(&db_path).await.unwrap();

    // The poisoned row now carries MAX(id)+1 and nothing else moved.
    let healed: (i64, String, String, Option<f64>, i64) = sqlx::query_as(
        "SELECT id, created_at, title, progress_percent, annotation_count
         FROM book_records WHERE uid = ?1",
    )
    .bind(POISONED_UID)
    .fetch_one(&upgraded)
    .await
    .unwrap();
    assert_eq!(
        healed,
        (
            8,
            "2026-10-01T00:00:00.000Z".into(),
            "Poisoned Restore".into(),
            Some(37.5),
            2
        ),
        "the id-0 row re-ids to MAX+1 and keeps its identity"
    );

    let healthy: (i64, String, String) =
        sqlx::query_as("SELECT id, created_at, title FROM book_records WHERE uid = ?1")
            .bind(HEALTHY_UID)
            .fetch_one(&upgraded)
            .await
            .unwrap();
    assert_eq!(
        healthy,
        (
            7,
            "2026-09-01T00:00:00.000Z".into(),
            "Healthy Neighbor".into()
        ),
        "the healthy row is untouched"
    );

    let zeros: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE id <= 0")
        .fetch_one(&upgraded)
        .await
        .unwrap();
    assert_eq!(zeros, 0, "no rowid 0 survives the heal");
}

/// Migration 0030 stamps pending dirty rows that predate it. changed_at is
/// the write time the old triggers recorded, so a month-old offline edit
/// keeps its month-old clock and still loses to writes that happened while
/// it was offline (ADR 0017 D3). Built with the migrator-through pattern.
#[tokio::test(flavor = "multi_thread")]
async fn migration_0030_dates_legacy_dirty_rows_by_when_they_were_written() {
    const OLD_UID: &str = "cccccccccccccccccccccccccccccccc";
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let old = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    migrator_through(tmp.path(), 29)
        .await
        .run(&old)
        .await
        .unwrap();
    sqlx::query("INSERT INTO book_records (uid, title) VALUES (?1, 'Offline')")
        .bind(OLD_UID)
        .execute(&old)
        .await
        .unwrap();
    // A pending edit written at a known moment, never drained.
    sqlx::query(
        "INSERT INTO sync_dirty (kind, entity_key, op, old_json, changed_at)
         VALUES ('progress', ?1, 'upsert', '{}', '2026-10-01T12:00:00.000Z')",
    )
    .bind(OLD_UID)
    .execute(&old)
    .await
    .unwrap();
    old.close().await;

    let upgraded = init_pool(&db_path).await.unwrap();
    let (wall, counter): (i64, i64) =
        sqlx::query_as("SELECT hlc_wall, hlc_counter FROM sync_dirty WHERE entity_key = ?1")
            .bind(OLD_UID)
            .fetch_one(&upgraded)
            .await
            .unwrap();
    // Dated from changed_at (the write), not from the upgrade run.
    assert_eq!(wall, 1_790_856_000_000, "the write time is the clock");
    assert_eq!(counter, 1, "the first legacy slot");
    let stored: String = sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = 'hlc'")
        .fetch_one(&upgraded)
        .await
        .unwrap();
    assert_eq!(
        stored, "1790856000000:1",
        "the clock settled past the batch"
    );

    // Later mints continue after the legacy slots and never collide with one.
    let first = clock::next_hlc(&upgraded).await.unwrap();
    let second = clock::next_hlc(&upgraded).await.unwrap();
    assert!(
        second > first,
        "mints stay ordered: {second:?} after {first:?}"
    );
    assert_ne!((first.wall, first.counter as i64), (wall, counter));
    assert_ne!((second.wall, second.counter as i64), (wall, counter));
}
