//! Startup self-heal (data-management spec): a broken database is moved aside
//! under a timestamped quarantine name, never deleted, and a fresh migrated
//! database takes its place. A healthy database is left alone.

use std::fs;

use tuxbooks_lib::db::connection::init_pool_recovering;
use tuxbooks_lib::repository::books;

const CORRUPT_BYTES: &[u8] = b"this is not a sqlite database, just random bytes\x00\x01\x02";

#[tokio::test]
async fn corrupt_database_is_quarantined_and_replaced_with_a_working_one() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let db_path = tmp.path().join("tuxbooks.db");
    fs::write(&db_path, CORRUPT_BYTES)?;

    let (pool, recovery) = init_pool_recovering(&db_path).await?;

    let recovery = recovery.expect("a broken database must be reported");
    assert_eq!(recovery.from, db_path.to_string_lossy());
    let quarantined = std::path::PathBuf::from(&recovery.to);
    let name = quarantined
        .file_name()
        .expect("quarantine file name")
        .to_string_lossy()
        .into_owned();
    assert!(
        name.starts_with("tuxbooks.db.corrupt-"),
        "quarantine name was {name}"
    );
    assert!(quarantined.exists(), "the broken database must be kept");
    assert_eq!(
        fs::read(&quarantined)?,
        CORRUPT_BYTES,
        "the broken file is moved, never rewritten"
    );

    // The replacement is a real, migrated, usable database.
    assert_eq!(books::count_books(&pool).await?, 0);
    let migrations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await?;
    assert!(migrations > 0, "migrations must run on the fresh database");

    Ok(())
}

#[tokio::test]
async fn healthy_database_is_not_quarantined() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let db_path = tmp.path().join("tuxbooks.db");

    let (pool, recovery) = init_pool_recovering(&db_path).await?;
    assert!(recovery.is_none(), "a fresh database is healthy");

    let book = tuxbooks_lib::domain::NewBook {
        path: "/library/kept.epub".into(),
        title: "Kept".into(),
        subtitle: None,
        author: Some("Author".into()),
        authors: vec!["Author".into()],
        subjects: Vec::new(),
        publisher: None,
        language: Some("en".into()),
        isbn: None,
        description: None,
        cover_path: None,
        publication_date: None,
        series: None,
        series_index: None,
        file_size: 100,
        file_mtime: 1_700_000_000,
    };
    books::insert_book(&pool, &book).await?;
    drop(pool);

    let (pool, recovery) = init_pool_recovering(&db_path).await?;
    assert!(
        recovery.is_none(),
        "a healthy database is never quarantined"
    );
    assert_eq!(books::count_books(&pool).await?, 1, "data survives reopen");

    for entry in fs::read_dir(tmp.path())? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        assert!(
            !name.contains(".corrupt-"),
            "healthy database left a quarantine file: {name}"
        );
    }

    Ok(())
}
