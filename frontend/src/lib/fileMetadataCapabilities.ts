import type { BookFormat } from "@/types/domain";

/**
 * Editable bibliographic fields, mirroring `MetadataFormState`. Used to gate
 * the File Metadata tab to what each format's writer can actually store.
 */
export type MetadataFieldKey =
  | "title"
  | "subtitle"
  | "authors"
  | "publisher"
  | "language"
  | "isbn"
  | "publicationDate"
  | "series"
  | "seriesIndex"
  | "subjects"
  | "description";

/**
 * What `epub::write_metadata` / `pdf::write_metadata` actually store
 * (`docs/EPUB.md`, `docs/PDF.md`): EPUB regenerates every managed text field;
 * PDF has a faithful document-info field only for title, author, and subject
 * (description). Everything else stays a library override.
 */
const WRITABLE: Record<BookFormat, ReadonlySet<MetadataFieldKey>> = {
  epub: new Set<MetadataFieldKey>([
    "title",
    "subtitle",
    "authors",
    "publisher",
    "language",
    "isbn",
    "publicationDate",
    "series",
    "seriesIndex",
    "subjects",
    "description",
  ]),
  pdf: new Set<MetadataFieldKey>(["title", "authors", "description"]),
};

/** Whether an embed writes this field into a file of the given format. */
export function isFileWritable(format: BookFormat, field: MetadataFieldKey): boolean {
  return WRITABLE[format].has(field);
}
