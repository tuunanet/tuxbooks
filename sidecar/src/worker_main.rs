//! The sandboxed document worker (ADR 0001): one process, one job.
//! Startup order matters (W-2..W-5, W-7, W-10, W-11):
//!   1. PR_SET_PDEATHSIG       (lifecycle containment only, W-11)
//!   2. read the job line      (stdin; decides whether PDFium is needed)
//!   3. PDFium probe + dlopen  (must precede the filesystem lockdown)
//!   4. sandbox apply          (Task 6: Landlock, seccomp, rlimits)
//!   5. document fd 3          (W-5: the only file this process reads)
//!   6. run the job, respond, exit
//! Until Task 6 lands this binary is exercised only by tests; the sidecar
//! flips to it in Task 7.

use std::io::{BufRead, Write};
use std::os::unix::io::FromRawFd;

use tuxbooks_lib::worker::proto::{WorkerErrorKind, WorkerJob, WorkerOp, WorkerResponse};

fn main() {
    tuxbooks_lib::worker::setup_parent_death_signal();
    let code = run();
    std::process::exit(code);
}

fn run() -> i32 {
    let job = match read_job_line() {
        Ok(job) => job,
        Err(message) => return fail(WorkerErrorKind::Worker, message),
    };
    if job.op == WorkerOp::PdfCover {
        // dlopen opens files: load before the filesystem lockdown (Task 6
        // pins this ordering as part of the sandbox contract).
        tuxbooks_lib::pdf::render::probe_and_load(&job.pdfium_dirs);
    }
    if let Err(message) = tuxbooks_lib::worker::sandbox::prepare(&job.limits) {
        return fail(WorkerErrorKind::Sandbox, message);
    }
    let mut document = if job.op == WorkerOp::SelfTest {
        None
    } else {
        match open_document_fd() {
            Ok(file) => Some(file),
            Err(message) => return fail(WorkerErrorKind::Worker, message),
        }
    };
    let response = tuxbooks_lib::worker::run_job(&job, document.as_mut());
    let line = serde_json::to_string(&response).expect("worker response serializes");
    let mut stdout = std::io::stdout().lock();
    // C1 exit contract (ADR 0001 D1): exit 0 whenever a well-formed response
    // went out, whether it reports success or a typed failure. A nonzero
    // exit means no well-formed response exists, which is the only thing the
    // sidecar reads as a crash. Returning 1 on a Failed response would
    // collapse every typed parse, limit, and sandbox error into Crash.
    match writeln!(stdout, "{line}").and_then(|_| stdout.flush()) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("worker: response write failed: {err}");
            1
        }
    }
}

fn read_job_line() -> Result<WorkerJob, String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|err| format!("job read: {err}"))?;
    serde_json::from_str(line.trim()).map_err(|err| format!("job parse: {err}"))
}

/// W-5: fd 3 is the whole document. No path ever crosses the boundary.
fn open_document_fd() -> Result<std::fs::File, String> {
    // Existence check first: from_raw_fd would otherwise take ownership of
    // whatever fd 3 happens to be, or close it on drop.
    if unsafe { libc::fcntl(3, libc::F_GETFD) } == -1 {
        return Err("no document fd 3 was provided".to_string());
    }
    // SAFETY: fd 3 exists (F_GETFD succeeded) and is the spawner's handoff;
    // ownership of that descriptor moves into this File.
    let file = unsafe { std::fs::File::from_raw_fd(3) };
    let meta = file
        .metadata()
        .map_err(|err| format!("document fd 3: {err}"))?;
    if !meta.is_file() {
        return Err("document fd 3 is not a regular file".to_string());
    }
    Ok(file)
}

fn fail(kind: WorkerErrorKind, message: String) -> i32 {
    let response = WorkerResponse::Failed {
        kind,
        message,
        limit: None,
    };
    let line = serde_json::to_string(&response).expect("failure response serializes");
    let mut stdout = std::io::stdout().lock();
    // The Failed response is well-formed, so the C1 exit contract gives it 0.
    match writeln!(stdout, "{line}").and_then(|_| stdout.flush()) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}
