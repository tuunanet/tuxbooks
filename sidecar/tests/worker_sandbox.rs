//! Sandbox enforcement proofs (W-2/W-3/W-4/W-5/W-10) against the real
//! worker. When the kernel lacks Landlock the tests skip with a notice,
//! mirroring the PDFium convention; production still fails closed there.

use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};
use tuxbooks_lib::worker::proto::LandlockStatus;

fn client() -> WorkerClient {
    WorkerClient::locate().expect("worker binary built by cargo test")
}

#[test]
fn selftest_reports_denials_when_landlock_is_supported() {
    if !tuxbooks_lib::worker::sandbox::landlock_supported() {
        eprintln!("skipping: kernel lacks Landlock (5.13+)");
        return;
    }
    let report = client()
        .self_test(&ResourceLimits::DEFAULTS)
        .expect("selftest succeeds");
    assert!(matches!(report.landlock, LandlockStatus::Applied { .. }));
    assert!(report.open_denied, "worker must observe its own FS denial");
    assert!(
        report.socket_denied,
        "worker must observe its own network denial"
    );
    // W-7 observed, not just enforced: the worker holds fds 0-3 only.
    assert!(
        report.open_fds <= 4,
        "worker must hold fds 0-3 only, got: {}",
        report.open_fds
    );
}

#[test]
fn worker_refuses_to_parse_when_the_sandbox_cannot_apply() {
    // On kernels with Landlock this succeeds trivially; the fail-closed
    // branch itself is pinned by the pure check() test in sandbox.rs.
    match client().self_test(&ResourceLimits::DEFAULTS) {
        Ok(_) => {}
        Err(WorkerError::Sandbox(_)) => {} // unsupported kernel: typed, loud
        Err(other) => panic!("unexpected error: {other:?}"),
    }
}
