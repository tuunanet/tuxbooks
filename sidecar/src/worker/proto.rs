use serde::{Deserialize, Serialize};

/// One job for the document worker, serialized as a single JSON line on the
/// worker's stdin. The document itself arrives on pre-opened fd 3 (Unix).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerJob {
    pub op: WorkerOp,
    pub limits: crate::limits::ResourceLimits,
    /// EPUB member path for `EpubMember`.
    #[serde(default)]
    pub member: Option<String>,
    /// Metadata to embed for `EpubEmbed` / `PdfEmbed`.
    #[serde(default)]
    pub metadata: Option<MetadataPayload>,
    /// Candidate directories for `libpdfium.so` (PDF cover jobs), probed in
    /// order; passed explicitly so the worker needs no environment (W-7).
    #[serde(default)]
    pub pdfium_dirs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerOp {
    EpubParse,
    EpubSession,
    EpubMember,
    EpubEmbed,
    PdfParse,
    PdfProperties,
    PdfCover,
    PdfEmbed,
    /// Diagnostic op: applies the sandbox and reports what it observes.
    /// Parses nothing and needs no document; used by tests and probes.
    SelfTest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetadataPayload {
    Epub(crate::epub::EpubMetadata),
    Pdf(crate::pdf::PdfMetadata),
}

/// The single response the worker writes to stdout before exiting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum WorkerResponse {
    Done {
        /// JSON result (parsed book, session, properties, selftest report).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        json: Option<serde_json::Value>,
        /// Base64 bytes (extracted member, cover PNG, rewritten document).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bytes_b64: Option<String>,
    },
    Failed {
        kind: WorkerErrorKind,
        message: String,
        /// Quota name when `kind` is `Limit` (typed, Task 2 ledger).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerErrorKind {
    /// A quota in the job's `ResourceLimits` tripped inside the worker.
    Limit,
    /// The document was rejected as malformed, unsupported, or hostile.
    Parse,
    /// A sandbox layer was unavailable or self-verification failed (W-10).
    Sandbox,
    /// Anything else the worker failed at before or around parsing.
    Worker,
}

/// Report returned by the `SelfTest` op (and surfaced in logs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSelfTest {
    pub landlock: LandlockStatus,
    pub open_denied: bool,
    pub socket_denied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum LandlockStatus {
    Applied { abi: u32 },
    Unsupported,
    NotApplicable,
}

/// Hard cap on one worker response (Task 2 ledger): above the sidecar
/// 1 GiB source quota including base64 growth (1 GiB -> ~1.37 GiB).
pub const MAX_WORKER_RESPONSE_BYTES: usize = 2 << 30;

/// Embed jobs cap the source document below the address-space rlimit
/// (ADR 0001, I2): source + rewritten document + base64 output (x4/3)
/// must fit `WORKER_ADDRESS_SPACE_CAP` together, and a specific
/// bounded-resource error beats an allocator abort surfacing as a crash.
pub const MAX_EMBED_SOURCE_BYTES: u64 = 512 << 20;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_round_trips_through_one_json_line() {
        let job = WorkerJob {
            op: WorkerOp::EpubMember,
            limits: crate::limits::ResourceLimits::DEFAULTS,
            member: Some("META-INF/container.xml".to_string()),
            metadata: None,
            pdfium_dirs: vec!["/tmp/pdfium".to_string()],
        };
        let line = serde_json::to_string(&job).unwrap();
        assert!(!line.contains('\n'));
        let back: WorkerJob = serde_json::from_str(&line).unwrap();
        assert_eq!(back, job);
    }

    #[test]
    fn response_kinds_round_trip_snake_case() {
        let done = WorkerResponse::Done {
            json: None,
            bytes_b64: Some("aGk=".into()),
        };
        let line = serde_json::to_string(&done).unwrap();
        assert!(line.contains(r#""status":"done""#), "{line}");
        assert_eq!(serde_json::from_str::<WorkerResponse>(&line).unwrap(), done);

        let failed = WorkerResponse::Failed {
            kind: WorkerErrorKind::Limit,
            message: "x".into(),
            limit: Some("max_parse_seconds".into()),
        };
        let line = serde_json::to_string(&failed).unwrap();
        assert!(line.contains(r#""kind":"limit""#), "{line}");
        assert_eq!(
            serde_json::from_str::<WorkerResponse>(&line).unwrap(),
            failed
        );
    }

    #[test]
    fn limits_survive_the_wire() {
        let job = WorkerJob {
            op: WorkerOp::SelfTest,
            limits: crate::limits::ResourceLimits {
                max_parse_seconds: 7,
                ..crate::limits::ResourceLimits::DEFAULTS
            },
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        let line = serde_json::to_string(&job).unwrap();
        let back: WorkerJob = serde_json::from_str(&line).unwrap();
        assert_eq!(back.limits.max_parse_seconds, 7);
    }

    #[test]
    fn embed_metadata_round_trips() {
        let job = WorkerJob {
            op: WorkerOp::EpubEmbed,
            limits: crate::limits::ResourceLimits::DEFAULTS,
            member: None,
            metadata: Some(MetadataPayload::Pdf(crate::pdf::PdfMetadata {
                title: "T".into(),
                author: Some("A".into()),
                description: None,
            })),
            pdfium_dirs: Vec::new(),
        };
        let line = serde_json::to_string(&job).unwrap();
        let back: WorkerJob = serde_json::from_str(&line).unwrap();
        assert!(matches!(back.metadata, Some(MetadataPayload::Pdf(_))));
    }
}
