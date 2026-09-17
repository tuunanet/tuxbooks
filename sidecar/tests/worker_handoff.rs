//! The worker answers exactly one JSON response and exits (ADR 0001 D1/D2).
//! Proven with the real binary via CARGO_BIN_EXE, driving the SelfTest op
//! (which needs no document) so this test isolates the handoff itself.

use std::io::Write;
use std::os::unix::process::CommandExt;

use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::proto::{WorkerErrorKind, WorkerJob, WorkerOp, WorkerResponse};

fn command() -> std::process::Command {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_tuxbooks-worker"));
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    command
}

fn run_job(mut command: std::process::Command, job: &WorkerJob) -> WorkerResponse {
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(serde_json::to_string(job).unwrap().as_bytes())
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn worker_answers_one_json_response_and_exits() {
    let job = WorkerJob {
        op: WorkerOp::SelfTest,
        limits: ResourceLimits::DEFAULTS,
        member: None,
        metadata: None,
        pdfium_dirs: Vec::new(),
    };
    let response = run_job(command(), &job);
    assert!(
        matches!(response, WorkerResponse::Done { .. }),
        "got: {response:?}"
    );
}

#[test]
fn parsing_ops_refuse_to_run_without_a_document_fd() {
    // Spawned with fd 3 explicitly closed: a parsing op must fail with a
    // typed worker error instead of reading whatever fd 3 might hold.
    let job = WorkerJob {
        op: WorkerOp::EpubMember,
        limits: ResourceLimits::DEFAULTS,
        member: Some("META-INF/container.xml".to_string()),
        metadata: None,
        pdfium_dirs: Vec::new(),
    };
    let mut command = command();
    // SAFETY: the closure runs in the forked child before exec; close is
    // async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            // Deterministically remove fd 3 (if any leaked into the child).
            libc::close(3);
            Ok(())
        });
    }
    let response = run_job(command, &job);
    match response {
        WorkerResponse::Failed { kind, .. } => {
            assert!(matches!(kind, WorkerErrorKind::Worker), "got: {response:?}")
        }
        other => panic!("expected a typed failure, got: {other:?}"),
    }
}
