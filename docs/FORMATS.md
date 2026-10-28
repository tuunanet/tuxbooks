# Formats

What TuxBooks accepts, how it recognises a file, and which engine draws it.

| Format | Extension | Import parser                     | Engine    | Reuse policy                                                                      |
| ------ | --------- | --------------------------------- | --------- | --------------------------------------------------------------------------------- |
| EPUB   | `.epub`   | `sidecar/src/epub` (`parse_epub`) | `readium` | Generalizes: EPUB-family formats normalize to EPUB at import and reuse the viewer |
| PDF    | `.pdf`    | `sidecar/src/pdf` (`parse_pdf`)   | `pdfium`  | Single-format by decision; do not generalize                                      |

The Engine column comes from the frontend registry,
`frontend/src/lib/formats.ts` (`FORMATS`, `FORMAT_FILTER_OPTIONS`). The sidecar
holds the format and its extension in `BookFormat`
(`sidecar/src/domain/book.rs`). The reuse policy is the decision recorded in
[ADR 0012](adr/0012-formats-map-to-render-engines.md), not a code table.

## Detection

- Format comes from the file extension, case-insensitively
  (`BookFormat::from_extension` / `from_path`). That function is the only
  place that enumerates supported extensions: the scanner, the reconciler,
  and the book serializer all ask it.
- An unsupported extension has no format (`None`). The scanner and the
  reconciler ignore such files, so they are never imported.
- A stored book always has a supported extension, so the IPC payload always
  carries a format. The serializer errors rather than guessing if that
  invariant breaks.

## The library filter

The header's format filter is multi-select. Ticking nothing means every
format, so "no formats" is not a state the library can be in. Options are the
registry's formats in display order; a format the library cannot import never
appears.

## Adding a format

1. **Rust format**: add the variant to `BookFormat` and extend
   `BookFormat::from_extension`. The scanner, the reconciler, and the
   serializer derive from it, so they need no separate edit.
2. **Import path**: add the parser under `sidecar/src/<format>/`, extend
   `ScannedBook` and `parse_book`, and branch in `book_importer`. Parser quotas
   come from [RESOURCE_LIMITS.md](RESOURCE_LIMITS.md).
3. **Engine decision**: reuse `readium` if the format can be normalized to EPUB
   at import; otherwise add an engine and a reader component.
4. **Registry entry**: add the format to `FORMATS` in
   `frontend/src/lib/formats.ts`. The filter options and the reader dispatch
   derive from that table, in declaration order.
5. **Tests and docs**: extend the format unit tests and the library filter
   tests, and add the row to the table above.
