//! W-6/W-8/W-9 pins: the sidecar survives worker death, kills at the
//! deadline, and rejects oversized or malformed worker output.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};
use tuxbooks_lib::worker::proto::{WorkerJob, WorkerOp};

fn client() -> WorkerClient {
    WorkerClient::locate().unwrap()
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

fn client_with(script: &str) -> (tempfile::TempDir, WorkerClient) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fake-worker.sh");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(format!("#!/bin/sh\n{script}\n").as_bytes())
        .unwrap();
    drop(f);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, WorkerClient::new(path))
}

fn job(op: WorkerOp, limits: ResourceLimits) -> WorkerJob {
    WorkerJob {
        op,
        limits,
        member: None,
        metadata: None,
        pdfium_dirs: Vec::new(),
    }
}

#[test]
fn a_dead_worker_never_takes_down_the_calling_process() {
    // W-9: the client returns a typed crash error; the calling process
    // (here: the test process standing in for the sidecar) continues, and
    // the next spawn with the real worker succeeds.
    let path = fixture("minimal.epub");
    let (_dir, killer) = client_with("kill -SEGV $$");
    let err = killer
        .run(&job(WorkerOp::EpubParse, ResourceLimits::DEFAULTS), &path)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Crash(_)), "got: {err:?}");
    // The next job spawns cleanly: containment, not accumulated state.
    let book = client()
        .epub_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!book.spine.is_empty());
}

#[test]
fn deadline_kill_reports_the_typed_budget_error() {
    let path = fixture("minimal.pdf");
    let (_dir, slow) = client_with("sleep 30");
    let started = std::time::Instant::now();
    let err = slow
        .run(
            &job(
                WorkerOp::PdfParse,
                ResourceLimits {
                    max_parse_seconds: 1,
                    ..ResourceLimits::DEFAULTS
                },
            ),
            &path,
        )
        .unwrap_err();
    assert!(matches!(err, WorkerError::Deadline), "got: {err:?}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "kill must be prompt"
    );
}

#[test]
fn a_flooded_worker_response_hits_the_cap_not_a_hang() {
    let path = fixture("minimal.epub");
    let (_dir, flooder) = client_with("head -c 3000000000 /dev/zero | tr '\\0' 'x'");
    let started = std::time::Instant::now();
    let err = flooder
        .run(&job(WorkerOp::SelfTest, ResourceLimits::DEFAULTS), &path)
        .unwrap_err();
    assert!(
        matches!(err, WorkerError::Protocol(_) | WorkerError::Deadline),
        "cap or kill, never a hang: {err:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(120));
}

#[test]
fn worker_with_missing_binary_fails_closed() {
    let result = WorkerClient::new(PathBuf::from("/nonexistent/tuxbooks-worker"))
        .epub_parse(&fixture("minimal.epub"), &ResourceLimits::DEFAULTS);
    assert!(matches!(result, Err(WorkerError::Unavailable(_))));
}

#[test]
fn an_rlimit_cpu_kill_maps_to_a_typed_limit_error() {
    // I3: SIGXCPU (the RLIMIT_CPU backstop firing) is a resource-limit
    // failure, not a mystery crash, so it must surface as a typed limit
    // error rather than Crash/-32004.
    let path = fixture("minimal.pdf");
    let (_dir, cpu) = client_with("kill -XCPU $$");
    let err = cpu
        .run(&job(WorkerOp::PdfParse, ResourceLimits::DEFAULTS), &path)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Limit(_)), "got: {err:?}");
}

#[test]
fn a_failed_response_reaches_the_sidecar_as_a_typed_error() {
    // C1 regression pin: the worker writes a well-formed Failed response
    // and exits 0, so the client must map it by kind, never as Crash. The
    // real worker refuses garbage with kind=parse.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.epub");
    std::fs::write(&path, b"definitely not a zip archive").unwrap();
    let err = client()
        .epub_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
}

#[test]
fn hostile_documents_never_outlive_their_deadline() {
    // W-8 on the real worker: a zero-second budget trips the quota table
    // inside the worker and comes back typed, fast.
    let tight = ResourceLimits {
        max_parse_seconds: 0,
        ..ResourceLimits::DEFAULTS
    };
    let err = client()
        .epub_parse(&fixture("minimal.epub"), &tight)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Limit(_)), "got: {err:?}");
}
