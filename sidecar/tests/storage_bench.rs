//! Benchmark for the storage report's per-location aggregate (data-management
//! spec). Run with:
//!
//!   cargo test --manifest-path sidecar/Cargo.toml --test storage_bench -- --ignored --nocapture
//!
//! It seeds a temp database at several (locations, books) scales and times
//! `storage_stats`, the query the Data tab runs on open. It asserts nothing
//! beyond the location count; the printed numbers are the output.

use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::repository::storage::storage_stats;

/// How the seeded watched locations relate to each other.
#[derive(Clone, Copy, Debug)]
enum Layout {
    /// Every location an immediate child of one root, equal depth.
    Siblings,
    /// Half parents, half their children, so many locations prefix others and
    /// the query's longest-prefix (NOT EXISTS) path is exercised.
    Nested,
}

fn location_paths(locations: usize, layout: Layout) -> Vec<String> {
    (0..locations)
        .map(|index| match layout {
            Layout::Siblings => format!("/library/root-{index:05}"),
            Layout::Nested if index % 2 == 0 => format!("/library/g{:05}", index / 2),
            Layout::Nested => format!("/library/g{:05}/sub", index / 2),
        })
        .collect()
}

async fn seed(pool: &SqlitePool, locations: usize, books: usize, layout: Layout) -> Duration {
    let started = Instant::now();
    let paths = location_paths(locations, layout);
    let mut tx = pool.begin().await.unwrap();
    for path in &paths {
        sqlx::query("INSERT INTO library_locations (path) VALUES (?1)")
            .bind(path)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for index in 0..books {
        let location = &paths[index % locations];
        let path = format!("{location}/book-{index:06}.epub");
        sqlx::query("INSERT INTO books (path, title, file_size) VALUES (?1, ?2, ?3)")
            .bind(&path)
            .bind(format!("Book {index}"))
            .bind(1_000_000_i64)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    started.elapsed()
}

async fn measure(locations: usize, books: usize, layout: Layout) -> (Duration, Duration) {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("tuxbooks.db")).await.unwrap();
    let seed = seed(&pool, locations, books, layout).await;
    let started = Instant::now();
    let stats = storage_stats(&pool).await.unwrap();
    let query = started.elapsed();
    assert_eq!(stats.locations.len(), locations);
    (seed, query)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "benchmark; run with --ignored --nocapture"]
async fn storage_stats_scaling() {
    for layout in [Layout::Siblings, Layout::Nested] {
        for (locations, books) in [
            (10usize, 20_000usize),
            (100, 20_000),
            (500, 20_000),
            (1_000, 20_000),
            (1_000, 50_000),
        ] {
            let (seed, query) = measure(locations, books, layout).await;
            println!(
                "{layout:?}: locations={locations:>5} books={books:>6} seed={:>8.1} ms  storage_stats={:>9.1} ms",
                seed.as_secs_f64() * 1_000.0,
                query.as_secs_f64() * 1_000.0
            );
        }
    }
}
