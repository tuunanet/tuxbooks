//! Sidecar-side client for the one-shot document worker (ADR 0001 D1/D2):
//! spawn with fd-passing handoff and an empty environment, enforce the
//! wall-clock deadline by killing, and cap the response at
//! `MAX_WORKER_RESPONSE_BYTES`. Sync by design: every caller already runs
//! inside a blocking context (spawn_blocking or the import semaphore task).

use base64::Engine as _;
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::limits::ResourceLimits;
use crate::worker::proto::{
    MetadataPayload, SandboxSelfTest, WorkerErrorKind, WorkerJob, WorkerOp, WorkerResponse,
    MAX_WORKER_RESPONSE_BYTES,
};

pub struct WorkerClient {
    binary_path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("document worker unavailable: {0}")]
    Unavailable(String),
    /// The sidecar could not open the document at all: distinct from a
    /// missing worker binary (M4), same -32004 code.
    #[error("document could not be opened by the sidecar: {0}")]
    Document(String),
    #[error("document worker protocol error: {0}")]
    Protocol(String),
    #[error("resource limit exceeded: {0}")]
    Limit(#[from] crate::limits::LimitExceeded),
    #[error("document parse failed: {0}")]
    Parse(String),
    #[error("document worker sandbox error: {0}")]
    Sandbox(String),
    #[error("document worker exceeded its wall-clock budget")]
    Deadline,
    #[error("document worker crashed: {0}")]
    Crash(String),
}

impl WorkerError {
    /// Typed JSON-RPC code mapping (Task 2 ledger): deadline -32001,
    /// limit -32002, sandbox -32003, everything else -32004.
    pub fn rpc_code(&self) -> i32 {
        match self {
            WorkerError::Deadline => -32001,
            WorkerError::Limit(_) => -32002,
            WorkerError::Sandbox(_) => -32003,
            _ => -32004,
        }
    }
}

impl WorkerClient {
    pub fn new(binary_path: PathBuf) -> Self {
        Self { binary_path }
    }

    /// `TUXBOOKS_WORKER` override, then the executable's directory (packaged
    /// layout: the worker sits next to the sidecar), then the dev target dirs.
    pub fn locate() -> Result<Self, WorkerError> {
        if let Ok(override_path) = std::env::var("TUXBOOKS_WORKER") {
            if !override_path.is_empty() {
                return Ok(Self::new(PathBuf::from(override_path)));
            }
        }
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                // Packaged: the worker installs next to the sidecar binary.
                candidates.push(dir.join("tuxbooks-worker"));
            }
        }
        candidates
            .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/tuxbooks-worker"));
        candidates
            .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/tuxbooks-worker"));
        candidates
            .into_iter()
            .find(|candidate| candidate.exists())
            .map(WorkerClient::new)
            .ok_or_else(|| WorkerError::Unavailable("tuxbooks-worker binary not found".into()))
    }

    /// Deadline for one job: the parse budget plus a small spawn margin, so
    /// the worker's own Deadline usually trips first and the sidecar kill is
    /// the backstop for the stages that cannot check (`Document::load`,
    /// the PDFium render).
    fn budget(limits: &ResourceLimits) -> Duration {
        Duration::from_secs(limits.max_parse_seconds).saturating_add(Duration::from_secs(1))
    }

    pub fn run(&self, job: &WorkerJob, document: &Path) -> Result<WorkerResponse, WorkerError> {
        let file = std::fs::File::open(document)
            .map_err(|err| WorkerError::Document(format!("{}: {err}", document.display())))?;
        let fd = file.as_raw_fd();
        let mut command = Command::new(&self.binary_path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env_clear();
        // SAFETY: the closure runs in the forked child before exec and only
        // performs async-signal-safe syscalls (setpgid, close_range, dup2).
        // setpgid(0, 0) puts the worker in its own process group so the
        // deadline kill can take down anything it spawned too; a plain kill
        // of a shell-script stand-in would leave grandchildren holding the
        // response pipe and the reader thread blocked on them.
        unsafe {
            command.pre_exec(move || {
                // SAFETY: async-signal-safe syscalls only (dup2, close_range,
                // setpgid). Enforce the fd contract (W-7, ADR 0001 D2): the
                // document lands on fd 3 first (dup2 clears CLOEXEC on the
                // new descriptor), then every descriptor >= 4 is marked
                // close-on-exec and vanishes atomically at execve. The
                // CLOEXEC form is used instead of a hard close so std's
                // exec-error pipe survives to report exec failures; the
                // end state is identical: the worker execs holding exactly
                // fds 0-3. (The plan's sketch closed before the dup2, which
                // can close the document fd itself when it is >= 4.)
                // dup2 with oldfd == newfd is a documented no-op that does
                // NOT clear CLOEXEC, so the equal-fd case must clear the
                // flag via fcntl or the document dies at execve (the fd
                // number the source file lands on depends on the parent's
                // fd table at spawn time).
                if fd == 3 {
                    if libc::fcntl(3, libc::F_SETFD, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                } else if libc::dup2(fd, 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                {
                    if libc::close_range(4, u32::MAX, libc::CLOSE_RANGE_CLOEXEC as i32) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|err| WorkerError::Unavailable(format!("worker spawn: {err}")))?;
        // `file` stays open while the pre_exec closure may still run; the
        // drop after spawn closes only the parent's copy of the descriptor.
        drop(file);

        let job_line =
            serde_json::to_string(job).map_err(|err| WorkerError::Protocol(err.to_string()))?;
        {
            let mut stdin = child.stdin.take().expect("piped stdin");
            let write = stdin
                .write_all(job_line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"));
            if let Err(err) = write {
                // A broken pipe means the worker closed stdin without reading
                // its job, i.e. it died during startup. The exit status is the
                // real event and the pipe error is only a symptom, so report the
                // crash instead of a protocol failure. This also closes the
                // race where a worker exits before the parent's write lands:
                // the same death must not be a Crash or a Protocol depending
                // on scheduling.
                drop(stdin);
                if err.kind() == std::io::ErrorKind::BrokenPipe {
                    let status = wait_bounded(&mut child, Duration::from_secs(2))
                        .map_err(|err| WorkerError::Protocol(format!("worker wait: {err}")))?;
                    return Err(crash_error(&status, "worker exited before reading its job"));
                }
                return Err(WorkerError::Protocol(format!("job write: {err}")));
            }
        } // stdin drops: the worker sees EOF after its single job line

        // Read the (single) response on a thread so the deadline can kill.
        let mut stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let outcome = std::io::BufReader::with_capacity(64 << 10, &mut stdout)
                .take(MAX_WORKER_RESPONSE_BYTES as u64 + 1)
                .read_to_end(&mut buf);
            let _ = tx.send((buf, outcome));
        });
        let (buf, _outcome) = rx.recv_timeout(Self::budget(&job.limits)).map_err(|_| {
            kill_group(&mut child);
            // M1: reap before returning, or the killed worker stays a
            // zombie for the lifetime of this process.
            let _ = child.wait();
            let _ = reader.join();
            WorkerError::Deadline
        })?;

        // Bounded post-response reap: a worker that wrote its response and
        // then hung must not hold the client past the wall-clock budget.
        // The response is already in hand (C1), so a grace kill loses
        // nothing; two seconds covers normal exit, SIGPIPE deaths from the
        // response-cap cutoff, and process teardown.
        let status = wait_bounded(&mut child, Duration::from_secs(2))
            .map_err(|err| WorkerError::Protocol(format!("worker wait: {err}")))?;
        if buf.len() > MAX_WORKER_RESPONSE_BYTES {
            return Err(WorkerError::Protocol(
                "worker response exceeded the response-line cap".to_string(),
            ));
        }

        // C1: the worker exits 0 whenever it wrote a well-formed response,
        // including `Failed` responses, so the response is parsed BEFORE the
        // exit status is consulted. A nonzero exit only means "no well-formed
        // response existed", which is where crash mapping belongs. A worker
        // that crashes after writing a well-formed response still gets its
        // response honored: the response is the contract.
        if buf.is_empty() {
            return Err(crash_error(&status, "worker produced no response"));
        }
        let line = match std::str::from_utf8(&buf) {
            Ok(line) => line,
            Err(_) => return Err(crash_error(&status, "worker response was not utf8")),
        };
        let response: WorkerResponse = match serde_json::from_str(line.trim()) {
            Ok(response) => response,
            Err(err) => {
                return Err(crash_error(
                    &status,
                    &format!("worker response was not a well-formed result: {err}"),
                ));
            }
        };
        match response {
            WorkerResponse::Done { .. } => Ok(response),
            WorkerResponse::Failed {
                kind,
                message,
                limit,
            } => Err(match kind {
                // `LimitExceeded.limit` is `&'static str`; the wire sends the
                // name as a String. Leaking one bounded quota-name string per
                // tripped limit is acceptable (rare, tiny); the alternative
                // would widen the #83 error type across the crate.
                WorkerErrorKind::Limit => WorkerError::Limit(crate::limits::LimitExceeded {
                    limit: Box::leak(limit.map(Into::into).unwrap_or_else(|| "worker".into())),
                    detail: message,
                }),
                WorkerErrorKind::Parse => WorkerError::Parse(message),
                WorkerErrorKind::Sandbox => WorkerError::Sandbox(message),
                WorkerErrorKind::Worker => WorkerError::Protocol(message),
            }),
        }
    }

    pub fn self_test(&self, limits: &ResourceLimits) -> Result<SandboxSelfTest, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::SelfTest,
            limits: *limits,
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, Path::new("/dev/null"))? {
            WorkerResponse::Done {
                json: Some(value), ..
            } => {
                serde_json::from_value(value).map_err(|err| WorkerError::Protocol(err.to_string()))
            }
            WorkerResponse::Done { .. } => Err(WorkerError::Protocol(
                "selftest returned no payload".to_string(),
            )),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Parse one EPUB in the worker (W-1): typed book back over the wire.
    pub fn epub_parse(
        &self,
        document: &Path,
        limits: &ResourceLimits,
    ) -> Result<crate::epub::EpubBook, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::EpubParse,
            limits: *limits,
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                json: Some(value), ..
            } => {
                serde_json::from_value(value).map_err(|err| WorkerError::Protocol(err.to_string()))
            }
            WorkerResponse::Done { json: None, .. } => Err(WorkerError::Protocol(
                "epub_parse returned no payload".to_string(),
            )),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Build the EPUB reading session (RWPM + positions) in the worker.
    pub fn epub_session(
        &self,
        document: &Path,
        limits: &ResourceLimits,
    ) -> Result<crate::epub::EpubReadingSession, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::EpubSession,
            limits: *limits,
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                json: Some(value), ..
            } => {
                serde_json::from_value(value).map_err(|err| WorkerError::Protocol(err.to_string()))
            }
            WorkerResponse::Done { json: None, .. } => Err(WorkerError::Protocol(
                "epub_session returned no payload".to_string(),
            )),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Extract one EPUB member by path in the worker; `None` for a miss.
    pub fn epub_member(
        &self,
        document: &Path,
        member: &str,
        limits: &ResourceLimits,
    ) -> Result<Option<Vec<u8>>, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::EpubMember,
            limits: *limits,
            member: Some(member.to_string()),
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                bytes_b64: Some(b64),
                ..
            } => Ok(Some(
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|err| WorkerError::Protocol(err.to_string()))?,
            )),
            WorkerResponse::Done {
                bytes_b64: None, ..
            } => Ok(None),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Parse one PDF in the worker. An empty parsed title falls back to the
    /// humanized file stem (the fd has no name; the client holds the path).
    pub fn pdf_parse(
        &self,
        document: &Path,
        limits: &ResourceLimits,
    ) -> Result<crate::pdf::PdfBook, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::PdfParse,
            limits: *limits,
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                json: Some(value), ..
            } => {
                let mut book: crate::pdf::PdfBook = serde_json::from_value(value)
                    .map_err(|err| WorkerError::Protocol(err.to_string()))?;
                if book.metadata.title.is_empty() {
                    book.metadata.title = crate::pdf::parser::fallback_title(document);
                }
                Ok(book)
            }
            WorkerResponse::Done { json: None, .. } => Err(WorkerError::Protocol(
                "pdf_parse returned no payload".to_string(),
            )),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Read the PDF's native Info-dictionary entries in the worker.
    pub fn pdf_properties(
        &self,
        document: &Path,
        limits: &ResourceLimits,
    ) -> Result<Vec<(String, String)>, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::PdfProperties,
            limits: *limits,
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                json: Some(value), ..
            } => {
                serde_json::from_value(value).map_err(|err| WorkerError::Protocol(err.to_string()))
            }
            WorkerResponse::Done { json: None, .. } => Err(WorkerError::Protocol(
                "pdf_properties returned no payload".to_string(),
            )),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Render page 1 as a PNG cover in the worker (PDFium runs only there,
    /// P-1). `Ok(None)` when no library binds or the document has no pages.
    pub fn pdf_cover(
        &self,
        document: &Path,
        pdfium_dirs: &[PathBuf],
        limits: &ResourceLimits,
    ) -> Result<Option<Vec<u8>>, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::PdfCover,
            limits: *limits,
            member: None,
            metadata: None,
            pdfium_dirs: pdfium_dirs
                .iter()
                .map(|dir| dir.to_string_lossy().into_owned())
                .collect(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                bytes_b64: Some(b64),
                ..
            } => Ok(Some(
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|err| WorkerError::Protocol(err.to_string()))?,
            )),
            WorkerResponse::Done {
                bytes_b64: None, ..
            } => Ok(None),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Rewrite an EPUB's metadata in the worker; the sidecar owns the write
    /// (backup + atomic replace). Returns the full rewritten bytes.
    pub fn epub_embed(
        &self,
        document: &Path,
        metadata: &crate::epub::EpubMetadata,
        limits: &ResourceLimits,
    ) -> Result<Vec<u8>, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::EpubEmbed,
            limits: *limits,
            member: None,
            metadata: Some(MetadataPayload::Epub(metadata.clone())),
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                bytes_b64: Some(b64),
                ..
            } => base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|err| WorkerError::Protocol(err.to_string())),
            WorkerResponse::Done {
                bytes_b64: None, ..
            } => Err(WorkerError::Protocol(
                "epub_embed returned no bytes".to_string(),
            )),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

    /// Rewrite a PDF's Info dictionary in the worker; the sidecar owns the
    /// write (backup + atomic replace). Returns the full rewritten bytes.
    pub fn pdf_embed(
        &self,
        document: &Path,
        metadata: &crate::pdf::PdfMetadata,
        limits: &ResourceLimits,
    ) -> Result<Vec<u8>, WorkerError> {
        let job = WorkerJob {
            op: WorkerOp::PdfEmbed,
            limits: *limits,
            member: None,
            metadata: Some(MetadataPayload::Pdf(metadata.clone())),
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, document)? {
            WorkerResponse::Done {
                bytes_b64: Some(b64),
                ..
            } => base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|err| WorkerError::Protocol(err.to_string())),
            WorkerResponse::Done {
                bytes_b64: None, ..
            } => Err(WorkerError::Protocol(
                "pdf_embed returned no bytes".to_string(),
            )),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }
}

/// Wait for `child` up to `grace`; escalate to a kill when it lingers past
/// it (residual-risk note in the plan: the post-response wait must stay
/// bounded, never block past the deadline kill).
fn wait_bounded(
    child: &mut std::process::Child,
    grace: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if started.elapsed() > grace {
            kill_group(child);
            return child.wait();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Kill the worker and everything it spawned (W-9): the worker leads its
/// own process group (`setpgid` in the spawn hook), so a negative-pid
/// signal reaches the whole tree. A plain kill of a shell-script stand-in
/// would leave grandchildren holding the response pipe. The group kill is
/// best-effort (the group may already be gone); the direct child is killed
/// too, and the caller reaps via `wait`.
fn kill_group(child: &mut std::process::Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.kill();
}

/// Map a worker that produced no well-formed response onto the typed error
/// space (I3): an `RLIMIT_CPU` kill is a resource-limit failure, not a
/// mystery crash, so SIGXCPU maps to a typed limit error and everything
/// else to `Crash`.
fn crash_error(status: &std::process::ExitStatus, detail: &str) -> WorkerError {
    if status.signal() == Some(libc::SIGXCPU) {
        return WorkerError::Limit(crate::limits::LimitExceeded {
            limit: "RLIMIT_CPU",
            detail: "worker was killed by its CPU rlimit".to_string(),
        });
    }
    WorkerError::Crash(format!(
        "{detail} (exit code {:?} signal {:?})",
        status.code(),
        status.signal()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::ResourceLimits;
    use crate::worker::proto::{WorkerJob, WorkerOp};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn client_with(script_body: &str) -> (tempfile::TempDir, WorkerClient) {
        // Stand-in "worker" binaries exercise the client's supervision logic
        // without test-only ops in the production worker.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake-worker.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(format!("#!/bin/sh\n{}\n", script_body).as_bytes())
            .unwrap();
        drop(f);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, WorkerClient::new(path))
    }

    fn self_test_job(limits: ResourceLimits) -> WorkerJob {
        WorkerJob {
            op: WorkerOp::SelfTest,
            limits,
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        }
    }

    #[test]
    fn locate_finds_the_built_worker_binary() {
        WorkerClient::locate().expect("worker binary should be built by cargo test");
    }

    #[test]
    fn deadline_kill_produces_a_typed_deadline_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.bin");
        std::fs::write(&path, b"x").unwrap();
        let (_sdir, client) = client_with("sleep 30");
        let job = self_test_job(ResourceLimits {
            max_parse_seconds: 1,
            ..ResourceLimits::DEFAULTS
        });
        let started = std::time::Instant::now();
        let err = client.run(&job, &path).unwrap_err();
        assert!(matches!(err, WorkerError::Deadline), "got: {err:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn crashing_worker_produces_a_typed_crash_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.bin");
        std::fs::write(&path, b"x").unwrap();
        // The worker exits before it can read the job, so the parent's write
        // races process death: it gets a broken pipe when the exit wins, a
        // clean EOF otherwise. Both have to surface as the same typed crash.
        let (_sdir, client) = client_with("exit 3");
        let err = client
            .run(&self_test_job(ResourceLimits::DEFAULTS), &path)
            .unwrap_err();
        assert!(matches!(err, WorkerError::Crash(_)), "got: {err:?}");
    }

    #[test]
    fn a_worker_that_dies_before_reading_its_job_reports_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.bin");
        std::fs::write(&path, b"x").unwrap();
        // A job larger than the pipe buffer makes the parent block inside
        // write; the worker then exits without reading, so the blocked write
        // returns EPIPE once the read end is gone. That is the deterministic
        // form of the startup-crash race the flaky `exit 3` test hits by
        // timing. The job must surface as a Crash, not a Protocol error.
        let (_sdir, client) = client_with("sleep 0.5; exit 3");
        let mut job = self_test_job(ResourceLimits::DEFAULTS);
        job.member = Some("x".repeat(512 * 1024));
        let err = client.run(&job, &path).unwrap_err();
        assert!(matches!(err, WorkerError::Crash(_)), "got: {err:?}");
    }

    #[test]
    fn oversized_response_is_rejected_by_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.bin");
        std::fs::write(&path, b"x").unwrap();
        let (_sdir, client) = client_with("head -c 3000000000 /dev/zero | tr '\\0' 'x'");
        let err = client
            .run(&self_test_job(ResourceLimits::DEFAULTS), &path)
            .unwrap_err();
        assert!(matches!(err, WorkerError::Protocol(_)), "got: {err:?}");
    }
}
