pub mod client;
pub mod proto;

use crate::limits::ResourceLimits;
use base64::Engine as _;

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
/// requires the fd handoff.
pub fn run_job(job: &WorkerJob, document: Option<&mut std::fs::File>) -> WorkerResponse {
    let result = match (job.op, document) {
        (WorkerOp::SelfTest, _) => self_test_response(),
        (_, None) => Err(JobError::worker("no document was provided".to_string())),
        (_, Some(document)) => dispatch(job, document),
    };
    match result {
        Ok(response) => response,
        Err(err) => WorkerResponse::Failed {
            kind: err.kind,
            message: err.message,
            limit: err.limit.map(str::to_string),
        },
    }
}

/// One failed job inside the worker, mapped onto the wire's Failed shape.
struct JobError {
    kind: WorkerErrorKind,
    message: String,
    limit: Option<&'static str>,
}

impl JobError {
    fn parse(message: String) -> Self {
        Self {
            kind: WorkerErrorKind::Parse,
            message,
            limit: None,
        }
    }
    fn worker(message: String) -> Self {
        Self {
            kind: WorkerErrorKind::Worker,
            message,
            limit: None,
        }
    }
    fn limit(limit: crate::limits::LimitExceeded) -> Self {
        Self {
            kind: WorkerErrorKind::Limit,
            message: limit.to_string(),
            limit: Some(limit.limit),
        }
    }
}

impl From<crate::epub::EpubError> for JobError {
    fn from(err: crate::epub::EpubError) -> Self {
        match err {
            crate::epub::EpubError::Limit(limit) => Self::limit(limit),
            other => Self::parse(other.to_string()),
        }
    }
}

impl From<crate::pdf::PdfError> for JobError {
    fn from(err: crate::pdf::PdfError) -> Self {
        match err {
            crate::pdf::PdfError::Limit(limit) => Self::limit(limit),
            other => Self::parse(other.to_string()),
        }
    }
}

fn self_test_response() -> Result<WorkerResponse, JobError> {
    // Task 6 replaces these literals with real sandbox observations.
    let report = SandboxSelfTest {
        landlock: LandlockStatus::NotApplicable,
        open_denied: false,
        socket_denied: false,
    };
    done_json(serde_json::to_value(report).map_err(|err| JobError::worker(err.to_string()))?)
}

fn done_json(value: serde_json::Value) -> Result<WorkerResponse, JobError> {
    Ok(WorkerResponse::Done {
        json: Some(value),
        bytes_b64: None,
    })
}

fn done_bytes(bytes: Vec<u8>) -> Result<WorkerResponse, JobError> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(WorkerResponse::Done {
        json: None,
        bytes_b64: Some(b64),
    })
}

fn done_optional_bytes(bytes: Option<Vec<u8>>) -> Result<WorkerResponse, JobError> {
    match bytes {
        Some(bytes) => done_bytes(bytes),
        None => Ok(WorkerResponse::Done {
            json: None,
            bytes_b64: None,
        }),
    }
}

/// PDF ops buffer the fd once (bounded by the source quota): lopdf and
/// PDFium accept memory inputs only.
fn read_fd_bounded(
    document: &mut std::fs::File,
    limits: &ResourceLimits,
) -> Result<Vec<u8>, JobError> {
    use std::io::{Read, Seek};
    let len = document
        .metadata()
        .map_err(|err| JobError::parse(err.to_string()))?
        .len();
    limits.check_source_file(len).map_err(JobError::limit)?;
    let mut bytes = Vec::new();
    document
        .take(limits.max_source_file_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|err| JobError::parse(err.to_string()))?;
    if bytes.len() as u64 > limits.max_source_file_bytes {
        return Err(JobError::limit(crate::limits::LimitExceeded {
            limit: "max_source_file_bytes",
            detail: "source exceeded max_source_file_bytes".to_string(),
        }));
    }
    document
        .rewind()
        .map_err(|err| JobError::parse(err.to_string()))?;
    Ok(bytes)
}

/// EPUB ops stream from the fd, so the source-size quota must be enforced
/// against the fd's own metadata before the reader core runs (a generic
/// reader cannot stat itself; PDF ops get the check inside
/// `read_fd_bounded`).
fn check_fd_source(document: &mut std::fs::File, limits: &ResourceLimits) -> Result<(), JobError> {
    let len = document
        .metadata()
        .map_err(|err| JobError::parse(err.to_string()))?
        .len();
    limits.check_source_file(len).map_err(JobError::limit)
}

fn dispatch(job: &WorkerJob, document: &mut std::fs::File) -> Result<WorkerResponse, JobError> {
    let limits = &job.limits;
    match job.op {
        WorkerOp::EpubParse => {
            check_fd_source(document, limits)?;
            let book = crate::epub::parse_epub_reader(std::io::BufReader::new(&*document), limits)?;
            done_json(serde_json::to_value(book).map_err(|err| JobError::worker(err.to_string()))?)
        }
        WorkerOp::EpubSession => {
            check_fd_source(document, limits)?;
            let session =
                crate::epub::build_session_reader(std::io::BufReader::new(&*document), limits)?;
            done_json(
                serde_json::to_value(session).map_err(|err| JobError::worker(err.to_string()))?,
            )
        }
        WorkerOp::EpubMember => {
            check_fd_source(document, limits)?;
            let member = job.member.as_deref().ok_or_else(|| {
                JobError::worker("epub_member requires a member path".to_string())
            })?;
            let bytes = crate::epub::read_member_reader(
                std::io::BufReader::new(&*document),
                member,
                limits,
            )?;
            done_optional_bytes(bytes)
        }
        WorkerOp::PdfParse => {
            let bytes = read_fd_bounded(document, limits)?;
            let book = crate::pdf::parse_pdf_bytes(&bytes, limits)?;
            done_json(serde_json::to_value(book).map_err(|err| JobError::worker(err.to_string()))?)
        }
        WorkerOp::PdfProperties => {
            let bytes = read_fd_bounded(document, limits)?;
            let props = crate::pdf::read_file_properties_bytes(&bytes, limits)?;
            done_json(serde_json::to_value(props).map_err(|err| JobError::worker(err.to_string()))?)
        }
        WorkerOp::PdfCover => {
            let bytes = read_fd_bounded(document, limits)?;
            let pdfium = crate::pdf::render::loaded_pdfium()
                .ok_or_else(|| JobError::parse("pdfium library is unavailable".to_string()))?;
            let cover = crate::pdf::render::render_first_page_cover_bytes(&pdfium, &bytes, limits)?;
            done_optional_bytes(cover)
        }
        WorkerOp::SelfTest | WorkerOp::EpubEmbed | WorkerOp::PdfEmbed => Err(JobError::worker(
            format!("op {:?} is not wired in this task", job.op),
        )),
    }
}
