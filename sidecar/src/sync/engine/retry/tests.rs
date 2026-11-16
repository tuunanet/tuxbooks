use super::{retry_key, retry_key_i64, AppError, SyncIssueRef};
use crate::db::connection::init_pool;
use crate::rpc::EventEmitter;
use crate::sync::clock::{set_meta, META_FOLDER};
use crate::sync::engine::SyncService;

async fn folder_service(dir: &std::path::Path) -> SyncService {
    let pool = init_pool(&dir.join("t.db")).await.unwrap();
    set_meta(&pool, META_FOLDER, dir.to_str().unwrap())
        .await
        .unwrap();
    SyncService::new(pool, &dir.join("t.db"), EventEmitter::new(|_, _| {}))
        .await
        .unwrap()
}

/// What one retry came back as, as text a prefix-drift assertion searches.
fn outcome(result: Result<bool, AppError>) -> String {
    match result {
        Ok(cleared) => format!("cleared: {cleared}"),
        Err(err) => err.to_string(),
    }
}

#[tokio::test]
async fn every_retry_prefix_reads_the_key_the_record_sites_write() {
    let tmp = tempfile::tempdir().unwrap();
    let service = folder_service(tmp.path()).await;

    // The non-hash arms parse only after the folder gate. A key with no
    // matching prefix must come back as the "cannot be retried" report,
    // which proves this fixture reached the parser at all.
    let report = outcome(
        service
            .retry_locked(SyncIssueRef {
                kind: "projection_failed",
                issue_key: "wrong-prefix:1",
                file_name: None,
            })
            .await,
    );
    assert!(
        report.contains("cannot be retried"),
        "the fixture never reached key parsing: {report}"
    );

    // Keys exactly as the record sites build them. When an arm's prefix
    // literal drifts from the key its writer builds, that arm reports the
    // key as unreadable and this goes red.
    let cases = [
        ("hash_failed", "hash-failed:7"),
        ("projection_failed", "project-book:999999"),
        ("identity_failed", "identity:999999"),
        (
            "reprojection_failed",
            "reproject:00000000000000000000000000000000",
        ),
        (
            "book_lifecycle_failed",
            "book-lifecycle:00000000000000000000000000000000",
        ),
        ("operation_retrying", "file:ops/gone.json"),
        ("cover_missing", "cover-missing:0123456789abcdef.png"),
        ("cover_blob_failed", "cover:0123456789abcdef.png"),
    ];
    for (kind, key) in cases {
        let report = outcome(
            service
                .retry_locked(SyncIssueRef {
                    kind,
                    issue_key: key,
                    file_name: None,
                })
                .await,
        );
        assert!(
            !report.contains("cannot be retried"),
            "the {kind} arm's prefix no longer reads {key}: {report}"
        );
    }
}

fn issue(issue_key: &'static str) -> SyncIssueRef<'static> {
    SyncIssueRef {
        kind: "projection_failed",
        issue_key,
        file_name: None,
    }
}

/// The retry wrappers restate the contract the old per-site helpers
/// enforced (prefix present, non-empty, numeric where an id is needed),
/// so these pin that contract at the shared seam.
#[test]
fn retry_key_reads_the_value_behind_the_prefix() {
    assert_eq!(
        retry_key(issue("file:ops/one.json"), "file:").unwrap(),
        "ops/one.json"
    );
    assert_eq!(
        retry_key_i64(issue("identity:42"), "identity:").unwrap(),
        42
    );
}

#[test]
fn retry_key_reports_a_prefix_the_key_does_not_carry() {
    let err = retry_key(issue("identity:42"), "project-book:").unwrap_err();
    assert_eq!(
        err.to_string(),
        "invalid input: sync issue key identity:42 cannot be retried"
    );
    let err = retry_key_i64(issue("sync-pass"), "hash-failed:").unwrap_err();
    assert_eq!(
        err.to_string(),
        "invalid input: sync issue key sync-pass cannot be retried"
    );
}

#[test]
fn retry_key_reports_an_empty_or_non_numeric_value() {
    let err = retry_key(issue("reproject:"), "reproject:").unwrap_err();
    assert_eq!(
        err.to_string(),
        "invalid input: sync issue key reproject: cannot be retried"
    );
    let err = retry_key_i64(issue("project-book:not-an-id"), "project-book:").unwrap_err();
    assert_eq!(
        err.to_string(),
        "invalid input: sync issue key project-book:not-an-id cannot be retried"
    );
}
