# sidecar

Rust service crate. `src/db` (SQLite + FTS5), `src/epub`, `src/pdf`,
`src/services`, `src/repository`, `src/worker` (sandboxed parser worker).
Integration tests are in `tests/`; parser fixtures under `tests/fixtures/`.
Parser quotas live in `src/limits.rs` and are enforced by every parse path;
see `docs/RESOURCE_LIMITS.md` before touching a parser.

Narrow commands:

```sh
cargo test --manifest-path sidecar/Cargo.toml <test-name>
cargo clippy --manifest-path sidecar/Cargo.toml --all-targets --all-features -- -D warnings
```

The first build fetches PDFium (`just fetch-pdfium`); `just test-rust` handles
that automatically.
