/**
 * Frontend domain types mirroring the Rust domain models (src-tauri/src/domain).
 * IPC DTOs serialize camelCase; these interfaces match that wire format.
 */

export type BookFormat = "epub" | "pdf";

/** Mirrors `domain::Book` including the derived `format` field. */
export interface Book {
  id: number;
  path: string;
  format: BookFormat;
  title: string;
  subtitle: string | null;
  author: string | null;
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  description: string | null;
  coverPath: string | null;
  addedAt: string;
  modifiedAt: string;
  lastOpenedAt: string | null;
  /** False when the source file has disappeared — the row waits for reconnection. */
  available: boolean;
  fileSize: number;
  fileMtime: number;
}

/**
 * Payload of the `library-changed` backend event: the filesystem watcher and
 * the remove/reconnect commands push every library mutation here so the UI
 * stays live without polling.
 */
export type LibraryChange = { kind: "changed"; book: Book } | { kind: "removed"; bookId: number };

export interface LibraryStats {
  bookCount: number;
  collectionCount: number;
}

/**
 * One full-text library search hit (mirrors `domain::SearchHit`). The
 * snippet comes from whichever indexed column matched best, with `<em>` /
 * `</em>` markers around the matching text.
 */
export interface SearchHit {
  bookId: number;
  title: string;
  author: string | null;
  snippet: string;
}

export interface ImportReport {
  imported: number;
  updated: number;
  failed: { path: string; error: string }[];
}

/**
 * Wire shape of a stored reading position (mirrors `domain::ReadingProgress`).
 * Fields are format-specific: EPUB locates a chapter href plus a CFI, PDF a
 * page number.
 */
export interface ReadingProgressRecord {
  bookId: number;
  chapterHref: string | null;
  cfi: string | null;
  characterOffset: number | null;
  pageNumber: number | null;
  scrollOffset: number | null;
  progressPercent: number | null;
  updatedAt: string;
}

/** Payload for saving a reading position; each format writes what it tracks. */
export interface ReadingProgressInput {
  chapterHref?: string | null;
  cfi?: string | null;
  characterOffset?: number | null;
  pageNumber?: number | null;
  scrollOffset?: number | null;
  progressPercent?: number | null;
}

/**
 * Reading progress must stay format-specific so the backend can resume the
 * reader at the exact location (task §15). EPUB uses a CFI string, PDF a page
 * number.
 */
export interface EpubReadingProgress {
  kind: "epub";
  cfi: string;
  percentage: number;
}

export interface PdfReadingProgress {
  kind: "pdf";
  page: number;
  percentage: number;
}

export type ReadingProgress = EpubReadingProgress | PdfReadingProgress;

/** Kind of a persistent reading annotation. */
export type AnnotationKind = "bookmark" | "highlight";

/** One highlight rect normalized to page space (0..1 on both axes). */
export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A persistent reading annotation (mirrors `domain::Annotation` with the
 * command layer's decoded `rects`). Locators are stable document
 * coordinates: EPUB carries a canonical CFI (+ spine href), PDF a 1-based
 * page number with an optional page-local fraction; PDF highlights also
 * carry normalized page-space rects so they redraw at any zoom.
 */
export interface Annotation {
  id: number;
  bookId: number;
  kind: AnnotationKind;
  cfi: string | null;
  chapterHref: string | null;
  pageNumber: number | null;
  pageFraction: number | null;
  text: string | null;
  color: string | null;
  rects: AnnotationRect[] | null;
  note: string | null;
  createdAt: string;
  modifiedAt: string;
}

/** Payload for creating a bookmark or highlight. */
export interface AnnotationInput {
  kind: AnnotationKind;
  cfi?: string | null;
  chapterHref?: string | null;
  pageNumber?: number | null;
  pageFraction?: number | null;
  text?: string | null;
  color?: string | null;
  rects?: AnnotationRect[] | null;
}

/**
 * Editable fields of an existing annotation. `note` replaces the stored
 * note: a string sets it (empty string clears), null keeps it.
 */
export interface AnnotationPatch {
  color?: string | null;
  note?: string | null;
}
