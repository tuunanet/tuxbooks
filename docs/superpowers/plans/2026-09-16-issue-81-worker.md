# Issue #81 Sandboxed Document Worker (W-1..W-11, P-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All hostile-document parsing, extraction, and cover rendering (EPUB ZIP/XML, PDF via lopdf, covers via PDFium) runs in a dedicated, sandboxed, one-shot worker process; a parser compromise ends at the worker as a typed error plus a fresh spawn, never in the sidecar.

**Architecture:** A second binary `tuxbooks-worker` in the `sidecar/` crate links the existing `tuxbooks_lib`. The sidecar resolves the document path (book id to database to stored file, T-1 unchanged), opens it read-only, and spawns the worker with the fd passed as fd 3 (`pre_exec` + `dup2`, POSIX) and an empty environment. The worker reads one JSON job line from stdin, applies its own sandbox (PDEATHSIG, PDFium preload when needed, fs-only Landlock denying all filesystem access, seccomp deny-list that denies socket creation unconditionally, rlimits, self-verification), runs one operation against the fd, writes one JSON response to stdout, and exits. The sidecar supervises with a wall-clock deadline kill and caps the response at 2 GiB. Design rationale and rejected alternatives: `docs/adr/0001-sandboxed-document-worker.md`.

**Tech Stack:** Rust only (std, libc, serde, base64, thiserror, and the existing zip/quick-xml/lopdf/pdfium-render/image stack). No new crate dependencies. Landlock and seccomp are hand-rolled syscall FFI on `libc`.

**Spec:** `docs/adr/0001-sandboxed-document-worker.md` (this plan's design source) and `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-81-spec.md` (invariants W-1..W-11, P-1) under the umbrella `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-78-umbrella.md`.

## Global Constraints

- TDD: each task's failing test exists and is observed failing (RED) before implementation (GREEN). Compile errors naming the missing API count as RED, matching the #83 plan convention.
- No new dependencies. `limits` stays std + thiserror + serde. Worker modules use std, libc, serde, base64, thiserror, and `tuxbooks_lib` parse modules only. Nothing reachable from `worker_main.rs` may touch `sqlx`, the repository, or `notify`.
- Sandbox tests never weaken the test process: Landlock is thread-scoped (safe to apply in a test thread), but a seccomp filter is process-wide and irreversible, so the seccomp proof always runs in a forked child with the BPF program built before the fork (M2), and no test calls `prepare()` itself. The pure fail-closed decision gets its own seam (`sandbox::check`) so it is testable without applying anything.
- The worker inherits nothing: `env_clear()` at spawn, fds 0/1/2/3 only (`close_range(4, u32::MAX)` in `pre_exec` enforces it on Linux, W-7), no paths on argv, PDFium directories travel in the job payload.
- C1 exit contract: the worker exits 0 whenever it wrote a well-formed response (Done or Failed) and nonzero only when none exists; the client parses the response before consulting the exit status. Without this, every typed worker failure would collapse into `Crash`/-32004.
- Landlock owns filesystem denial only; network denial is seccomp's job (`socket` denied unconditionally, which closes TCP, UDP, AF_UNIX, and netlink on every supported kernel). Landlock's network ABI is not used (ADR 0001 D3 rejection; also removes the E2BIG attr-size hazard, C2).
- Embed sources are capped at `MAX_EMBED_SOURCE_BYTES` = 512 MiB so source, rewrite, and base64 output fit the 3 GiB address-space rlimit together (I2).
- Fail closed everywhere: missing worker binary, unavailable Linux sandbox, failed self-verification, and malformed worker output all produce typed errors and never fall back to in-process parsing.
- The worker response cap is 2 GiB (`MAX_WORKER_RESPONSE_BYTES`), staying above the sidecar 1 GiB source quota including base64 growth (Task 2 ledger).
- Worker-sourced sidecar failures surface as typed JSON-RPC codes (Task 2 ledger): deadline -32001, limit -32002, sandbox -32003, other worker failures -32004.
- Tests are headless, rootless, and terminate. Kernel-gated tests (Landlock ABI, seccomp) skip with a printed notice when the feature is missing, mirroring the PDFium skip convention (`docs/TESTING.md`).
- Hostile fixtures are generated at runtime with the existing `write_zip` / `build_pdf` / `assemble_pdf` helpers; the committed EPUB corpus and its size budget are untouched.
- Do not run two E2E invocations concurrently. `just test-rust` green, then `just check` green, then one `just test-e2e` run at the end. `just format` after Rust edits.
- Commit messages: Conventional Commits, imperative, no em dashes.

## Invariant-to-task map

| Invariant group                               | Proven by                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| W-1, P-1 (parse/extract/cover in the worker)  | Tasks 3-5 (ops), Task 7 (sidecar routing flips traffic)                                                                                    |
| W-5 (opaque handle, no FS authority)          | Tasks 3-5 (fd handoff), Task 6 (Landlock deny-all + self-verification)                                                                     |
| W-2, W-3, W-4 (no DB/network/spawn)           | Task 6 (Landlock FS denial, seccomp incl. unconditional socket denial, selftest probes)                                                    |
| W-6, W-8 (bounded typed results, limits)      | Tasks 1, 3, 8 (typed response, quotas in the job, deadline kill, rlimits, SIGXCPU mapped to a typed limit, embed source cap, response cap) |
| W-7 (minimal privileges/environment)          | Task 3 (env_clear, fd set, argv)                                                                                                           |
| W-9 (killable, restartable, sidecar survives) | Task 3 (client kill/crash handling), Task 8 (service-level containment)                                                                    |
| W-10 (Linux sandbox layer)                    | Task 6 (Landlock, seccomp, rlimits, fail closed)                                                                                           |
| W-11 (PDEATHSIG kept, not a boundary)         | Task 6 (worker sets it first; documented as lifecycle only)                                                                                |

---

### Task 1: Worker protocol types and quota serialization

**Files:**

- Create: `sidecar/src/worker/mod.rs`
- Create: `sidecar/src/worker/proto.rs`
- Modify: `sidecar/src/limits.rs` (add `Serialize, Deserialize` derives)
- Modify: `sidecar/src/epub/metadata.rs` (add `Serialize, Deserialize` to `EpubMetadata`)
- Modify: `sidecar/src/pdf/parser.rs` (add `Serialize, Deserialize` to `PdfBook`, `PdfMetadata`)
- Modify: `sidecar/src/lib.rs` (add `pub mod worker;`)

**Interfaces produced (consumed by every later task):**

```rust
// sidecar/src/worker/proto.rs
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
```

- [ ] **Step 1: Write the failing tests** in `sidecar/src/worker/proto.rs` (create the file with just the test module and imports; `sidecar/src/worker/mod.rs` and the `lib.rs` line are added so the module resolves)

```rust
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
        let done = WorkerResponse::Done { json: None, bytes_b64: Some("aGk=".into()) };
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
        assert_eq!(serde_json::from_str::<WorkerResponse>(&line).unwrap(), failed);
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
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml worker::proto`
Expected: compile failure, unresolved `WorkerJob`, `WorkerResponse`, `WorkerErrorKind`, `MetadataPayload`, `LandlockStatus`, `SandboxSelfTest`, `MAX_WORKER_RESPONSE_BYTES`.

- [ ] **Step 3: Implement**

`sidecar/src/worker/mod.rs`:

```rust
pub mod proto;

pub use proto::{
    LandlockStatus, MetadataPayload, SandboxSelfTest, WorkerErrorKind, WorkerJob, WorkerOp,
    WorkerResponse, MAX_EMBED_SOURCE_BYTES, MAX_WORKER_RESPONSE_BYTES,
};
```

`sidecar/src/worker/proto.rs`: the types exactly as specified in the interface block above.

`sidecar/src/limits.rs`: change the derive list on `ResourceLimits` to `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]` and add `use serde::{Deserialize, Serialize};`.

`sidecar/src/epub/metadata.rs`: add `Serialize, Deserialize` to the `EpubMetadata` derive list (it derives `Debug, Clone, PartialEq, Default` today).

`sidecar/src/pdf/parser.rs`: add `Serialize, Deserialize` to the `PdfBook` and `PdfMetadata` derive lists.

`sidecar/src/lib.rs`: add `pub mod worker;` after `pub mod services;`.

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml worker::proto`
Expected: four tests pass.

- [ ] **Step 5: Commit** — `feat(rust): define the document worker wire protocol`

### Task 2: Reader-based parse entry points (fd-ready, in-process)

The worker holds an fd, not a path. Split every parse entry point into a reader-based core plus a path wrapper. No behavior change; this makes the parse code callable from a `Read + Seek` source so Task 3 can drive it from fd 3. The PDF title fallback (file-stem humanization) cannot run in the worker because an fd has no name, so it moves out of the parse core into the path wrapper; the worker client reapplies it in Task 4.

**Files:**

- Modify: `sidecar/src/epub/parser.rs` (`parse_epub_reader`, `read_file_properties_reader`)
- Modify: `sidecar/src/epub/session.rs` (`build_session_reader`, `read_member_reader`)
- Modify: `sidecar/src/epub/writer.rs` (`rewrite_epub_bytes`)
- Modify: `sidecar/src/pdf/parser.rs` (`parse_pdf_bytes`, `read_file_properties_bytes`)
- Modify: `sidecar/src/pdf/render.rs` (`render_first_page_cover_bytes`)
- Modify: `sidecar/src/pdf/writer.rs` (`rewrite_pdf_bytes`)
- Test: the existing `#[cfg(test)]` modules plus `sidecar/tests/` stay green

**Interfaces produced (consumed by Tasks 3-5):**

```rust
// epub/parser.rs
pub fn parse_epub_reader<R: Read + Seek>(reader: BufReader<R>, limits: &ResourceLimits) -> Result<EpubBook, EpubError>;
pub fn parse_epub(path: &Path, limits: &ResourceLimits) -> Result<EpubBook, EpubError>; // wrapper
pub fn read_file_properties_reader<R: Read + Seek>(reader: BufReader<R>, limits: &ResourceLimits) -> Result<Vec<(String, String)>, EpubError>;
pub fn read_file_properties(path: &Path, limits: &ResourceLimits) -> Result<Vec<(String, String)>, EpubError>;
// epub/session.rs
pub fn build_session_reader<R: Read + Seek>(reader: BufReader<R>, limits: &ResourceLimits) -> Result<EpubReadingSession, EpubError>;
pub fn read_member_reader<R: Read + Seek>(reader: BufReader<R>, member: &str, limits: &ResourceLimits) -> Result<Option<Vec<u8>>, EpubError>;
// epub/writer.rs
pub fn rewrite_epub_bytes<R: Read + Seek>(reader: BufReader<R>, metadata: &EpubMetadata, limits: &ResourceLimits) -> Result<Vec<u8>, EpubError>;
// pdf/parser.rs
pub fn parse_pdf_bytes(bytes: &[u8], limits: &ResourceLimits) -> Result<PdfBook, PdfError>;
pub fn read_file_properties_bytes(bytes: &[u8], limits: &ResourceLimits) -> Result<Vec<(String, String)>, PdfError>;
// pdf/render.rs
pub fn render_first_page_cover_bytes(pdfium: &Pdfium, bytes: &[u8], limits: &ResourceLimits) -> Result<Option<Vec<u8>>, PdfError>;
// pdf/writer.rs
pub fn rewrite_pdf_bytes(bytes: &[u8], metadata: &PdfMetadata, limits: &ResourceLimits) -> Result<Vec<u8>, PdfError>;
```

- [ ] **Step 1: Write the failing tests**

Append to `epub/parser.rs` tests (`write_zip` and the `OPF` constant already exist there):

```rust
    #[test]
    fn parse_epub_reader_matches_parse_epub() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("equivalent.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                ("content.opf", OPF.as_bytes()),
            ],
        );
        let via_path = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let via_reader = parse_epub_reader(
            std::io::BufReader::new(std::io::Cursor::new(bytes)),
            &ResourceLimits::DEFAULTS,
        )
        .unwrap();
        assert_eq!(via_path.metadata.title, via_reader.metadata.title);
        assert_eq!(via_path.spine, via_reader.spine);
        assert_eq!(via_path.cover.is_some(), via_reader.cover.is_some());
    }

    #[test]
    fn read_member_reader_serves_the_same_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("member.epub");
        write_zip(
            &path,
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                ("META-INF/container.xml", b"<container/>".as_slice()),
            ],
        );
        let via_path = read_member(&path, "META-INF/container.xml", &ResourceLimits::DEFAULTS).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let via_reader = read_member_reader(
            std::io::BufReader::new(std::io::Cursor::new(bytes)),
            "META-INF/container.xml",
            &ResourceLimits::DEFAULTS,
        )
        .unwrap();
        assert_eq!(via_path, via_reader);
    }
```

Append to `pdf/parser.rs` tests (the `tests_support::build_pdf` helper already exists):

```rust
    #[test]
    fn parse_pdf_bytes_matches_parse_pdf() {
        let bytes = tests_support::build_pdf(&[("Title", "Reader Title")]);
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("equivalent.pdf");
        std::fs::write(&path, &bytes).unwrap();
        let via_path = parse_pdf(&path, &ResourceLimits::DEFAULTS).unwrap();
        let via_bytes = parse_pdf_bytes(&bytes, &ResourceLimits::DEFAULTS).unwrap();
        assert_eq!(via_path.metadata.title, "Reader Title");
        assert_eq!(via_bytes.metadata.title, "Reader Title");
    }

    #[test]
    fn parse_pdf_bytes_rejects_garbage() {
        let err = parse_pdf_bytes(b"not a pdf", &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, PdfError::Parse(_)), "got: {err:?}");
    }
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml parse_epub_reader parse_pdf_bytes`
Expected: compile failure, unresolved functions.

- [ ] **Step 3: Implement** each split mechanically:

- `epub/parser.rs`: move the body of `parse_epub` into `parse_epub_reader(reader: BufReader<R>, limits)` where `File::open(path)` + `BufReader::new(file)` are replaced by the passed reader; `parse_epub` becomes `parse_epub_reader(BufReader::new(File::open(path)?), limits)`. Same split for `read_file_properties` / `read_file_properties_reader`.
- `epub/session.rs`: same split for `build_session` / `read_member` into `build_session_reader` / `read_member_reader`; the internals (`check_archive_totals`, `read_mimetype`, `read_entry`, `parse_toc`) already take `R: Read + Seek` generics, so only the file opening moves into the wrappers.
- `epub/writer.rs`: move the body of `write_metadata` up to but excluding `crate::backup_file_once(path)?` into `rewrite_epub_bytes(reader, metadata, limits)` returning `buffer`; the internal reads take the `limits` parameter. `write_metadata(path, metadata)` becomes: `let buffer = rewrite_epub_bytes(BufReader::new(File::open(path)?), metadata, &ResourceLimits::DEFAULTS)?;` then `crate::backup_file_once(path)?;` `crate::atomic_replace(path, &buffer)?;`
- `pdf/parser.rs`: `parse_pdf_bytes(bytes, limits)` checks `limits.check_source_file(bytes.len() as u64)` and the `Deadline`, then loads with `Document::load_mem(bytes.to_vec())` (match lopdf 0.44's exact memory-loading signature), then runs the existing page-walk and metadata reads. The title fallback moves out of the core: the core returns the parsed title even when empty, and `parse_pdf(path, limits)` becomes `let mut book = parse_pdf_bytes(&std::fs::read(path)?, limits)?; if book.metadata.title.is_empty() { book.metadata.title = fallback_title(path); } Ok(book)`. `read_file_properties_bytes` mirrors this; its path wrapper reads the file after the size check.
- `pdf/render.rs`: `render_first_page_cover_bytes(pdfium: &Pdfium, bytes: &[u8], limits)` holds `RENDER_LOCK`, runs `limits.check_source_file(bytes.len() as u64)` and the deadline checks, loads with `pdfium.load_pdf_from_byte_slice(bytes, None)`, renders at `COVER_WIDTH_PX`, encodes PNG, and applies `check_cover_png`. `render_first_page_cover(path, ...)` keeps its probe logic, reads the file, and calls the bytes variant; Task 7 removes its last sidecar caller.
- `pdf/writer.rs`: `rewrite_pdf_bytes(bytes, metadata, limits)` = `limits.check_source_file(bytes.len() as u64)?` + `Document::load_mem(bytes.to_vec())` + the existing Info-dictionary edit + `save_to(&mut buffer)`, returning the buffer. `write_metadata(path, metadata)` reads the file, calls the bytes variant, then does `backup_file_once` + `atomic_replace`.

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml`
Expected: full suite passes unchanged plus the new equivalence tests.

- [ ] **Step 5: Commit** — `refactor(rust): split parse entry points into reader and path variants`

### Task 3: Worker binary, fd handoff, and the sidecar client

**Files:**

- Modify: `sidecar/Cargo.toml` (add `[[bin]]`)
- Create: `sidecar/src/worker_main.rs`
- Create: `sidecar/src/worker/client.rs`
- Modify: `sidecar/src/worker/mod.rs` (re-exports, `setup_parent_death_signal`, `run_job` stub)
- Modify: `sidecar/src/pdf/render.rs` (`probe_and_load`, extracted from the existing probe)
- Test: `sidecar/src/worker/client.rs` `mod tests`, `sidecar/tests/worker_handoff.rs`

**Cargo.toml addition** (after the existing `[lib]` section):

```toml
[[bin]]
name = "tuxbooks-worker"
path = "src/worker_main.rs"
```

**Interfaces produced (consumed by Tasks 4, 5, 7, 8):**

```rust
// sidecar/src/worker/client.rs
pub struct WorkerClient { binary_path: PathBuf }

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
    pub fn rpc_code(&self) -> i32;
}

impl WorkerClient {
    pub fn new(binary_path: PathBuf) -> Self;
    /// `TUXBOOKS_WORKER` override, then the executable's directory (packaged
    /// layout: the worker sits next to the sidecar), then the dev target dirs.
    pub fn locate() -> Result<Self, WorkerError>;
    /// Spawn, hand off `document` as fd 3, write the job line, read the one
    /// capped response under the wall-clock deadline, and reap the process.
    pub fn run(&self, job: &WorkerJob, document: &Path) -> Result<WorkerResponse, WorkerError>;
    /// Sandbox report from the real worker (Task 6 wires the enforcement).
    pub fn self_test(&self, limits: &ResourceLimits) -> Result<SandboxSelfTest, WorkerError>;
}

// sidecar/src/worker/mod.rs
/// Runs one job. `document` is None only for `SelfTest`; every parsing op
/// requires the fd handoff.
pub fn run_job(job: &WorkerJob, document: Option<&mut std::fs::File>) -> WorkerResponse;
```

- [ ] **Step 1: Write the failing tests** in `sidecar/src/worker/client.rs` `mod tests`:

```rust
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
        f.write_all(format!("#!/bin/sh\n{}\n", script_body).as_bytes()).unwrap();
        drop(f);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, WorkerClient::new(path))
    }

    fn self_test_job(limits: ResourceLimits) -> WorkerJob {
        WorkerJob { op: WorkerOp::SelfTest, limits, member: None, metadata: None, pdfium_dirs: Vec::new() }
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
        let (_sdir, client) = client_with("exit 3");
        let err = client
            .run(&self_test_job(ResourceLimits::DEFAULTS), &path)
            .unwrap_err();
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
```

`sidecar/tests/worker_handoff.rs` (integration, exercises the real binary):

```rust
//! The worker answers exactly one JSON response and exits (ADR 0001 D1/D2).
//! Proven with the real binary via CARGO_BIN_EXE, driving the SelfTest op
//! (which needs no document) so this test isolates the handoff itself.

use std::io::Write;
use std::os::unix::process::CommandExt;

use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::proto::{
    WorkerErrorKind, WorkerJob, WorkerOp, WorkerResponse,
};

fn command() -> std::process::Command {
    std::process::Command::new(env!("CARGO_BIN_EXE_tuxbooks-worker"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
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
    assert!(matches!(response, WorkerResponse::Done { .. }), "got: {response:?}");
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
    let mut command = command().pre_exec(|| {
        // Deterministically remove fd 3 (if any leaked into the child).
        unsafe { libc::close(3) };
        Ok(())
    });
    let response = run_job(command, &job);
    match response {
        WorkerResponse::Failed { kind, .. } => {
            assert!(matches!(kind, WorkerErrorKind::Worker), "got: {response:?}")
        }
        other => panic!("expected a typed failure, got: {other:?}"),
    }
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml worker`
Expected: compile failure (no client module items, no `tuxbooks-worker` bin).

- [ ] **Step 3: Implement**

`sidecar/src/worker/client.rs`:

```rust
//! Sidecar-side client for the one-shot document worker (ADR 0001 D1/D2):
//! spawn with fd-passing handoff and an empty environment, enforce the
//! wall-clock deadline by killing, and cap the response at
//! `MAX_WORKER_RESPONSE_BYTES`. Sync by design: every caller already runs
//! inside a blocking context (spawn_blocking or the import semaphore task).

use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::limits::ResourceLimits;
use crate::worker::proto::{
    SandboxSelfTest, WorkerErrorKind, WorkerJob, WorkerOp, WorkerResponse,
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
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/tuxbooks-worker"),
        );
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/tuxbooks-worker"),
        );
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
            .map_err(|err| WorkerError::Document(format!("{document}: {err}")))?;
        let fd = file.as_raw_fd();
        let mut child = Command::new(&self.binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env_clear()
            .pre_exec(move || {
                // Enforce the fd contract (W-7, ADR 0001 D2): everything
                // above 3 goes, then the document lands on fd 3. close_range
                // is Linux 5.9+, below the 5.13 sandbox floor; on other
                // unixes std's close-on-exec discipline is the documented
                // fallback. Failing closed here beats spawning with leaked
                // descriptors.
                #[cfg(target_os = "linux")]
                {
                    if libc::close_range(4, u32::MAX, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                if libc::dup2(fd, 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            })
            .spawn()
            .map_err(|err| WorkerError::Unavailable(format!("worker spawn: {err}")))?;
        // `file` stays open while the pre_exec closure may still run; the
        // drop after spawn closes only the parent's copy of the descriptor.
        drop(file);

        let job_line = serde_json::to_string(job)
            .map_err(|err| WorkerError::Protocol(err.to_string()))?;
        {
            let mut stdin = child.stdin.take().expect("piped stdin");
            stdin
                .write_all(job_line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .map_err(|err| WorkerError::Protocol(format!("job write: {err}")))?;
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
            let _ = child.kill();
            // M1: reap before returning, or the killed worker stays a
            // zombie for the lifetime of this process.
            let _ = child.wait();
            let _ = reader.join();
            WorkerError::Deadline
        })?;

        let status = child
            .wait()
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
            WorkerResponse::Failed { kind, message, limit } => Err(match kind {
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

    pub fn self_test(
        &self,
        limits: &ResourceLimits,
    ) -> Result<SandboxSelfTest, WorkerError> {
        let job = WorkerJob {
            op: crate::worker::proto::WorkerOp::SelfTest,
            limits: *limits,
            member: None,
            metadata: None,
            pdfium_dirs: Vec::new(),
        };
        match self.run(&job, Path::new("/dev/null"))? {
            WorkerResponse::Done { json: Some(value), .. } => serde_json::from_value(value)
                .map_err(|err| WorkerError::Protocol(err.to_string())),
            WorkerResponse::Done { .. } => {
                Err(WorkerError::Protocol("selftest returned no payload".to_string()))
            }
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }
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
```

Two residual-risk notes for this client sketch:

- The `child.wait()` after a well-formed response must stay bounded: a worker that wrote its response, closed stdout, and then hangs would otherwise block the client past the wall-clock budget on the wait. The implementer either escalates with a grace kill after a short grace period or uses a timed wait, so the total time past the deadline-kill is capped, not unbounded.
- `recvmsg`/`sendmsg` stay un-denied in the seccomp list, and that is acceptable: they operate on an existing socket fd, and since `socket`/`socketpair` are denied (and the fd contract leaves no inherited descriptors beyond 0-3, W-7), no socket fd can exist for them to touch.

`sidecar/src/worker/mod.rs` gains:

```rust
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
            format!("embed source is {len} bytes, over the {MAX_EMBED_SOURCE_BYTES} byte embed cap"),
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
```

`sidecar/src/worker_main.rs`:

```rust
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
    let document = if job.op == WorkerOp::SelfTest {
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
    let response = WorkerResponse::Failed { kind, message, limit: None };
    let line = serde_json::to_string(&response).expect("failure response serializes");
    let mut stdout = std::io::stdout().lock();
    // The Failed response is well-formed, so the C1 exit contract gives it 0.
    match writeln!(stdout, "{line}").and_then(|_| stdout.flush()) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}
```

`sidecar/src/pdf/render.rs` gains `probe_and_load(dirs: &[String])` (same probe order as the existing `pdfium()` helper, accepting `String` dirs from the job, caching into the existing `PDFIUM` `OnceLock`; a failed bind is silent here and surfaces as `Ok(None)`/render error at use time, matching today's behavior).

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml worker`
Expected: client supervision tests (deadline, crash, cap, locate) and both integration handoff tests pass.

- [ ] **Step 5: Commit** — `feat(rust): add the sandboxed document worker binary and client`

### Task 4: EPUB and PDF parse ops through the worker

**Files:**

- Modify: `sidecar/src/worker/mod.rs` (`run_job` real bodies)
- Modify: `sidecar/src/worker/client.rs` (typed wrappers)
- Modify: `sidecar/src/epub/parser.rs`, `sidecar/src/epub/session.rs`, `sidecar/src/pdf/parser.rs` (add `Serialize, Deserialize` to `EpubBook`, `CoverImage`, `EpubReadingSession`; `fallback_title` becomes `pub(crate)`)
- Modify: `sidecar/src/pdf/render.rs` (`loaded_pdfium()`, `pdfium_is_available(dirs)` extraction)
- Test: `sidecar/tests/worker_ops.rs`

**Interfaces produced (consumed by Task 7):**

```rust
impl WorkerClient {
    pub fn epub_parse(&self, document: &Path, limits: &ResourceLimits) -> Result<crate::epub::EpubBook, WorkerError>;
    pub fn epub_session(&self, document: &Path, limits: &ResourceLimits) -> Result<crate::epub::EpubReadingSession, WorkerError>;
    pub fn epub_member(&self, document: &Path, member: &str, limits: &ResourceLimits) -> Result<Option<Vec<u8>>, WorkerError>;
    pub fn pdf_parse(&self, document: &Path, limits: &ResourceLimits) -> Result<crate::pdf::PdfBook, WorkerError>;
    pub fn pdf_properties(&self, document: &Path, limits: &ResourceLimits) -> Result<Vec<(String, String)>, WorkerError>;
    pub fn pdf_cover(&self, document: &Path, pdfium_dirs: &[PathBuf], limits: &ResourceLimits) -> Result<Option<Vec<u8>>, WorkerError>;
}
```

- [ ] **Step 1: Write the failing tests** in `sidecar/tests/worker_ops.rs`:

```rust
//! End-to-end ops against the real worker binary (W-1, P-1): the sidecar
//! client spawns it, hands off the fixture, and gets typed results.

use std::path::PathBuf;

use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};

fn client() -> WorkerClient {
    WorkerClient::locate().expect("worker binary built by cargo test")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

#[test]
fn epub_parse_returns_the_fixture_book() {
    let book = client()
        .epub_parse(&fixture("minimal.epub"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!book.metadata.title.is_empty());
    assert!(!book.spine.is_empty());
}

#[test]
fn epub_session_returns_manifest_and_positions() {
    let session = client()
        .epub_session(&fixture("minimal.epub"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!session.manifest_json.is_empty());
    assert!(!session.positions_json.is_empty());
}

#[test]
fn epub_member_serves_a_member_and_misses_cleanly() {
    let hit = client()
        .epub_member(&fixture("minimal.epub"), "META-INF/container.xml", &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(hit.unwrap().starts_with(b"<"));
    let miss = client()
        .epub_member(&fixture("minimal.epub"), "no/such/file.xml", &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(miss.is_none());
}

#[test]
fn epub_parse_rejects_hostile_documents_with_typed_parse_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.epub");
    std::fs::write(&path, b"definitely not a zip archive").unwrap();
    let err = client()
        .epub_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
}

#[test]
fn epub_parse_enforces_the_job_quota_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("small.epub");
    std::fs::write(&path, vec![0u8; 200]).unwrap();
    let tight = ResourceLimits { max_source_file_bytes: 100, ..ResourceLimits::DEFAULTS };
    let err = client().epub_parse(&path, &tight).unwrap_err();
    assert!(matches!(err, WorkerError::Limit(_)), "got: {err:?}");
}

#[test]
fn pdf_parse_and_properties_return_the_fixture_metadata() {
    let book = client()
        .pdf_parse(&fixture("minimal.pdf"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!book.metadata.title.is_empty());
    let props = client()
        .pdf_properties(&fixture("minimal.pdf"), &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(!props.is_empty());
}

#[test]
fn pdf_parse_rejects_garbage_as_a_typed_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.pdf");
    std::fs::write(&path, b"not a pdf").unwrap();
    let err = client()
        .pdf_parse(&path, &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
}

#[test]
fn pdf_cover_renders_when_pdfium_is_available() {
    let dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium")];
    if !tuxbooks_lib::pdf::render::pdfium_is_available(&dirs) {
        eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)");
        return;
    }
    let cover = client()
        .pdf_cover(&fixture("minimal.pdf"), &dirs, &ResourceLimits::DEFAULTS)
        .unwrap();
    assert!(cover.is_some(), "minimal.pdf should render a cover");
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml --test worker_ops`
Expected: compile failure, no `epub_parse`/`pdf_cover` wrappers.

- [ ] **Step 3: Implement**

`sidecar/src/worker/mod.rs` replaces the stub with the real engine:

```rust
use crate::limits::ResourceLimits;
use crate::worker::proto::{
    LandlockStatus, MetadataPayload, SandboxSelfTest, WorkerErrorKind, WorkerJob, WorkerOp,
    WorkerResponse,
};

/// One failed job inside the worker, mapped onto the wire's Failed shape.
struct JobError {
    kind: WorkerErrorKind,
    message: String,
    limit: Option<&'static str>,
}

impl JobError {
    fn parse(message: String) -> Self {
        Self { kind: WorkerErrorKind::Parse, message, limit: None }
    }
    fn worker(message: String) -> Self {
        Self { kind: WorkerErrorKind::Worker, message, limit: None }
    }
}

impl From<crate::epub::EpubError> for JobError {
    fn from(err: crate::epub::EpubError) -> Self {
        match err {
            crate::epub::EpubError::Limit(limit) => Self {
                kind: WorkerErrorKind::Limit,
                message: limit.to_string(),
                limit: Some(limit.limit),
            },
            other => Self::parse(other.to_string()),
        }
    }
}

impl From<crate::pdf::PdfError> for JobError {
    fn from(err: crate::pdf::PdfError) -> Self {
        match err {
            crate::pdf::PdfError::Limit(limit) => Self {
                kind: WorkerErrorKind::Limit,
                message: limit.to_string(),
                limit: Some(limit.limit),
            },
            other => Self::parse(other.to_string()),
        }
    }
}

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
    Ok(WorkerResponse::Done { json: Some(value), bytes_b64: None })
}

fn done_bytes(bytes: Vec<u8>) -> Result<WorkerResponse, JobError> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(WorkerResponse::Done { json: None, bytes_b64: Some(b64) })
}

fn done_optional_bytes(bytes: Option<Vec<u8>>) -> Result<WorkerResponse, JobError> {
    match bytes {
        Some(bytes) => done_bytes(bytes),
        None => Ok(WorkerResponse::Done { json: None, bytes_b64: None }),
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
    limits
        .check_source_file(len)
        .map_err(|limit| JobError {
            kind: WorkerErrorKind::Limit,
            message: limit.to_string(),
            limit: Some(limit.limit),
        })?;
    let mut bytes = Vec::new();
    document
        .take(limits.max_source_file_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|err| JobError::parse(err.to_string()))?;
    if bytes.len() as u64 > limits.max_source_file_bytes {
        return Err(JobError {
            kind: WorkerErrorKind::Limit,
            message: "source exceeded max_source_file_bytes".to_string(),
            limit: Some("max_source_file_bytes"),
        });
    }
    document
        .rewind()
        .map_err(|err| JobError::parse(err.to_string()))?;
    Ok(bytes)
}

fn dispatch(
    job: &WorkerJob,
    document: &mut std::fs::File,
) -> Result<WorkerResponse, JobError> {
    let limits = &job.limits;
    match job.op {
        WorkerOp::EpubParse => {
            let book =
                crate::epub::parse_epub_reader(std::io::BufReader::new(&*document), limits)?;
            done_json(serde_json::to_value(book).map_err(|err| JobError::worker(err.to_string()))?)
        }
        WorkerOp::EpubSession => {
            let session =
                crate::epub::build_session_reader(std::io::BufReader::new(&*document), limits)?;
            done_json(serde_json::to_value(session).map_err(|err| JobError::worker(err.to_string()))?)
        }
        WorkerOp::EpubMember => {
            let member = job
                .member
                .as_deref()
                .ok_or_else(|| JobError::worker("epub_member requires a member path".to_string()))?;
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
            let pdfium = crate::pdf::render::loaded_pdfium().ok_or_else(|| {
                JobError::parse("pdfium library is unavailable".to_string())
            })?;
            let cover =
                crate::pdf::render::render_first_page_cover_bytes(&pdfium, &bytes, limits)?;
            done_optional_bytes(cover)
        }
        WorkerOp::SelfTest | WorkerOp::EpubEmbed | WorkerOp::PdfEmbed => Err(
            JobError::worker(format!("op {:?} is not wired in this task", job.op)),
        ),
    }
}
```

(`SelfTest` never reaches `dispatch`; it is answered in `run_job`. The two embed arms are stubbed with a typed failure until Task 5.)

Typed wrappers in `client.rs` (the member wrapper shows the pattern; the others follow it exactly):

```rust
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
            WorkerResponse::Done { bytes_b64: Some(b64), .. } => Ok(Some(
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|err| WorkerError::Protocol(err.to_string()))?,
            )),
            WorkerResponse::Done { bytes_b64: None, .. } => Ok(None),
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }

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
            WorkerResponse::Done { json: Some(value), .. } => serde_json::from_value(value)
                .map_err(|err| WorkerError::Protocol(err.to_string())),
            WorkerResponse::Done { json: None, .. } => {
                Err(WorkerError::Protocol("epub_parse returned no payload".to_string()))
            }
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }
```

(`epub_session`, `pdf_parse`, `pdf_properties` decode `json` the same way; `pdf_properties` decodes `Vec<(String, String)>`. `pdf_parse` applies the filename fallback after decoding, reusing `crate::pdf::parser::fallback_title` made `pub(crate)` in this task: `if book.metadata.title.is_empty() { book.metadata.title = fallback_title(document); }`. `pdf_cover` takes `pdfium_dirs: &[PathBuf]`, converts to `Vec<String>` for the job, and decodes optional base64 like `epub_member`.)

`pdf/render.rs`: extract `pub fn loaded_pdfium() -> Option<&'static Pdfium>` and `pub fn pdfium_is_available(dirs: &[PathBuf]) -> bool` from the existing probe (shared by the worker and tests; `render_first_page_cover` keeps its behavior).

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml --test worker_ops`
Expected: all worker_ops tests pass (the PDF cover test skips with a notice when PDFium is unfetched).

- [ ] **Step 5: Commit** — `feat(rust): run epub and pdf parsing inside the document worker`

### Task 5: Embed ops: the worker rewrites, the sidecar writes

The metadata embed is parse-heavy and write-light. The worker reads the document and returns the full rewritten bytes (bounded by the source quota and the 2 GiB response cap); the sidecar keeps `backup_file_once` + `atomic_replace`, the only write authority. This keeps W-5 literal: the worker touches the filesystem only by reading fd 3.

**Files:**

- Modify: `sidecar/src/worker/mod.rs` (`dispatch` arms `EpubEmbed`, `PdfEmbed`; the stub catch-all shrinks to `SelfTest` only)
- Modify: `sidecar/src/worker/client.rs` (`epub_embed`, `pdf_embed`)
- Test: `sidecar/tests/worker_embed.rs`

**Interfaces produced (consumed by Task 7):**

```rust
impl WorkerClient {
    pub fn epub_embed(&self, document: &Path, metadata: &crate::epub::EpubMetadata, limits: &ResourceLimits) -> Result<Vec<u8>, WorkerError>;
    pub fn pdf_embed(&self, document: &Path, metadata: &crate::pdf::PdfMetadata, limits: &ResourceLimits) -> Result<Vec<u8>, WorkerError>;
}
```

- [ ] **Step 1: Write the failing tests** in `sidecar/tests/worker_embed.rs`:

```rust
//! Embed round trip through the real worker: bytes in, rewritten bytes out.
//! The sidecar-side write (backup + atomic replace) is exercised by the
//! existing metadata service tests once Task 7 flips the callers.

use std::path::PathBuf;

use tuxbooks_lib::epub::EpubMetadata;
use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};

fn client() -> WorkerClient {
    WorkerClient::locate().expect("worker binary built by cargo test")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

fn metadata(title: &str) -> EpubMetadata {
    EpubMetadata {
        title: title.to_string(),
        subtitle: None,
        author: Some("A. Author".to_string()),
        authors: vec!["A. Author".to_string()],
        subjects: Vec::new(),
        language: Some("en".to_string()),
        publisher: None,
        isbn: None,
        description: None,
        publication_date: None,
        series: None,
        series_index: None,
    }
}

#[test]
fn epub_embed_returns_a_valid_epub_with_new_metadata() {
    let rewritten = client()
        .epub_embed(&fixture("minimal.epub"), &metadata("Rewritten Title"), &ResourceLimits::DEFAULTS)
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rewritten.epub");
    std::fs::write(&path, &rewritten).unwrap();
    let book = tuxbooks_lib::epub::parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap();
    assert_eq!(book.metadata.title, "Rewritten Title");
    assert!(book.metadata.authors.contains(&"A. Author".to_string()));
    // The rewrite preserves the document's spine, not just its metadata.
    assert!(!book.spine.is_empty());
}

#[test]
fn embed_rejects_a_hostile_document_instead_of_rewriting_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.epub");
    std::fs::write(&path, b"definitely not a zip archive").unwrap();
    let err = client()
        .epub_embed(&path, &metadata("x"), &ResourceLimits::DEFAULTS)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Parse(_)), "got: {err:?}");
}

#[test]
fn embed_sources_over_the_cap_are_refused_without_reading() {
    // I2: source + rewrite + base64 must fit the address-space rlimit
    // together, so oversized embeds are refused up front with a typed
    // limit error naming the cap.
    let (limit, _) = tuxbooks_lib::worker::embed_source_error(513 << 20)
        .expect("513 MiB exceeds the embed cap");
    assert_eq!(limit, "max_embed_source_bytes");
    assert!(tuxbooks_lib::worker::embed_source_error(511 << 20).is_none());
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml --test worker_embed`
Expected: compile failure, no `epub_embed` wrapper.

- [ ] **Step 3: Implement**

`dispatch` gains the two arms and drops the embed stubs from the catch-all:

```rust
        WorkerOp::EpubEmbed => match &job.metadata {
            Some(MetadataPayload::Epub(metadata)) => {
                enforce_embed_cap(document)?;
                done_bytes(
                    crate::epub::rewrite_epub_bytes(
                        std::io::BufReader::new(&*document),
                        metadata,
                        limits,
                    )?,
                )
            }
            _ => Err(JobError::worker("epub_embed requires epub metadata".to_string())),
        },
        WorkerOp::PdfEmbed => match &job.metadata {
            Some(MetadataPayload::Pdf(metadata)) => {
                enforce_embed_cap(document)?;
                let bytes = read_fd_bounded(document, limits)?;
                let rewritten = crate::pdf::rewrite_pdf_bytes(&bytes, metadata, limits)?;
                // I2: halve the peak before the base64 copy is allocated.
                drop(bytes);
                done_bytes(rewritten)
            }
            _ => Err(JobError::worker("pdf_embed requires pdf metadata".to_string())),
        },
```

(the catch-all arm shrinks to `WorkerOp::SelfTest` only, which never reaches `dispatch` anyway).

The embed cap helper, next to `embed_source_error` in `worker/mod.rs` (I2: a 1 GiB embed would need source + rewrite + base64, about 3.4 GiB against the 3 GiB `RLIMIT_AS`; the cap refuses such jobs up front with a typed limit error instead of an allocator abort that would surface as a crash):

```rust
fn enforce_embed_cap(document: &std::fs::File) -> Result<(), JobError> {
    let len = document
        .metadata()
        .map_err(|err| JobError::parse(err.to_string()))?
        .len();
    match embed_source_error(len) {
        Some((limit, message)) => Err(JobError {
            kind: WorkerErrorKind::Limit,
            message,
            limit: Some(limit),
        }),
        None => Ok(()),
    }
}
```

`client.rs` wrappers (same shape as `epub_parse`, `bytes_b64` required):

```rust
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
            WorkerResponse::Done { bytes_b64: Some(b64), .. } => {
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|err| WorkerError::Protocol(err.to_string()))
            }
            WorkerResponse::Done { bytes_b64: None, .. } => {
                Err(WorkerError::Protocol("epub_embed returned no bytes".to_string()))
            }
            WorkerResponse::Failed { .. } => unreachable!("run() maps Failed to Err"),
        }
    }
```

(`pdf_embed` mirrors it with `MetadataPayload::Pdf(metadata.clone())`.)

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml`
Expected: full suite green including the embed tests.

- [ ] **Step 5: Commit** — `feat(rust): move metadata rewrites into the document worker`

### Task 6: The sandbox module: Landlock, seccomp, rlimits, self-verification

**Files:**

- Create: `sidecar/src/worker/sandbox.rs`
- Modify: `sidecar/src/worker/mod.rs` (add `pub mod sandbox;`)
- Modify: `sidecar/src/worker/mod.rs` `self_test_response` (real observations replace the Task 4 literals)
- Modify: `sidecar/src/worker_main.rs` (call `sandbox::prepare` between the PDFium preload and fd opening)
- Test: tests in `sidecar/src/worker/sandbox.rs` + `sidecar/tests/worker_sandbox.rs`

**Interfaces produced:**

```rust
// sidecar/src/worker/sandbox.rs
pub struct SandboxReport {
    pub landlock: LandlockStatus,
    pub seccomp_applied: bool,
    pub rlimits_applied: bool,
    pub verified: bool,
}

/// Probe without applying (used by the SelfTest op and by tests to skip).
pub fn landlock_abi() -> LandlockStatus;
pub fn landlock_supported() -> bool;
pub fn probe_socket_denied() -> bool;

/// The pure fail-closed decision, testable on any kernel without applying
/// anything: an unsupported Linux kernel must refuse to parse.
pub fn check(status: &LandlockStatus) -> Result<(), String>;

/// Applies the full stack for one job. Linux: Landlock (fail closed via
/// `check`), seccomp deny-list, rlimits, self-verification. Other platforms:
/// Ok with NotApplicable and verified = true (process isolation is the
/// documented floor, ADR 0001). Never called from tests.
pub fn prepare(limits: &ResourceLimits) -> Result<SandboxReport, String>;
```

**Fixed startup order (ADR 0001 D3):** PDEATHSIG (already in `worker_main`) then, inside `prepare`: `prctl(PR_SET_NO_NEW_PRIVS)`, Landlock apply (all FS access denied; filesystem only, no network handling), seccomp deny-list, rlimits (`RLIMIT_CPU` soft = `max_parse_seconds`, hard = +5 s; `RLIMIT_AS` = `WORKER_ADDRESS_SPACE_CAP` = 3 GiB; `RLIMIT_FSIZE` = 0, the worker writes no files), self-verification (attempt `open("/proc/self/status")` expecting denial; attempt `socket(AF_INET, SOCK_STREAM)` expecting denial). PDFium loading happens in `worker_main` before `prepare` (D3 ordering), so `prepare` never needs the filesystem.

**Seccomp deny-list** (classic BPF, action `SECCOMP_RET_ERRNO | EPERM`, default `SECCOMP_RET_ALLOW`, syscall numbers from `libc` `SYS_*` constants, arch-checked against `AUDIT_ARCH_X86_64` / `AUDIT_ARCH_AARCH64` by build target): `execve`, `execveat`, `fork`, `vfork`, `clone`/`clone3` where the flag word carries any of `CLONE_NEWNS | CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS` (plain thread clones pass), `unshare`, `setns`, `mount`, `umount2`, `ptrace`, `bpf`, `keyctl`, `kexec_load`, `kexec_file_load`, `open_by_handle_at`, `name_to_handle_at`, `reboot`, `swapon`, `swapoff`, `init_module`, `finit_module`, `delete_module`; and `socket`, `socketpair`, `connect`, `bind`, `listen`, `accept`, `accept4`, `sendto`, `recvfrom` unconditionally. Denying `socket` outright is what owns W-3: one rule closes TCP, UDP, AF_UNIX, and netlink creation on every supported kernel, which is why Landlock's network ABI (TCP bind/connect only, kernel 6.7+) was dropped.

- [ ] **Step 1: Write the failing tests**

In `sidecar/src/worker/sandbox.rs` (pure logic and thread-scoped enforcement; no filter is ever installed in the test process):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::proto::LandlockStatus;

    #[test]
    fn unsupported_landlock_fails_closed() {
        assert!(check(&LandlockStatus::Unsupported).is_err());
        assert!(check(&LandlockStatus::Applied { abi: 4 }).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn handled_fs_bits_track_the_probed_abi() {
        // C2 pin: handled bits grow only with the ABI the kernel reported,
        // so an older kernel never handles an access bit it cannot enforce.
        let abi1 = fs_bits(1);
        assert_eq!(abi1 & (1 << 13), 0, "REFER is ABI 2+");
        let abi2 = fs_bits(2);
        assert_ne!(abi2 & (1 << 13), 0);
        assert_eq!(abi2 & (1 << 14), 0, "TRUNCATE is ABI 3+");
        assert_eq!(fs_bits(3) & (1 << 14), 1 << 14);
        assert_eq!(fs_bits(5) & (1 << 15), 1 << 15, "IOCTL_DEV is ABI 5+");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn landlock_ruleset_attr_is_fs_only_so_no_e2big_negotiation_exists() {
        // C2 pin: the attribute is the 8-byte fs-only struct every
        // Landlock kernel accepts. The 16-byte struct with
        // handled_access_net is rejected with E2BIG on kernels below 6.7,
        // which is one reason the network bits are gone.
        assert_eq!(
            std::mem::size_of::<landlock_ffi::LandlockRulesetAttr>(),
            std::mem::size_of::<u64>()
        );
    }
    #[test]
    fn landlock_denies_open_in_the_applying_thread() {
        if !landlock_supported() {
            eprintln!("skipping: kernel lacks Landlock (5.13+)");
            return;
        }
        // Landlock is thread-scoped: this restriction affects this test's
        // thread only, never sibling tests. The scratch dir is created
        // first; tempfile's Drop tolerates a denied unlink at teardown.
        let scratch = tempfile::tempdir().unwrap();
        let readable = scratch.path().join("before.txt");
        std::fs::write(&readable, b"ok").unwrap();
        apply_landlock_deny_all().expect("landlock applies");
        assert!(
            std::fs::read(&readable).is_err(),
            "landlock must deny filesystem reads, even on pre-existing paths"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn seccomp_denies_socket_creation() {
        // A seccomp filter is process-wide and irreversible, and the test
        // process is multithreaded: the BPF program is built BEFORE the
        // fork (M2), so the forked child only runs async-signal-safe
        // syscalls (install, socket, _exit).
        if !landlock_supported() {
            eprintln!("skipping: sandbox layer only meaningful on supported kernels");
            return;
        }
        let program = build_seccomp_program();
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            if install_seccomp_program(&program).is_err() {
                unsafe { libc::_exit(2) };
            }
            let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
            let denied = fd == -1 && unsafe { *libc::__errno_location() } == libc::EPERM;
            unsafe { libc::_exit(if denied { 0 } else { 1 }) };
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(
            unsafe { libc::WIFEXITED(status) } && unsafe { libc::WEXITSTATUS(status) } == 0,
            "socket() must be denied under the filter"
        );
    }
}
```

In `sidecar/tests/worker_sandbox.rs` (real binary, kernel-gated like PDFium):

```rust
//! Sandbox enforcement proofs (W-2/W-3/W-4/W-5/W-10) against the real
//! worker. When the kernel lacks Landlock the tests skip with a notice,
//! mirroring the PDFium convention; production still fails closed there.

use tuxbooks_lib::limits::ResourceLimits;
use tuxbooks_lib::worker::client::{WorkerClient, WorkerError};
use tuxbooks_lib::worker::proto::{LandlockStatus, WorkerJob, WorkerOp};

fn client() -> WorkerClient {
    WorkerClient::locate().expect("worker binary built by cargo test")
}

fn self_test_job() -> WorkerJob {
    WorkerJob {
        op: WorkerOp::SelfTest,
        limits: ResourceLimits::DEFAULTS,
        member: None,
        metadata: None,
        pdfium_dirs: Vec::new(),
    }
}

#[test]
fn selftest_reports_denials_when_landlock_is_supported() {
    if !tuxbooks_lib::worker::sandbox::landlock_supported() {
        eprintln!("skipping: kernel lacks Landlock (5.13+)");
        return;
    }
    let report = client().self_test(&ResourceLimits::DEFAULTS).expect("selftest succeeds");
    assert!(matches!(report.landlock, LandlockStatus::Applied { .. }));
    assert!(report.open_denied, "worker must observe its own FS denial");
    assert!(report.socket_denied, "worker must observe its own network denial");
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
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml sandbox`
Expected: compile failure, no `sandbox` module items (`check`, `apply_landlock_deny_all`, `build_seccomp_program`, `install_seccomp_program` missing).

- [ ] **Step 3: Implement** `sidecar/src/worker/sandbox.rs`:

```rust
//! The worker's own OS containment (ADR 0001 D3, W-2..W-5, W-10, W-11).
//! Three dependency-free layers applied by the worker itself, then proven:
//! Landlock (all filesystem access denied; filesystem only), a seccomp
//! classic-BPF deny-list (exec/spawn/namespaces/debug syscalls, plus socket
//! creation unconditionally: TCP, UDP, AF_UNIX, and netlink in one rule),
//! and rlimits. Self-verification closes the loop: if the probes do not
//! observe the claimed denials, the job fails with a typed sandbox error.
//! Nothing here is root-required or display-dependent; all of it is
//! testable headless in CI. Landlock is thread-scoped; seccomp is
//! process-wide, which is why tests exercise seccomp only in forked
//! children, with the program built before the fork.

use std::fs::File;

use crate::limits::ResourceLimits;
use crate::worker::proto::LandlockStatus;

/// Address-space ceiling for one job (W-8): headroom over the 2 GiB
/// total-uncompressed quota plus parser and PDFium working set. Embed
/// sources are additionally capped at `MAX_EMBED_SOURCE_BYTES` so the
/// source, the rewritten document, and the base64 output fit together.
pub const WORKER_ADDRESS_SPACE_CAP: u64 = 3 << 30;

/// The pure fail-closed decision: Linux parses nothing without Landlock.
pub fn check(status: &LandlockStatus) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        match status {
            LandlockStatus::Unsupported => Err(
                "Landlock is unavailable on this kernel; refusing to parse without the sandbox layer"
                    .to_string(),
            ),
            _ => Ok(()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = status;
        Ok(())
    }
}

pub fn prepare(limits: &ResourceLimits) -> Result<SandboxReport, String> {
    let status = if cfg!(target_os = "linux") { landlock_abi() } else { LandlockStatus::NotApplicable };
    check(&status)?;
    // 1. PR_SET_NO_NEW_PRIVS: required by Landlock's restrict_self and by
    //    seccomp; also prevents privilege escalation through exec.
    set_no_new_privs()?;
    // 2. Landlock deny-all: every handled FS access is denied because the
    //    ruleset carries zero rules. Filesystem only; the network is
    //    seccomp's job (see below).
    let landlock = if cfg!(target_os = "linux") {
        apply_landlock_deny_all().map_err(|err| format!("landlock: {err}"))?
    } else {
        LandlockStatus::NotApplicable
    };
    // 3. seccomp deny-list: exec/spawn/namespaces/debug syscalls, and
    //    socket creation unconditionally (owns W-3 on every kernel).
    let seccomp_applied = install_seccomp()?;
    // 4. rlimits: CPU, address space, no file writes (Linux; the report
    //    records honestly what applied on each platform).
    let rlimits_applied = apply_rlimits(limits)?;
    // 5. self-verification: the probes must observe the claimed denials.
    let report = SandboxReport {
        landlock,
        seccomp_applied,
        rlimits_applied,
        verified: false,
    };
    self_verify(&report)?;
    Ok(SandboxReport { verified: true, ..report })
}

pub fn landlock_abi() -> LandlockStatus {
    #[cfg(target_os = "linux")]
    {
        match probe_landlock_abi() {
            Some(abi) => LandlockStatus::Applied { abi },
            None => LandlockStatus::Unsupported,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        LandlockStatus::NotApplicable
    }
}

pub fn landlock_supported() -> bool {
    !matches!(landlock_abi(), LandlockStatus::Unsupported)
}

pub fn probe_socket_denied() -> bool {
    #[cfg(target_os = "linux")]
    {
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
        if fd == -1 {
            return unsafe { *libc::__errno_location() } == libc::EPERM;
        }
        unsafe { libc::close(fd) };
        false
    }
    #[cfg(not(target_os = "linux"))]
    {
        // No sandbox layer claims network denial off Linux.
        false
    }
}

pub fn self_verify(report: &SandboxReport) -> Result<(), String> {
    if matches!(report.landlock, LandlockStatus::Applied { .. }) {
        if File::open("/proc/self/status").is_ok() {
            return Err("self-verification failed: filesystem denial not in effect".to_string());
        }
    }
    // C3: socket denial is claimed whenever seccomp applied (always on
    // Linux), so the probe must observe it unconditionally. There is no
    // ABI-4 branch left to disagree with the layering.
    if report.seccomp_applied && !probe_socket_denied() {
        return Err("self-verification failed: network denial not in effect".to_string());
    }
    Ok(())
}

pub fn apply_rlimits(limits: &ResourceLimits) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        use libc::{rlimit, setrlimit, RLIMIT_AS, RLIMIT_CPU, RLIMIT_FSIZE};
        let set = |resource: libc::__rlimit_resource_t, cur: u64, max: u64| {
            let value = rlimit { rlim_cur: cur, rlim_max: max };
            let rc = unsafe { setrlimit(resource, &value) };
            if rc == -1 {
                Err(format!("setrlimit({resource}) failed: {}", std::io::Error::last_os_error()))
            } else {
                Ok(())
            }
        };
        let cpu = limits.max_parse_seconds;
        set(RLIMIT_CPU, cpu, cpu.saturating_add(5))?;
        set(RLIMIT_AS, WORKER_ADDRESS_SPACE_CAP, WORKER_ADDRESS_SPACE_CAP)?;
        set(RLIMIT_FSIZE, 0, 0)?;
        Ok(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // No rlimit enforcement off Linux; the report says so.
        let _ = limits;
        Ok(false)
    }
}

fn set_no_new_privs() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        const PR_SET_NO_NEW_PRIVS: libc::c_int = 38;
        let rc = unsafe { libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
        if rc == -1 {
            Err(format!("PR_SET_NO_NEW_PRIVS: {}", std::io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // prctl does not exist off Linux; nothing to set there.
        Ok(())
    }
}

// ---- Landlock FFI (linux/landlock.h) ---------------------------------------
//
// ABI probe: landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)
// returns the ABI version, or -1 with EOPNOTSUPP/EINVAL on pre-5.13 kernels.
// Apply: create a ruleset whose handled_access_fs carries the FS bits the
// probed ABI supports, add ZERO rules, then
// landlock_restrict_self(ruleset_fd, 0): every handled access is denied.
// C2: the ruleset attribute is the fs-only 8-byte struct the UAPI has had
// since 5.13 on every supported kernel. The 16-byte struct with
// handled_access_net (6.7+) is deliberately not used: pre-6.7 kernels
// reject larger attribute sizes with E2BIG, and the network is seccomp's
// job anyway. Syscall numbers come from libc's SYS_landlock_* constants.

#[cfg(target_os = "linux")]
mod landlock_ffi {
    // repr(C) mirror of the UAPI struct (libc does not ship landlock.h).
    // fs-only: exactly one u64, so no attr-size negotiation can ever occur.
    #[repr(C)]
    pub struct LandlockRulesetAttr {
        pub handled_access_fs: u64,
    }

    // LANDLOCK_ACCESS_FS bits (UAPI, stable): EXECUTE(0), WRITE_FILE(1),
    // READ_FILE(2), READ_DIR(3), REMOVE_DIR(4), REMOVE_FILE(5), MAKE_CHAR(6),
    // MAKE_DIR(7), MAKE_REG(8), MAKE_SOCK(9), MAKE_FIFO(10), MAKE_BLOCK(11),
    // MAKE_SYM(12); ABI 2 adds REFER(13); ABI 3 adds TRUNCATE(14); ABI 5
    // adds IOCTL_DEV(15). Handled bits are chosen from the probed ABI so an
    // older kernel never handles an access bit it cannot enforce.
    pub fn fs_bits(abi: u32) -> u64 {
        let mut bits = 0x1FFFu64; // EXECUTE .. MAKE_SYM (bits 0..12)
        if abi >= 2 {
            bits |= 1 << 13; // REFER
        }
        if abi >= 3 {
            bits |= 1 << 14; // TRUNCATE
        }
        if abi >= 5 {
            bits |= 1 << 15; // IOCTL_DEV
        }
        bits
    }

    pub const CREATE_RULESET_VERSION: u32 = 1 << 0;

    pub fn probe_abi() -> Option<u32> {
        let rc = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<libc::c_void>(),
                0,
                CREATE_RULESET_VERSION,
            )
        };
        if rc < 0 {
            None
        } else {
            Some(rc as u32)
        }
    }

    pub fn restrict_all(abi: u32) -> Result<(), String> {
        let attr = LandlockRulesetAttr {
            handled_access_fs: fs_bits(abi),
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr as *const LandlockRulesetAttr,
                std::mem::size_of::<LandlockRulesetAttr>(),
                0u32,
            )
        };
        if fd < 0 {
            return Err(format!(
                "create_ruleset: {}",
                std::io::Error::last_os_error()
            ));
        }
        let rc = unsafe { libc::syscall(libc::SYS_landlock_restrict_self, fd as i32, 0u32) };
        // The ruleset fd is consumed by restrict_self; close it either way.
        unsafe { libc::close(fd as i32) };
        if rc < 0 {
            Err(format!(
                "restrict_self: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
fn probe_landlock_abi() -> Option<u32> {
    landlock_ffi::probe_abi()
}

#[cfg(target_os = "linux")]
fn apply_landlock_deny_all() -> Result<LandlockStatus, String> {
    let status = landlock_abi();
    if let LandlockStatus::Applied { abi } = status {
        landlock_ffi::restrict_all(abi)?;
    }
    Ok(status)
}

#[cfg(not(target_os = "linux"))]
fn apply_landlock_deny_all() -> Result<LandlockStatus, String> {
    Ok(LandlockStatus::NotApplicable)
}

// ---- seccomp classic BPF ----------------------------------------------------
//
// Program shape: load the arch word, deny everything on a foreign arch, load
// the syscall number, one compare-and-deny pair per denied syscall (with the
// clone flag check inlined for clone), then RET_ALLOW. Jump offsets are
// computed from the instruction vector so the arithmetic cannot drift.
// Building the program (a plain Vec) and installing it (a syscall) are split
// (M2): the forked test child must not allocate, so it receives a program
// built before the fork.

#[cfg(target_os = "linux")]
fn install_seccomp() -> Result<bool, String> {
    let program = build_seccomp_program();
    install_seccomp_program(&program)?;
    Ok(true)
}

#[cfg(not(target_os = "linux"))]
fn install_seccomp() -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "linux")]
fn build_seccomp_program() -> Vec<sock_filter> {
    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_JSET: u16 = 0x40;
    const BPF_RET: u16 = 0x06;
    const BPF_K: u16 = 0x00;
    // seccomp_data layout (UAPI, stable): nr(0), arch(4), ip(8), args[0](16).
    const OFFSET_NR: u32 = 0;
    const OFFSET_ARCH: u32 = 4;
    const OFFSET_ARG0: u32 = 16;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const EPERM: u32 = 1;

    /// repr(C) mirror of the UAPI `sock_filter` (libc does not ship it).
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct sock_filter {
        pub code: u16,
        pub jt: u8,
        pub jf: u8,
        pub k: u32,
    }
    #[repr(C)]
    struct sock_fprog {
        len: u16,
        filter: *const sock_filter,
    }

    let instr = |code: u16, jt: u8, jf: u8, k: u32| sock_filter { code, jt, jf, k };
    let load = |offset: u32| instr(BPF_LD | BPF_W | BPF_ABS, 0, 0, offset);
    let ret = |value: u32| instr(BPF_RET | BPF_K, 0, 0, value);
    let ret_eperm = ret(SECCOMP_RET_ERRNO | EPERM);
    let ret_allow = ret(SECCOMP_RET_ALLOW);
    let audit_arch: u32 = if cfg!(target_arch = "aarch64") { 0xC000_00B7 } else { 0xC000_003E };

    let denied = [
        libc::SYS_execve,
        libc::SYS_execveat,
        // x86_64 only: aarch64 has no fork/vfork syscalls (glibc emulates
        // them through clone), so those two constants are gated on
        // cfg!(target_arch = "x86_64") in the real array.
        libc::SYS_fork,
        libc::SYS_vfork,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_keyctl,
        libc::SYS_kexec_load,
        libc::SYS_kexec_file_load,
        libc::SYS_open_by_handle_at,
        libc::SYS_name_to_handle_at,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
    ];
    // CLONE_NEWNS | CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWPID |
    // CLONE_NEWIPC | CLONE_NEWUTS
    const NS_FLAGS: u64 = 0x0002_0000 | 0x1000_0000 | 0x4000_0000 | 0x2000_0000 | 0x0800_0000 | 0x0400_0000;
    const CLONE: i64 = libc::SYS_clone as i64;
    const CLONE3: i64 = libc::SYS_clone3 as i64;

    let mut program = vec![load(OFFSET_ARCH)];
    program.push(instr(BPF_JMP | BPF_JEQ, 1, 0, audit_arch)); // match -> skip EPERM
    program.push(ret_eperm);
    program.push(load(OFFSET_NR));
    for syscall in denied {
        program.push(instr(BPF_JMP | BPF_JEQ, 0, 1, syscall as u32));
        program.push(ret_eperm);
    }
    // clone/clone3: deny only when the flag word carries namespace bits.
    for syscall in [CLONE, CLONE3] {
        program.push(instr(BPF_JMP | BPF_JEQ, 0, 3, syscall as u32));
        program.push(load(OFFSET_ARG0));
        program.push(instr(BPF_JMP | BPF_JSET, 0, 1, NS_FLAGS as u32));
        program.push(ret_eperm);
    }
    // C3: socket denial is unconditional. One rule closes TCP, UDP,
    // AF_UNIX, and netlink creation, which owns W-3 on every supported
    // kernel; there is no Landlock-network conditional to disagree with.
    for syscall in [
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_accept,
        libc::SYS_accept4,
        libc::SYS_sendto,
        libc::SYS_recvfrom,
    ] {
        program.push(instr(BPF_JMP | BPF_JEQ, 0, 1, syscall as u32));
        program.push(ret_eperm);
    }
    program.push(ret_allow);

    program
}

/// Installs a prebuilt program (M2: the forked test child must not
/// allocate, so the Vec is built before the fork and passed in).
#[cfg(target_os = "linux")]
fn install_seccomp_program(program: &[sock_filter]) -> Result<(), String> {
    const SECCOMP_SET_MODE_FILTER: u32 = 1;
    #[repr(C)]
    struct sock_fprog {
        len: u16,
        filter: *const sock_filter,
    }
    let fprog = sock_fprog {
        len: program.len() as u16,
        filter: program.as_ptr(),
    };
    let rc = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            SECCOMP_SET_MODE_FILTER,
            0u32,
            &fprog as *const sock_fprog,
        )
    };
    if rc < 0 {
        Err(format!("seccomp: {}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}
```

Jump-offset check for the generated program (each `JEQ` uses `jt=0` so the true path falls through to the immediately following `RET EPERM`, and `jf` skips exactly that one instruction; the arch check inverts this: `jt=1` skips the `RET EPERM` on match; the clone block's first `JEQ` uses `jf=3` to skip the three instructions of the flag check). Keep these invariants in the code comments when implementing. The `sock_filter` struct and the BPF constants live at module level (not inside `build_seccomp_program`) so both the builder and the installer can see them; the sketch above keeps them adjacent for review, and the implementer lifts them to module scope.

`sidecar/src/worker/mod.rs`'s `self_test_response` becomes real:

```rust
fn self_test_response() -> Result<WorkerResponse, JobError> {
    let report = SandboxSelfTest {
        landlock: sandbox::landlock_abi(),
        open_denied: std::fs::File::open("/proc/self/status").is_err(),
        socket_denied: sandbox::probe_socket_denied(),
    };
    done_json(serde_json::to_value(report).map_err(|err| JobError::worker(err.to_string()))?)
}
```

(The worker applies the sandbox before running any op, so the probes observe real enforcement. On non-Linux the probes report their actual unrestricted results with `LandlockStatus::NotApplicable`, and the tests assert platform-appropriately.)

`worker_main.rs` wiring between the PDFium preload and fd 3:

```rust
    if let Err(message) = tuxbooks_lib::worker::sandbox::prepare(&job.limits) {
        return fail(WorkerErrorKind::Sandbox, message);
    }
```

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml sandbox`
Expected: the pure tests pass on any kernel; the enforcement tests pass on CI (ubuntu-22.04/24.04) and skip with notices where the kernel lacks Landlock.

- [ ] **Step 5: Commit** — `feat(rust): sandbox the document worker with landlock seccomp and rlimits`

### Task 7: Route the sidecar through the worker and type the RPC codes

**Files:**

- Modify: `sidecar/src/services/library_scanner.rs` (`parse_book` routes through the client; `BookParseError` gains a worker branch)
- Modify: `sidecar/src/services/book_importer.rs` (parse + cover paths through the client)
- Modify: `sidecar/src/services/reader.rs` (`load_epub_session`, `load_book_resource` through the client)
- Modify: `sidecar/src/services/metadata.rs` (`embed_book_metadata` through the client + sidecar write; `read_file_properties` through the client)
- Modify: `sidecar/src/error.rs` (add the `Worker` variant)
- Modify: `sidecar/src/rpc.rs` (typed codes for worker-sourced failures)
- Test: `sidecar/tests/worker_routing.rs`, `sidecar/src/rpc.rs` test module

**Interfaces changed:**

```rust
// error.rs
pub enum AppError {
    // ...existing variants...
    #[error("{0}")]
    Worker(#[from] crate::worker::client::WorkerError),
}

// library_scanner.rs
#[derive(Debug, thiserror::Error)]
pub enum BookParseError {
    #[error(transparent)]
    Epub(#[from] EpubError),
    #[error(transparent)]
    Pdf(#[from] PdfError),
    #[error("{0}")]
    Worker(#[from] crate::worker::client::WorkerError),
}

// rpc.rs: worker-sourced failures map by kind (Task 2 ledger):
//   Deadline -> -32001, Limit -> -32002, Sandbox -> -32003, other -> -32004
// all other AppErrors keep -32000.
```

- [ ] **Step 1: Write the failing tests** in `sidecar/tests/worker_routing.rs`:

```rust
//! The sidecar's parse surface routes through the worker (W-1, P-1). These
//! tests drive the real client against the real worker binary through the
//! service layer, on tempdirs, like the rest of the integration tier.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use tuxbooks_lib::services::library_scanner;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/books/{name}"))
}

/// Serializes the one test that mutates process env (TUXBOOKS_WORKER).
fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| Mutex::new(()));
    lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[test]
fn parse_book_routes_epub_through_the_worker() {
    let scanned = library_scanner::parse_book(&fixture("minimal.epub")).unwrap();
    assert!(matches!(scanned, library_scanner::ScannedBook::Epub(_)));
}

#[test]
fn parse_book_routes_pdf_through_the_worker() {
    let scanned = library_scanner::parse_book(&fixture("minimal.pdf")).unwrap();
    assert!(matches!(scanned, library_scanner::ScannedBook::Pdf(_)));
}

#[test]
fn parse_book_fails_typed_when_the_worker_binary_is_missing() {
    // Fail-closed contract (ADR 0001 D5): no worker, no parse, no fallback.
    let _guard = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("minimal.epub");
    std::fs::write(&path, std::fs::read(fixture("minimal.epub")).unwrap()).unwrap();
    std::env::set_var("TUXBOOKS_WORKER", dir.path().join("absent-worker"));
    let result = library_scanner::parse_book(&path);
    std::env::remove_var("TUXBOOKS_WORKER");
    match result {
        Err(err) => assert!(
            err.to_string().contains("document worker"),
            "expected the typed unavailable error, got: {err}"
        ),
        Ok(scanned) => panic!("parse must fail closed without a worker, got: {scanned:?}"),
    }
}
```

In `sidecar/src/rpc.rs` tests:

```rust
    #[test]
    fn worker_failures_map_to_typed_rpc_codes() {
        use crate::worker::client::WorkerError;
        assert_eq!(WorkerError::Deadline.rpc_code(), -32001);
        assert_eq!(
            WorkerError::Limit(crate::limits::LimitExceeded {
                limit: "max_parse_seconds",
                detail: "x".into(),
            })
            .rpc_code(),
            -32002
        );
        assert_eq!(WorkerError::Sandbox("no".into()).rpc_code(), -32003);
        assert_eq!(WorkerError::Unavailable("missing".into()).rpc_code(), -32004);
    }

    #[test]
    fn app_error_worker_branch_carries_the_worker_code() {
        let err = AppError::Worker(crate::worker::client::WorkerError::Deadline);
        let rpc = RpcError::from(err);
        assert_eq!(rpc.code, -32001);
    }
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml --test worker_routing rpc::`
Expected: compile failure (`parse_book` still parses in-process; no `Worker` variants).

- [ ] **Step 3: Implement**

- `error.rs`: add the `Worker` variant.
- `library_scanner.rs`: `parse_book` calls `crate::worker::WorkerClient::locate().map_err(BookParseError::Worker)?` once, then dispatches `epub_parse` / `pdf_parse` on the extension; worker errors flow through the new `BookParseError::Worker` variant.
- `book_importer.rs`: the per-file parse calls keep using the (now worker-routed) `parse_book`; `pdf_cover_path` switches to `client.pdf_cover(path, pdfium_dirs, limits)`; the semaphore + `spawn_blocking` structure is untouched.
- `reader.rs`: `load_epub_session` and `load_book_resource` call `epub_session` / `epub_member`; map `WorkerError` via the new `AppError::Worker`.
- `metadata.rs`: the embed arms call `epub_embed` / `pdf_embed` and then `crate::backup_file_once(path)?` + `crate::atomic_replace(path, &bytes)?` with the returned bytes; `read_file_properties` goes through the client; the post-embed re-parse keeps using the scanner.
- `rpc.rs`: the `From<AppError> for RpcError` impl special-cases `AppError::Worker(err)` to use `err.rpc_code()`; all other app errors keep -32000.
- `epub/mod.rs` / `pdf/mod.rs`: module doc lines stating the parse functions are worker-internal, path wrappers exist for tests, and services must reach parsing only through the worker client.

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml`
Expected: full suite green; the routing tests pass; the scanner/watcher/vertical-slice integration tests still pass (they now exercise the real worker end to end).

- [ ] **Step 5: Commit** — `feat(rust): route sidecar parsing through the sandboxed worker`

### Task 8: Containment, caps, and boundary pins

**Files:**

- Create: `sidecar/tests/worker_containment.rs`
- Modify: `sidecar/tests/worker_handoff.rs` (the no-fd test keeps asserting the typed `Failed` shape pinned in Task 3)

**Tests (all runtime-generated hostile input, no committed fixtures):**

```rust
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
    f.write_all(format!("#!/bin/sh\n{script}\n").as_bytes()).unwrap();
    drop(f);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, WorkerClient::new(path))
}

fn job(op: WorkerOp, limits: ResourceLimits) -> WorkerJob {
    WorkerJob { op, limits, member: None, metadata: None, pdfium_dirs: Vec::new() }
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
    let book = client().epub_parse(&path, &ResourceLimits::DEFAULTS).unwrap();
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
                ResourceLimits { max_parse_seconds: 1, ..ResourceLimits::DEFAULTS },
            ),
            &path,
        )
        .unwrap_err();
    assert!(matches!(err, WorkerError::Deadline), "got: {err:?}");
    assert!(started.elapsed() < Duration::from_secs(10), "kill must be prompt");
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
    let tight = ResourceLimits { max_parse_seconds: 0, ..ResourceLimits::DEFAULTS };
    let err = client()
        .epub_parse(&fixture("minimal.epub"), &tight)
        .unwrap_err();
    assert!(matches!(err, WorkerError::Limit(_)), "got: {err:?}");
}
```

- [ ] **Step 1: Write the failing tests** (above).

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path sidecar/Cargo.toml --test worker_containment`
Expected: failures where client or worker behavior is incomplete.

- [ ] **Step 3: Implement**

- Fix any behavior gap the containment tests expose (for example a cap-check ordering bug in the client) minimally in `client.rs` / `worker_main.rs`.
- The deadline kill path stays under 10 seconds of wall time for a 1-second budget (asserted).

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test --manifest-path sidecar/Cargo.toml --test worker_containment`
Expected: all containment tests pass.

- [ ] **Step 5: Commit** — `test(rust): pin worker containment deadline kill and response caps`

### Task 9: Packaging, docs, and full verification

**Files:**

- Modify: `electron-builder.yml` (ship the worker)
- Modify: `scripts/check-deb.sh` (gate the worker's presence)
- Modify: `docs/ARCHITECTURE.md` (process model + module table)
- Modify: `docs/RESOURCE_LIMITS.md` (retire the run-to-completion gap note)
- Modify: `docs/BUILD.md` (worker binary in the build and packaging story)
- Modify: `docs/TESTING.md` (sandbox test layer notes)
- Modify: `docs/PERFORMANCE.md` (PERF-13 note: worker spawn per parse op)
- Modify: `docs/RELEASE.md` (worker in the packaged artifacts list, wherever it enumerates them)

- [ ] **Step 1: Packaging**

`electron-builder.yml` extraResources gains, next to the existing sidecar entry:

```yaml
- from: sidecar/target/release/tuxbooks-worker
  to: sidecar/tuxbooks-worker
```

`scripts/check-deb.sh` gains, beside the sidecar check at lines 62-63:

```sh
[ -x "$payload/opt/TuxBooks/resources/sidecar/tuxbooks-worker" ] ||
  fail "bundled document worker missing or not executable (resources/sidecar/tuxbooks-worker)"
```

and the final OK line mentions the worker.

- [ ] **Step 2: Docs**

- `docs/ARCHITECTURE.md`: the process diagram gains the worker box under the sidecar; the "Process and boundary" section gains one paragraph: the sidecar spawns `tuxbooks-worker` one process per parse job, hands the document over as a pre-opened read-only fd, enforces the wall-clock deadline, and treats any worker outcome as a typed per-job error; on Linux the worker applies Landlock, a seccomp deny-list, and rlimits itself (ADR 0001); the parse modules (`epub/`, `pdf/`) are worker-internal and services reach them only through the worker client. The Rust module table's `epub/` and `pdf/` rows note "worker-internal".
- `docs/RESOURCE_LIMITS.md`: replace the "Two stages run to completion once started" paragraph with: those stages now run in the killable worker; the sidecar kills at the wall-clock deadline and `RLIMIT_CPU`/`RLIMIT_AS` backstop inside the worker; in-process parsing remains only in tests.
- `docs/BUILD.md`: the worker binary is built by the same `cargo build` (second `[[bin]]`), packaged as `resources/sidecar/tuxbooks-worker`, located via `TUXBOOKS_WORKER` or next to the sidecar binary.
- `docs/TESTING.md`: the Rust layer row notes the worker integration tests (spawn the real binary; kernel-gated sandbox tests skip with a notice on unsupported kernels).
- `docs/PERFORMANCE.md`: PERF-13's Status column gains: "parse/extraction ops pay one fork and exec into the per-job document worker (ADR 0001); reader byte-range paths do not; measure with `just bench-reader` before and after any worker transport change".
- `AGENTS.md`: no new list entry; ARCHITECTURE.md links ADR 0001.

- [ ] **Step 3: Full verification**

Run: `just format && just check`
Expected: green (fmt, clippy, cargo tests, vitest, eslint, tsc, prettier).

Run: `just test-e2e`
Expected: green, single invocation. From the renderer's perspective nothing changed; imports and covers now flow through the worker.

Run: `just test-e2e-release`
Expected: green; proves the packaged sidecar locates its packaged worker.

- [ ] **Step 4: Commit** — `docs: describe the sandboxed document worker in the process model`
