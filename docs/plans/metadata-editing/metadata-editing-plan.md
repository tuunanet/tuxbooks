# Metadata editing — detail view as the primary surface

Status: complete — Phases 0–4 landed; `just check`, `just test-e2e`, and
`just coverage` green.
Source: [tuunanet/tuxbooks#58](https://github.com/tuunanet/tuxbooks/issues/58).
Mockup: [`metadata-view-mockup.png`](metadata-view-mockup.png).

Decisions confirmed in review:

- Retire the Edit Metadata modal in Phase 2; the detail panel is the only editor.
- Ship Overview + Metadata now; the remaining rail sections move in later.
- Publication date stays a free-text Input; no date-picker dependency.
- PDF `/Keywords` stays library-only for now (optional follow-up).
- Source preference is per-book only, with the fixed default (override, else file).
- Migration 0010 stores only fields explicitly changed away from the default.

## Progress log

- Phase 0 — done. `BookMetadataDialog` split into
  `frontend/src/components/books/metadata/` (`FieldLabel`, `SourceValueHint`,
  `MetadataFieldGrid`, `CoverField`, `metadataForm.ts`); the dialog is now a
  thin wrapper and `tests/metadataForm.test.ts` covers the pure form helpers.
- Phase 1 — done, with one sequencing deviation. Detail has an
  Overview/Metadata rail; the Metadata tab shows every supported field with
  the orange-dot divergence marker, `Reset to source`, and a read-only
  **Original File Metadata** panel fed by `get_book_file_properties` (PDF Info
  dictionary incl. Keywords/Creator/Producer/dates; EPUB managed `dc:*`).
  `BookMetadata` gained `sourceCoverPath`. Deviation: the Library/File
  sub-tabs from the mockup land with the editable panel (Phase 2/3); the
  existing dialog is still the editor entry point, so `detailTab` is optional
  and `metadataEditorBookId` is retained until Phase 2. `just check` green
  (39 files / 469 tests).
- Phase 2 — done. `MetadataPanel` is the only editor now: Library form wired
  to `useBookMetadata` save/reset/cover, chip editors for authors/subjects
  (`metadata/ListEditor.tsx`; `metadataForm` holds arrays), Cancel/Save with a
  dirty guard and saved confirmation. `BookMetadataDialog.tsx` + its test are
  deleted; `appState` drops `metadataEditorBookId`/`open-metadata-editor`;
  `open-book-detail` takes a `tab`, so the context-menu and detail Edit action
  navigate to the detail Metadata tab. `e2e/specs/metadata.e2e.ts` rewritten
  for the inline panel; `ensureLibrary` now recovers from a detail view too.
  `just check` green (38 files / 459 tests), `just test-e2e-seeded` 53/53.
- Phase 3 — done. `lib/fileMetadataCapabilities.ts` maps each field to the
  writers' real reach (EPUB all; PDF title/authors/description), with unit
  tests. The panel gained Library/File sub-tabs: the File tab disables
  non-writable fields and labels them "Library only", and embeds via the
  existing `embed_book_metadata` (atomic + `.bak`). The Library tab's
  "Write changes into file" checkbox routes Save Changes through the same
  embed call. PDF `/Keywords` stays library-only (decision, recorded in
  `docs/PDF.md`); the Rust embed tests already cover unwritable fields. New
  `tests/fileMetadataCapabilities.test.ts` and panel tests for gating, embed
  success, and the checkbox path.
- Phase 4 — done. Migration `0010_metadata_field_sources.sql` plus the
  `MetadataFieldSource`/`MetadataFieldSources` domain, repository CRUD,
  preference-aware merge (`merged_scalar`/`effective_series`; `file` on the
  normalized lists keeps the stored user list), and `set_field_source`. Saving
  a changed field clears its `file` choice so the edit becomes effective;
  `reset` clears all choices. New command `set_metadata_field_source` + RPC +
  bridge, and a per-field "Use file value / Use library value" control on the
  detail field rows. Rust and frontend tests cover shadowing, list/unit
  preservation, edit-clears-preference, and reset. The series name and index
  share one choice (the plan's earlier `series_index` row was dropped).
- Close-out — `just check` green (39 files / 465 tests), `just test-e2e`
  green (seeded 53/53), `just coverage` green (Rust instrumented + frontend).
- Follow-up (modality fix) — the File tab had three overlapping write paths
  (in-tab "Embed into file", the "Write changes into file" checkbox +
  Save Changes, and plain Save Changes), and plain Save on the File tab
  silently wrote library overrides — the opposite of the tab's promise. Now
  the active tab decides the one primary action: Library tab → Save Changes
  (overrides only), File tab → Embed into file (embed; non-writable fields
  stay library edits). The checkbox and the in-tab embed button are removed;
  the File tab banner states the embed + `.bak` semantics.

Goal: make the book detail page the primary metadata surface. Show file
value, library value, and effective value per field; edit library metadata
inline; edit and embed file metadata through the existing safe path; persist a
per-field library-vs-file preference. Evolve milestone 7 — do not replace the
storage model, merge rules, or EPUB/PDF writers.

## Current state (verified)

Three layers (`sidecar/migrations/0008_metadata_curation.sql`, `docs/DATABASE.md`):
`book_source_metadata` (file truth), `book_metadata_overrides` (user truth,
minimal), `books` columns (effective; FTS triggers in sync).

Reuse, do not duplicate:

- Domain `MetadataFields`/`MetadataOverridden`/`BookMetadata`
  (`sidecar/src/domain/metadata.rs:9`).
- Repository `get_source_metadata`/`get_overrides`/`upsert_overrides`/
  `replace_book_authors|subjects`/`apply_effective`
  (`sidecar/src/repository/metadata.rs`).
- Merge `get_book_metadata`/`update_book_metadata`/`apply_form`/
  `recompute_and_apply`/`reset_book_metadata`/`set_book_cover`/
  `clear_book_cover_override`/`embed_book_metadata`
  (`sidecar/src/services/metadata.rs:41`).
- Commands + method table (`sidecar/src/commands/metadata.rs`,
  `sidecar/src/rpc.rs:235`), bridge (`frontend/src/lib/bridge.ts:122`),
  hook (`frontend/src/hooks/useBookMetadata.ts`).
- UI controls incl. orange-dot `FieldLabel`, `SourceValueHint`, list parsing,
  cover, reset, embed (`frontend/src/components/books/BookMetadataDialog.tsx`).
- Detail fetches `BookMetadata` already (`BookDetail.tsx:34`); `open-metadata-editor`
  opens a global dialog (`state/appState.ts:69`, `layout/AppShell.tsx:113`).
- Cards refresh from `library-changed` (`hooks/useLibrary.ts:133`); every
  metadata command already emits it.
- Writers: EPUB regenerates managed OPF metadata (`docs/EPUB.md:53`); PDF sets
  `/Title`, `/Author`, `/Subject` (`docs/PDF.md:55`). One-time `<file>.bak`,
  atomic swap, covers never embedded.

## Mockup reading

- Detail becomes sectioned: left rail **Overview** + **Metadata** (Reading /
  File / Collections / Notes & Highlights drawn for direction, shipped later).
- Metadata section = one card: sub-tabs **Library Metadata** / **File
  Metadata**, **Reset to source**, Cancel / Save Changes, checkbox "Write
  changes into file (…where supported)".
- Right panel **Original File Metadata** = values read from the file (PDF:
  Title, Author, Subject, Keywords, Creator, Producer, Creation/Modification
  date), an info banner that unsupported fields do not exist in the file,
  "View all file properties…", and the green override explainer tying the dot
  to overrides.
- Authors/Subjects are chip editors (multi-value), not comma strings.

## Design decisions

1. **One editor, extracted.** Split the dialog into reusable field/form
   pieces; the detail panel and (temporarily) the dialog compose them. Retire
   the dialog once the panel reaches parity — never two implementations.
2. **No new library-metadata storage.** Keep the three layers; Phase 4 adds
   one narrow preference table only.
3. **Detail navigation in `appState`.** Replace `metadataEditorBookId` with
   `detailTab: "overview" | "metadata"`; `open-metadata-editor` navigates to
   the detail Metadata tab. Context menu and detail button share it, so the
   action stays functional.
4. **Orange dot = divergence** on the detail surface too, driven by
   `overridden[field]`.
5. **File editing is capability-gated, not format-guessed.** Typed map in
   `frontend/src/lib/fileMetadataCapabilities.ts` (EPUB: all text fields; PDF:
   title, author, description, optionally keywords). Backend keeps its own
   guard: `embed_book_metadata` already writes only writable fields
   (`services/metadata.rs:228`).
6. **Reuse `embed_book_metadata`.** File tab submits full `MetadataFields`
   (unsupported fields carry current effective values); backend persists,
   writes what the format supports, re-parses. The checkbox is the same call.
7. **Per-field preference = side table.** Migration 0010
   `book_metadata_field_sources(book_id, field, source)`. Absent = today's
   default (library override if present, else file). `recompute_and_apply`
   consults it for effective `books` columns (cards, reader, search); override
   bytes stay stored, so toggling back is lossless.
8. **Lists survive a "file" preference.** When preference is `file`, do not
   rewrite `book_authors`/`book_subjects`; compute effective list from source
   JSON and write only the `books.author` display. No schema change for lists.
9. **File properties read-only and format-native.** New
   `get_book_file_properties(bookId)` reads the file fresh, returns native
   key/value entries (PDF Info dict; EPUB managed `dc:*` + identifiers). Never
   writes; does not touch the source snapshot.
10. **No date-picker dependency.** Publication date stays a text Input;
    Language may use shadcn `Select`; "Write changes into file" uses shadcn
    `Checkbox` (`pnpm dlx shadcn add checkbox`).
11. **State + refresh unchanged.** `useBookMetadata` is the only hook; new
    mutations emit `library-changed` so cards/detail/FTS/reader follow.

## Phase 0 — Extract reusable pieces (no behavior change)

- [ ] Split `BookMetadataDialog.tsx` into
      `frontend/src/components/books/metadata/`: `FieldLabel.tsx`,
      `SourceValueHint.tsx`, `MetadataFieldGrid.tsx`, `CoverField.tsx`,
      `metadataForm.ts` (`MetadataFormState`, `toForm`, `fromForm`). Keep
      classes and `data-testid`s identical.
- [ ] Rebuild `BookMetadataDialog.tsx` as a thin Dialog wrapper; tests stay
      green.
- [ ] Add `frontend/tests/metadataForm.test.ts` for
      `toForm`/`fromForm` (empty→null, trim, de-dupe, non-finite index).
- [ ] `just check` green.

## Phase 1 — Detail-view transparency

Outcome: every supported field is visible, file vs library vs effective is
clear, and divergent fields are flagged. No preference yet.

- [ ] `state/appState.ts`: add `DetailTab`, `detailTab` (default `overview`),
      `select-detail-tab`; `open-metadata-editor` sets view=`detail` +
      `detailTab=metadata`; drop `metadataEditorBookId` /
      `close-metadata-editor`. Update `tests/appState.test.ts`.
- [ ] `BookDetail.tsx`: section rail (shadcn `Tabs`) Overview + Metadata;
      Overview keeps current content; Metadata renders `<MetadataPanel>`.
- [ ] New `components/books/MetadataPanel.tsx`: left "Edit Metadata" card with
      Library/File sub-tabs (File read-only here), Reset, Cancel/Save; right
      **Original File Metadata** panel + info banner + "View all file
      properties…" + green explainer. Uses `useBookMetadata(bookId)`; each
      field shows `FieldLabel` (dot when overridden), effective value, source
      hint. Cover shows effective thumbnail and `sourceCoverPath` when
      different.
- [ ] DTO: add `source_cover_path` to `BookMetadata`
      (`domain/metadata.rs`), populate in `services/metadata.rs::get_book_metadata`
      from the source snapshot, mirror in `types/domain.ts`.
- [ ] File-properties read path:
      `pdf/parser.rs::read_file_properties` (full Info dict: Title, Author,
      Subject, Keywords, Creator, Producer, CreationDate, ModDate; reuse
      `resolve`/`decode_pdf_string`); `epub/` equivalent (managed `dc:*` +
      all `dc:identifier`); domain `FileProperty { key, value }` /
      `FileProperties`; service `get_book_file_properties`; register in
      `rpc.rs` + command wrapper; bridge wrapper + TS type.
- [ ] New `components/books/FilePropertiesPanel.tsx`.
- [ ] Tests: extend `BookDetail.test.tsx` (tab switch, dot per field, source
      vs effective, PDF banner); add Rust reader tests; default
      `get_book_file_properties` in `tests/mocks/bridge.ts`.
- [ ] Docs: `ARCHITECTURE.md` frontend structure; `EPUB.md`/`PDF.md` for the
      read-only properties API.
- [ ] `just check` green.

## Phase 2 — Inline library editing

Outcome: Metadata section edits library metadata in place; Save persists via
existing overrides; detail and cards update live.

- [ ] Make Library tab editable; wire `save(fromForm(state))`, `changeCover`,
      `restoreCover`, `reset`. Title-required rule stays server-side.
- [ ] Chip editors `AuthorsEditor` / `SubjectsEditor` (add/remove, Enter to
      commit) replacing comma strings; ship only one style.
- [ ] Cover: Replace / Restore extracted / Remove library cover; keep the
      one-time `.bak` note near Embed.
- [ ] Cancel restores the last saved form.
- [ ] Remove `BookMetadataDialog` from `AppShell.tsx`; delete
      `BookMetadataDialog.tsx` + its test; move coverage to
      `frontend/tests/MetadataPanel.test.tsx`. Context menu still lands on the
      detail Metadata tab.
- [ ] Update `e2e/specs/metadata.e2e.ts` to the inline panel (no
      `metadata-dialog`), asserting live updates, untouched file, reset, and
      context-menu navigation.
- [ ] `just check` + `just test-e2e` green.

## Phase 3 — File editing + embed

Outcome: File Metadata tab edits format-supported fields and embeds through
the existing atomic + backup path; unsupported fields are clearly
library-only.

- [ ] `lib/fileMetadataCapabilities.ts`: typed
      `Record<MetadataFieldKey, { epub: boolean; pdf: boolean }>` from the
      writers (`docs/EPUB.md:53`, `docs/PDF.md:55`). Unit-test.
- [ ] File tab renders the shared grid with capability-disabled fields,
      labelled "Library only" + tooltip; editable fields prefill from
      effective.
- [ ] Embed calls `embedBookMetadata(bookId, fromForm(state))`; keep the
      existing success copy (written vs stays as library edits) and inline
      failures.
- [ ] "Write changes into file" checkbox on the Library tab maps to the same
      `embed` call.
- [ ] Optional, format-honest: PDF `/Keywords` — parse into `subjects` on
      import, write `subjects` joined on embed, extend the PDF map. If
      skipped, keep PDF subjects library-only and say so. Record in
      `docs/PDF.md`.
- [ ] Tests: Rust embed test asserts unsupported fields cannot be written and a
      multi-value field round-trips; `MetadataPanel.test.tsx` covers
      capability gating per format and embed copy.
- [ ] `just check` green.

## Phase 4 — Per-field source preference

Outcome: a persisted per-field choice selects library or file as
authoritative and drives effective metadata everywhere.

- [ ] Migration `sidecar/migrations/0010_metadata_field_sources.sql` (SQL
      below). No backfill: an absent row means the default (library override
      if one exists, else file). Cover is excluded (replace/restore owns it).
- [ ] Domain `MetadataFieldSource` + `field_sources` on `BookMetadata`; mirror
      in `types/domain.ts`.
- [ ] Repository `get_field_sources`/`upsert_field_source`/`clear_field_sources`.
- [ ] `recompute_and_apply`: per field, `file` → source value, else existing
      `scalar_value`/series-unit logic; lists `file` → source JSON without
      rewriting join tables; series is atomic. `get_book_metadata` computes
      `effective` and keeps `overridden` meaning "an override exists".
- [ ] `apply_form` preserves field sources; `reset_book_metadata` clears them.
- [ ] New command `set_metadata_field_source(bookId, field, source | null)`
      (null = default) → service + command + `rpc.rs` + bridge; calls
      `recompute_and_apply` and emits `library-changed`.
- [ ] UI: per-field "Use file value / Use library value" control reflecting
      `fieldSources`; promote `SourceValueHint`'s "Use file value" to a
      persisted toggle and note "library override kept".
- [ ] Tests (Rust): file preference on an overridden scalar yields source while
      `overridden` stays true; switching back restores; list preserved; series
      atomic; reset clears. (Frontend): toggle dispatches and updates.
- [ ] Docs: `DATABASE.md` table + merge rule.
- [ ] `just check` + `just test-e2e` green.

The migration:

```sql
CREATE TABLE book_metadata_field_sources (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    field   TEXT NOT NULL CHECK (field IN (
        'title','subtitle','authors','publisher','language','isbn',
        'publication_date','series','subjects','description'
    )),
    source  TEXT NOT NULL CHECK (source IN ('library','file')),
    PRIMARY KEY (book_id, field)
);
```

## Field capability matrix

| Field                  | EPUB source        | EPUB embed             | PDF source      | PDF embed                                   |
| ---------------------- | ------------------ | ---------------------- | --------------- | ------------------------------------------- |
| title                  | yes                | yes                    | yes `/Title`    | yes                                         |
| subtitle               | yes                | yes (EPUB3 title-type) | no              | no — library only                           |
| authors (multi)        | yes                | yes                    | yes `/Author`   | yes (joined)                                |
| publisher              | yes                | yes                    | no              | no — library only                           |
| language               | yes                | yes                    | no              | no — library only                           |
| isbn                   | yes                | yes                    | no              | no — library only                           |
| publication_date       | yes                | yes                    | no              | no — library only; `CreationDate` read-only |
| series + index         | yes (calibre)      | yes                    | no              | no — library only                           |
| subjects               | yes (`dc:subject`) | yes                    | no              | optional `/Keywords`                        |
| description            | yes                | yes                    | yes `/Subject`  | yes                                         |
| cover                  | yes                | not embedded           | yes (page 1)    | not embedded                                |
| keywords               | n/a                | n/a                    | yes `/Keywords` | read-only or optional                       |
| creator/producer/dates | n/a                | n/a                    | read-only       | read-only (auto)                            |

## Verification

- Rust: `just test-rust` (merge, preference CRUD, properties readers).
- Frontend: `just test-frontend`; add `metadataForm.test.ts`,
  `fileMetadataCapabilities.test.ts`, `MetadataPanel.test.tsx`; update
  `BookDetail.test.tsx`, `appState.test.ts`, `tests/mocks/bridge.ts`.
- E2E: extend `e2e/specs/metadata.e2e.ts`; `just test-e2e`.
- Full gate per phase: `just check`; `just coverage` when the migration/merge
  changes Rust behavior.
- Manual QA vs the mockup: EPUB + PDF detail, overridden vs inherited, File tab
  disabled fields, embed + `.bak`, preference toggle, reader/card values.

## Acceptance mapping

- Context-menu Edit Metadata stays functional → Phase 1/2.
- Detail shows all supported fields; file/library/effective distinguishable;
  divergent flagged → Phase 1.
- Inline library editing → Phase 2.
- Existing persistence/normalization reused → Phases 1–4.
- Supported file metadata editable + embed via atomic + backup; unsupported
  clearly library-only → Phase 3.
- Per-field preference persisted and applied → Phase 4.
- Immediate detail/card updates → existing `library-changed` refresh.
- Reset semantics; no corruption; multi-author; decimal series entry; no
  second editor → preserved by reuse and the extraction in Phase 0.

## Out of scope

Bulk editing (issue phase 5) and external metadata lookup (issue phase 6)
are not part of this plan; the non-goals in the issue remain.
