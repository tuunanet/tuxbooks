# Resource limits (issue #83, invariants R-1..R-4)

Every EPUB and PDF the sidecar touches is hostile input. Parser entry points
enforce one shared quota table (`sidecar/src/limits.rs`, `ResourceLimits` +
`ResourceLimits::DEFAULTS`) and fail fast with a typed error
(`limits::LimitExceeded`, surfaced as `EpubError::Limit` / `PdfError::Limit`)
instead of hanging, allocating indefinitely, or crashing. A tripped limit is
a returned error, never a panic.

The sandboxed document worker (#81) and fuzzing (#88) reuse this module and
can override every field.

## Baseline values

Provisional, chosen to sit far above real books while capping attacker work.
Benchmarking real corpora and tuning is follow-up work (R-4).

| Field                           | Value     | Provisional rationale                                                                 |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `max_source_file_bytes`         | 1 GiB     | far above real books; caps every downstream check                                     |
| `max_entries`                   | 100,000   | real EPUBs carry tens of entries                                                      |
| `max_compressed_member_bytes`   | 256 MiB   | covers and fonts stay well below                                                      |
| `max_decompressed_bytes`        | 512 MiB   | per-member decompression ceiling                                                      |
| `max_total_uncompressed_bytes`  | 2 GiB     | whole-archive ceiling                                                                 |
| `max_stream_decompressed_bytes` | 512 MiB   | what one PDF stream may inflate to during load; real xref/object streams are KB-scale |
| `max_xml_bytes`                 | 32 MiB    | OPF/nav/NCX documents are KB-scale                                                    |
| `max_xml_depth`                 | 512       | real XML nests under 64                                                               |
| `max_metadata_string_bytes`     | 1 MiB     | real metadata strings stay under 100 KiB                                              |
| `max_pages`                     | 100,000   | real PDFs stay under 10,000 pages                                                     |
| `max_page_tree_nodes`           | 1,000,000 | bounds structural traversal work                                                      |
| `max_page_tree_depth`           | 128       | balanced page trees are under 10 deep                                                 |
| `max_cover_png_bytes`           | 16 MiB    | a 600 px PNG renders to ~1 MiB                                                        |
| `max_parse_seconds`             | 30        | import runs in the background                                                         |

## Where each quota is enforced

| Quota                           | Field                                                 | Enforced at                                                                                                                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EPUB source file size           | `max_source_file_bytes`                               | `parse_epub`, `build_session`, `read_member`                                                                                                                                                                                                                           |
| ZIP entry count                 | `max_entries`                                         | `parse_epub`, `build_session`, `read_member` (central-directory pre-scan)                                                                                                                                                                                              |
| Compressed member size          | `max_compressed_member_bytes`                         | every ZIP read via `read_entry` / `read_mimetype`                                                                                                                                                                                                                      |
| Uncompressed member size        | `max_decompressed_bytes`                              | declared size checked before read; the read is additionally capped by `limits::read_bounded`, so a header that lies about its size cannot bypass the cap                                                                                                               |
| Total uncompressed archive size | `max_total_uncompressed_bytes`                        | declared-size pre-scan in `parse_epub`, `build_session`, `read_member`; running actual-read total in the EPUB positions loop (catches lying headers)                                                                                                                   |
| XML/OPF/document size           | `max_xml_bytes`                                       | `parse_container_xml`, `parse_opf`, nav + NCX parsers                                                                                                                                                                                                                  |
| Metadata string length          | `max_metadata_string_bytes`                           | `parse_opf` extracted values, including the attribute-derived `calibre:series` / `calibre:series_index` meta values (M-1, #86); PDF info-dictionary strings                                                                                                            |
| Image/font size, incl. decoded  | member caps on every read                             | the Rust side never decodes images or fonts: cover bytes are cached verbatim and fonts/images are served as bytes to the renderer                                                                                                                                      |
| XML depth                       | `max_xml_depth`                                       | `parse_container_xml`, `parse_opf`, nav + NCX stacks                                                                                                                                                                                                                   |
| PDF source file size            | `max_source_file_bytes`                               | `parse_pdf`, `read_file_properties`, `render_first_page_cover`                                                                                                                                                                                                         |
| PDF page count                  | `max_pages`                                           | budgeted page-tree walk in `pdf::parser`                                                                                                                                                                                                                               |
| Structural traversal work       | `max_page_tree_nodes`                                 | page-tree walk stops at the node budget                                                                                                                                                                                                                                |
| Recursion depth                 | `max_page_tree_depth`                                 | page-tree walk is iterative with a depth cap                                                                                                                                                                                                                           |
| Decoded image dimensions/bytes  | `max_cover_png_bytes`                                 | rendered cover PNG size checked; output dimensions are fixed by the render config (`COVER_WIDTH_PX` = 600)                                                                                                                                                             |
| PDF stream inflation (bombs)    | `max_stream_decompressed_bytes`                       | wired into lopdf's `max_decompressed_size` at every `Document::load_mem_with_options` site (`parse_pdf_bytes`, `read_file_properties_bytes`, `rewrite_pdf_bytes`); a cross-reference or object stream that inflates past the cap fails the load as a typed limit error |
| Cover-render work               | deadline + source cap + fixed 600 px target + PNG cap | `render_first_page_cover` (runs to completion once started; see R-3 section)                                                                                                                                                                                           |

## Time and memory bounds (R-3)

The wall-clock deadline (`max_parse_seconds`, `limits::Deadline`) is checked
between parsing stages of every entry point and inside the EPUB positions
read loop. EPUB and PDF parses are synchronous and single-threaded, so that
deadline is also the CPU bound: each interruptible stage's cost is linear in
an input that the size quotas above cap. Memory is bounded by the size
quotas, `read_bounded` (caps bytes actually delivered regardless of what a
header declared), and the running cumulative check in the positions loop
(caps what one stage can decompress when headers lie).

Those stages now run in the killable document worker (#81): `Document::load`
and the PDFium cover render execute inside `tuxbooks-worker`, which the
sidecar kills at the wall-clock deadline and which carries kernel backstops
of its own (`RLIMIT_CPU` at the job's parse budget, `RLIMIT_AS` at a 3 GiB
cap, `RLIMIT_FSIZE` 0). A stage that cannot be interrupted in-process is
therefore still bounded by a kill, mid-stage if needed. In-process parsing
remains only in tests (the reader- and bytes-based cores, driven directly);
the sidecar's services parse exclusively through the worker (ADR 0001).

One stage of `Document::load` is now bounded mid-stage after all: lopdf
decodes cross-reference and object streams eagerly while loading, and the
load options carry `max_stream_decompressed_bytes` as lopdf's
`max_decompressed_size`. A stream that inflates past the cap fails the load
with lopdf's `MemoryLimitExceeded`, mapped to the typed
`max_stream_decompressed_bytes` limit error, before the allocation grows.
The value sits below the worker's 3 GiB `RLIMIT_AS` so the typed error wins
the race against the kernel ceiling; `RLIMIT_AS` remains the backstop for
inflation lopdf does not bound (content streams decoded later by PDFium,
for example).

## Tests

Each quota has a committed test that trips it with a tight `ResourceLimits`
override and a normal-fixture test that passes under `DEFAULTS`
(`parse_epub_accepts_fixture_under_default_limits`,
`parse_pdf_accepts_fixture_under_default_limits`). Malicious inputs are
generated at runtime with the existing `write_zip`/`build_pdf`/`assemble_pdf`
test helpers, consistent with repo conventions; the committed EPUB corpus
and its size budget are untouched.
