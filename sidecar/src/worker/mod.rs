pub mod client;
pub mod proto;

pub use client::{WorkerClient, WorkerError};
pub use proto::{
    LandlockStatus, MetadataPayload, SandboxSelfTest, WorkerErrorKind, WorkerJob, WorkerOp,
    WorkerResponse, MAX_EMBED_SOURCE_BYTES, MAX_WORKER_RESPONSE_BYTES,
};

/// Typed refusal for an embed source over the cap, or `None` when it fits.
/// Extracted as a pure function so the cap is testable without a 513 MiB
/// fixture (ADR 0001, I2).
pub fn embed_source_error(len: u64) -> Option<(&'static str, String)> {
    (len > MAX_EMBED_SOURCE_BYTES).then(|| {
        (
            "max_embed_source_bytes",
            format!(
                "embed source is {len} bytes, over the {MAX_EMBED_SOURCE_BYTES} byte embed cap"
            ),
        )
    })
}

/// W-11: die with the sidecar. Lifecycle containment only (a compromised
/// worker can clear it); every other layer stands without it.
pub fn setup_parent_death_signal() {
    #[cfg(unix)]
    {
        const PR_SET_PDEATHSIG: libc::c_int = 1;
        const SIGTERM: libc::c_int = 15;
        let original_ppid = unsafe { libc::getppid() };
        unsafe { libc::prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) };
        if unsafe { libc::getppid() } != original_ppid {
            std::process::exit(0);
        }
    }
    #[cfg(not(unix))]
    {
        // No parent-death signal on this platform; the worker still exits on
        // stdin EOF, and the sidecar reaps on spawn failure.
    }
}

/// Runs one job. `document` is None only for `SelfTest`; every parsing op
/// requires the fd handoff. Tasks 4-5 fill in the real dispatch.
pub fn run_job(job: &WorkerJob, document: Option<&mut std::fs::File>) -> WorkerResponse {
    let _ = (job, document);
    WorkerResponse::Done {
        json: Some(serde_json::json!({ "stage": "handoff" })),
        bytes_b64: None,
    }
}
