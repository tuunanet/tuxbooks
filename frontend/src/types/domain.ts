/**
 * Frontend domain types mirroring the Rust domain models (sidecar/src/domain).
 * IPC DTOs serialize camelCase; these interfaces match that wire format.
 */

export type BookFormat = "epub" | "pdf";

/** Mirrors `domain::Book` including the derived `format` field. */
export interface Book {
  id: number;
  /** Stable durable identity (ADR 0014); several files can share it. */
  bookUid?: string | null;
  path: string;
  format: BookFormat;
  title: string;
  subtitle: string | null;
  /** Display projection of the (possibly multiple) authors, joined with ", ". */
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
  /** Effective (override-over-source) publication date. */
  publicationDate: string | null;
  /** Effective series membership, resolved through the backend `series` table. */
  seriesId: number | null;
  seriesIndex: number | null;
  seriesName: string | null;
  /** Coarse reading position (0..=100); null = never opened. */
  progressPercent: number | null;
  /** When the reading position was last saved. */
  progressUpdatedAt: string | null;
  /** Third-party links owned by this durable book (ADR 0014 D11). */
  providerLinks?: ProviderLink[];
}

/**
 * One file location of a durable book (mirrors `domain::BookFile`, ADR 0014
 * D7). Several locations share the same book entry and its reading state.
 */
export interface BookFile {
  /** Internal file-row id, used to remove this copy (never a public book id). */
  id: number;
  path: string;
  available: boolean;
  fileSize: number;
  fileMtime: number;
  addedAt: string;
  /** The copy the reader opens: available first, then the lowest row id. */
  active: boolean;
}

/** A provider's cached reading status; TuxBooks progress stays in `progressPercent`. */
export type ProviderReadingStatus = "want_to_read" | "reading" | "paused" | "finished" | "dropped";

/** One link between a durable book and the same book on a third-party service. */
export interface ProviderLink {
  bookUid: string;
  provider: string;
  remoteId: string;
  status: ProviderReadingStatus | null;
  statusUpdatedAt: string | null;
  linkedAt: string;
  updatedAt: string;
}

/**
 * One durable book linked to another as a different edition of the same work
 * (ADR 0014 D9). The books stay separate identities; only progress percentage
 * and provider links move across a confirmed link.
 */
export interface EditionBook {
  id: number;
  bookUid: string;
  title: string | null;
  author: string | null;
  /** False when the linked edition is currently in Reading history. */
  inLibrary: boolean;
}

/** Result of one confirmed cross-edition link. */
export interface EditionLinkOutcome {
  sourceBookId: number;
  targetBookId: number;
  sourceBookUid: string;
  targetBookUid: string;
  /** The percentage seeded into the target, or null when nothing was copied. */
  copiedProgressPercent: number | null;
  /** Providers whose link and cached status moved to the target edition. */
  movedProviders: string[];
}

/** A user-defined collection with its member book ids (mirrors `domain::CollectionSummary`). */
export interface CollectionSummary {
  id: number;
  name: string;
  createdAt: string;
  bookIds: number[];
}

/** One complete set of bibliographic metadata (mirrors `domain::MetadataFields`). */
export interface MetadataFields {
  title: string;
  subtitle: string | null;
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  description: string | null;
  publicationDate: string | null;
  series: string | null;
  seriesIndex: number | null;
  authors: string[];
  subjects: string[];
}

/** Which fields a user has overridden away from the source-file values. */
export interface MetadataOverridden {
  title: boolean;
  subtitle: boolean;
  publisher: boolean;
  language: boolean;
  isbn: boolean;
  description: boolean;
  publicationDate: boolean;
  series: boolean;
  cover: boolean;
  authors: boolean;
  subjects: boolean;
}

/**
 * Full curation view of one book (mirrors `domain::BookMetadata`): the
 * effective metadata, the untouched source-file values, and which fields
 * differ. Overrides live in the library database; saving writes the fields
 * the format supports into the file as well.
 */
export interface BookMetadata {
  bookId: number;
  effective: MetadataFields;
  source: MetadataFields;
  overridden: MetadataOverridden;
  coverPath: string | null;
  /** The extracted source-file cover; differs from `coverPath` when overridden. */
  sourceCoverPath: string | null;
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
 * One Reading-history row (mirrors `domain::ReadingHistoryBook`): a durable
 * book with no file rows. `id` is the durable book id and stays the stable
 * `bookId` even while there is no file to read.
 */
export interface ReadingHistoryBook {
  id: number;
  bookUid: string;
  title: string | null;
  author: string | null;
  coverPath: string | null;
  progressPercent: number | null;
  annotationCount: number;
  lastOpenedAt: string | null;
  metadataState: "available" | "waiting_for_file";
  /** Links that outlived the book's file rows. */
  providerLinks?: ProviderLink[];
}

/** How to resolve a restore when the fresh identity already has new state. */
export type RestoreMode = "replace" | "keep" | "merge";

export type RestoreStatus = "restored" | "kept" | "conflict" | "not_found";

/** The new progress/annotations that make a restore ambiguous. */
export interface RestoreConflict {
  progressPercent: number | null;
  annotationCount: number;
}

/** Result of `restore_book` (mirrors `domain::RestoreOutcome`). */
export interface RestoreOutcome {
  status: RestoreStatus;
  bookId: number | null;
  bookUid: string | null;
  conflict: RestoreConflict | null;
}

/** Result of forgetting one book (mirrors `domain::ForgetOutcome`). */
export interface ForgetOutcome {
  forgottenBookId: number;
  /** Fresh identity when the file stayed in the library; null with no file. */
  replacementBookId: number | null;
  trashId: number;
}

/** Result of forgetting a selection (mirrors `domain::BulkForgetOutcome`). */
export interface BulkForgetOutcome {
  forgotten: number;
  trashIds: number[];
}

/** One Forgotten book restorable inside the 30-day window. */
export interface BookTrashEntry {
  id: number;
  bookId: number;
  bookUid: string;
  title: string | null;
  author: string | null;
  deletedAt: string;
  expiresAt: string;
  progressPercent: number | null;
  annotationCount: number;
  /** Fresh identity the file was rebound to, when it stayed in the library. */
  replacementBookId: number | null;
  /** True when the fresh identity has progress or annotations; Restore needs a choice. */
  hasNewState: boolean;
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
  /** Files whose size+mtime still matched the stored row — never re-parsed. */
  skipped: number;
  failed: { path: string; error: string }[];
  /** Folders this run newly registered as watched locations. */
  watched: string[];
  /**
   * Folders this run declined to register because a watched folder above
   * already covers them (ADR 0010). Their books still arrive, so the report
   * says where they came from instead of naming a watch that never started.
   */
  covered: string[];
  /** The run stopped because its folder was unwatched mid-scan. */
  cancelled?: boolean;
}

/**
 * Wire shape of a stored reading position (mirrors `domain::ReadingProgress`).
 * Fields are format-specific: EPUB locates a Readium locator (`locator` +
 * `locations` JSON written by the Readium reader; `cfi`/`chapterHref` keep
 * the foliate-era locator as provenance until the migration adapter has
 * converted the row), PDF a page number. `engine`/`schemaVersion` mark the
 * conversion state of the row.
 */
export interface ReadingProgressRecord {
  bookId: number;
  chapterHref: string | null;
  cfi: string | null;
  characterOffset: number | null;
  pageNumber: number | null;
  scrollOffset: number | null;
  progressPercent: number | null;
  locator: string | null;
  progression: number | null;
  locations: string | null;
  engine: string | null;
  schemaVersion: number | null;
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
  locator?: string | null;
  progression?: number | null;
  locations?: string | null;
  engine?: string | null;
  schemaVersion?: number | null;
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
  /** Short bookmark label, capped at 50 characters. */
  label: string | null;
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
  /** Replaces the label; an empty string clears it, omitted keeps it. */
  label?: string | null;
  note?: string | null;
}
