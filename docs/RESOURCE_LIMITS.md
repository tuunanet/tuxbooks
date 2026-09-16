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

| Field                          | Value     | Provisional rationale                             |
| ------------------------------ | --------- | ------------------------------------------------- |
| `max_source_file_bytes`        | 1 GiB     | far above real books; caps every downstream check |
| `max_entries`                  | 100,000   | real EPUBs carry tens of entries                  |
| `max_compressed_member_bytes`  | 256 MiB   | covers and fonts stay well below                  |
| `max_decompressed_bytes`       | 512 MiB   | per-member decompression ceiling                  |
| `max_total_uncompressed_bytes` | 2 GiB     | whole-archive ceiling                             |
| `max_xml_bytes`                | 32 MiB    | OPF/nav/NCX documents are KB-scale                |
| `max_xml_depth`                | 512       | real XML nests under 64                           |
| `max_metadata_string_bytes`    | 1 MiB     | real metadata strings stay under 100 KiB          |
| `max_pages`                    | 100,000   | real PDFs stay under 10,000 pages                 |
| `max_page_tree_nodes`          | 1,000,000 | bounds structural traversal work                  |
| `max_page_tree_depth`          | 128       | balanced page trees are under 10 deep             |
| `max_cover_png_bytes`          | 16 MiB    | a 600 px PNG renders to ~1 MiB                    |
| `max_parse_seconds`            | 30        | import runs in the background                     |

## Where each quota is enforced

| Quota                           | Field                                                 | Enforced at                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EPUB source file size           | `max_source_file_bytes`                               | `parse_epub`, `build_session`, `read_member`                                                                                                             |
| ZIP entry count                 | `max_entries`                                         | `parse_epub`, `build_session`, `read_member` (central-directory pre-scan)                                                                                |
| Compressed member size          | `max_compressed_member_bytes`                         | every ZIP read via `read_entry` / `read_mimetype`                                                                                                        |
| Uncompressed member size        | `max_decompressed_bytes`                              | declared size checked before read; the read is additionally capped by `limits::read_bounded`, so a header that lies about its size cannot bypass the cap |
| Total uncompressed archive size | `max_total_uncompressed_bytes`                        | declared-size pre-scan in `parse_epub`, `build_session`, `read_member`                                                                                   |
| XML/OPF/document size           | `max_xml_bytes`                                       | `parse_container_xml`, `parse_opf`, nav + NCX parsers                                                                                                    |
| Metadata string length          | `max_metadata_string_bytes`                           | `parse_opf` extracted values; PDF info-dictionary strings                                                                                                |
| Image/font size, incl. decoded  | member caps on every read                             | the Rust side never decodes images or fonts: cover bytes are cached verbatim and fonts/images are served as bytes to the renderer                        |
| XML depth                       | `max_xml_depth`                                       | `parse_container_xml`, `parse_opf`, nav + NCX stacks                                                                                                     |
| PDF source file size            | `max_source_file_bytes`                               | `parse_pdf`, `read_file_properties`, `render_first_page_cover`                                                                                           |
| PDF page count                  | `max_pages`                                           | budgeted page-tree walk in `pdf::parser`                                                                                                                 |
| Structural traversal work       | `max_page_tree_nodes`                                 | page-tree walk stops at the node budget                                                                                                                  |
| Recursion depth                 | `max_page_tree_depth`                                 | page-tree walk is iterative with a depth cap                                                                                                             |
| Decoded image dimensions/bytes  | `max_cover_png_bytes`                                 | rendered cover PNG size checked; output dimensions are fixed by the render config (`COVER_WIDTH_PX` = 600)                                               |
| Cover-render work               | deadline + source cap + fixed 600 px target + PNG cap | `render_first_page_cover`                                                                                                                                |

## Time and memory bounds (R-3)

The wall-clock deadline (`max_parse_seconds`, `limits::Deadline`) is checked
between parsing stages of every entry point. EPUB and PDF parses are
synchronous and single-threaded, so that deadline is also the CPU bound:
every stage's cost is linear in an input that the size quotas above already
cap. Memory is bounded by the size quotas plus `read_bounded`, which caps
bytes actually delivered regardless of what a header declared. True
per-parse CPU-time accounting is not attempted here (process-wide and
per-thread rusage would be polluted by concurrent import workers); it moves
into the sandboxed worker (#81), which can simply kill an over-budget job.

The PDFium cover render is the one stage that cannot be interrupted: it is
bounded by the source-size cap, the fixed 600 px output target, and the
PNG-size check after encoding.

## Tests

Each quota has a committed test that trips it with a tight `ResourceLimits`
override and a normal-fixture test that passes under `DEFAULTS`
(`parse_epub_accepts_fixture_under_default_limits`,
`parse_pdf_accepts_fixture_under_default_limits`). Malicious inputs are
generated at runtime with the existing `write_zip`/`build_pdf`/`assemble_pdf`
test helpers, consistent with repo conventions; the committed EPUB corpus
and its size budget are untouched.
