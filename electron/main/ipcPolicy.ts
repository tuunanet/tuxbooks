import {
  MAX_IMPORT_PATHS,
  MAX_IPC_PARAM_BYTES,
  SIDECAR_METHODS,
  isValidBookId,
  isValidLibraryPath,
  parseMemberPath,
} from "../shared/pathSchema";

/**
 * Renderer-facing invoke policy (docs/ARCHITECTURE.md, issue #84 T-5..T-7):
 * every `tuxbooks:invoke` is checked against the method allowlist, the
 * params shape, the per-method path schema, and the payload bound before
 * anything reaches the sidecar. Throwing `Error` here surfaces as a rejected
 * promise in the renderer; no detail beyond the policy reason is included.
 */

/** Dialog kinds whose returned paths may be used in later IPC calls. */
export type IssuedKind = "directory" | "book-file" | "book-files" | "cover-image" | "sync-folder";

/**
 * Paths the main process itself handed to the renderer through a native
 * dialog. Path-bearing calls that act on the filesystem accept only these:
 * a compromised renderer cannot point them at arbitrary locations, it can
 * only reuse what the user actually picked (T-1, T-7). `import_paths` is
 * exempt: drag-and-drop paths legitimately never passed a dialog.
 */
export class IssuedPaths {
  private readonly paths = new Map<IssuedKind, Set<string>>();

  issue(kind: IssuedKind, path: string): void {
    let set = this.paths.get(kind);
    if (!set) {
      set = new Set();
      this.paths.set(kind, set);
    }
    set.add(path);
  }

  has(kind: IssuedKind, path: string): boolean {
    return this.paths.get(kind)?.has(path) ?? false;
  }
}

function policyError(message: string): Error {
  return new Error(message);
}

function requireIssued(issued: IssuedPaths, kind: IssuedKind, value: unknown, label: string): void {
  if (typeof value !== "string" || !issued.has(kind, value)) {
    throw policyError(`${label} was not issued by this app`);
  }
}

function requireLibraryPath(value: unknown, label: string): void {
  if (typeof value !== "string" || !isValidLibraryPath(value)) {
    throw policyError(`invalid ${label}`);
  }
}

function requireBookId(params: Record<string, unknown>): void {
  if (!isValidBookId(params.bookId)) {
    throw policyError("invalid bookId");
  }
}

function requireByteRange(params: Record<string, unknown>): void {
  for (const key of ["offset", "length"]) {
    const value = params[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw policyError(`invalid byte range: ${key}`);
    }
  }
}

function requireResourcePath(params: Record<string, unknown>): void {
  const path = params.path;
  if (typeof path !== "string" || parseMemberPath(path) === null) {
    throw policyError("invalid resource path");
  }
}

/** Methods that act on a dialog-issued filesystem path. */
const ISSUED_PATH_METHODS = new Set([
  "scan_library",
  "reconnect_book",
  "relink_book",
  "attach_waiting_book",
  "set_book_cover",
  "sync_connect",
]);

const BOOK_ID_METHODS = new Set([
  "remove_book",
  "remove_book_file",
  "list_book_files",
  "list_book_editions",
  "reset_book_reading_data",
  "retry_indexing",
  "forget_book",
  "get_book_metadata",
  "reset_book_metadata",
  "clear_book_cover_override",
  "get_reading_progress",
  "save_reading_progress",
  "mark_book_finished",
  "mark_book_opened",
  "get_book_bytes",
  "get_epub_session",
  "get_book_resource",
  "list_annotations",
  "create_annotation",
]);

/**
 * Validate one renderer invoke. Throws with a policy reason when the call
 * must not reach the sidecar; returns silently when it may.
 */
export function validateInvokeParams(method: string, params: unknown, issued: IssuedPaths): void {
  if (!SIDECAR_METHODS.has(method)) {
    throw policyError(`method not allowed: ${method}`);
  }
  const record = requireObjectParams(params);

  if (ISSUED_PATH_METHODS.has(method)) {
    validateIssuedPaths(method, record, issued);
  }
  validateMethodShape(method, record);
}

/** Envelope checks shared by every invoke: object shape and size cap. */
function requireObjectParams(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw policyError("params must be an object");
  }
  if (JSON.stringify(params).length > MAX_IPC_PARAM_BYTES) {
    throw policyError("params too large");
  }
  return params as Record<string, unknown>;
}

/** Issued-path methods: the book id plus the per-method issued-path claim. */
function validateIssuedPaths(
  method: string,
  record: Record<string, unknown>,
  issued: IssuedPaths,
): void {
  if (method === "scan_library") {
    requireLibraryPath(record.path, "path");
    requireIssued(issued, "directory", record.path, "path");
    return;
  }
  if (method === "reconnect_book" || method === "relink_book") {
    requireBookId(record);
    requireLibraryPath(record.path, "path");
    requireIssued(issued, "book-file", record.path, "path");
    return;
  }
  if (method === "attach_waiting_book") {
    // The waiting book is named by its shared uid, not a local row id; the
    // picked file must be the one the dialog handed back.
    requireBookUid(record.bookUid);
    requireLibraryPath(record.path, "path");
    requireIssued(issued, "book-file", record.path, "path");
    return;
  }
  if (method === "sync_connect") {
    validateSyncConnect(record, issued);
    return;
  }
  if (method === "set_book_cover") {
    requireBookId(record);
  }
  requireIssued(issued, "cover-image", record.imagePath, "imagePath");
}

function validateSyncConnect(record: Record<string, unknown>, issued: IssuedPaths): void {
  requireLibraryPath(record.path, "path");
  requireIssued(issued, "sync-folder", record.path, "path");
  const deviceName = record.deviceName;
  if (
    deviceName !== undefined &&
    (typeof deviceName !== "string" || deviceName.trim().length === 0 || deviceName.length > 80)
  ) {
    throw policyError("invalid deviceName");
  }
  const confirmLibraryId = record.confirmLibraryId;
  if (
    confirmLibraryId !== undefined &&
    (typeof confirmLibraryId !== "string" || !/^[0-9a-f]{32}$/.test(confirmLibraryId))
  ) {
    throw policyError("invalid confirmLibraryId");
  }
  const startNew = record.startNew;
  if (startNew !== undefined && typeof startNew !== "boolean") {
    throw policyError("invalid startNew");
  }
  if (startNew === true && confirmLibraryId !== undefined) {
    throw policyError("choose either join or start new");
  }
}

/** Bulk Forget is a selection from loaded rows; bound it like a batch. */
const MAX_BULK_BOOK_IDS = 1000;

type ShapeCheck = (record: Record<string, unknown>) => void;

function requirePositiveId(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw policyError(`invalid ${label}`);
  }
}

function validatePathList(record: Record<string, unknown>): void {
  // The two path-list methods are not issued-path methods: drag-and-drop
  // never passes a dialog (`import_paths`), and `unwatch_locations` names
  // rows the renderer read back from `get_storage_stats`. Neither can be
  // gated on a dialog claim, so both are bound to the path schema and the
  // count instead.
  const paths = record.paths;
  if (
    !Array.isArray(paths) ||
    paths.length > MAX_IMPORT_PATHS ||
    paths.some((candidate) => typeof candidate !== "string" || !isValidLibraryPath(candidate))
  ) {
    throw policyError("invalid paths");
  }
}

function validateSearchQuery(record: Record<string, unknown>): void {
  if (typeof record.query !== "string") throw policyError("invalid query");
}

function validateOptionalSearchQuery(record: Record<string, unknown>): void {
  if (record.query !== undefined && typeof record.query !== "string") {
    throw policyError("invalid query");
  }
}

function validateCollectionName(record: Record<string, unknown>): void {
  if (typeof record.name !== "string") throw policyError("invalid name");
}

function validateForgetBooks(record: Record<string, unknown>): void {
  const ids = record.bookIds;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_BULK_BOOK_IDS ||
    ids.some((id) => !isValidBookId(id))
  ) {
    throw policyError("invalid bookIds");
  }
}

function validateRestoreBook(record: Record<string, unknown>): void {
  requirePositiveId(record.trashId, "trashId");
  const mode = record.mode;
  if (mode !== undefined && mode !== "replace" && mode !== "keep" && mode !== "merge") {
    throw policyError("invalid restore mode");
  }
}

function validateSyncId(record: Record<string, unknown>): void {
  requirePositiveId(record.id, "sync id");
}

const CONFLICT_RESOLUTIONS = new Set(["keep_winner", "apply_loser"]);

function validateSyncConflictResolution(record: Record<string, unknown>): void {
  requirePositiveId(record.id, "sync conflict id");
  const resolution = record.resolution;
  if (typeof resolution !== "string" || !CONFLICT_RESOLUTIONS.has(resolution)) {
    throw policyError("invalid conflict resolution");
  }
}

function validateSyncDeviceName(record: Record<string, unknown>): void {
  const name = record.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) {
    throw policyError("invalid device name");
  }
}

function validateBookFile(record: Record<string, unknown>): void {
  requireBookId(record);
  requirePositiveId(record.fileId, "fileId");
}

function validateEditionLink(record: Record<string, unknown>): void {
  requirePositiveId(record.sourceBookId, "sourceBookId");
  requirePositiveId(record.targetBookId, "targetBookId");
  if (record.sourceBookId === record.targetBookId) {
    throw policyError("an edition link needs two different books");
  }
}

const BOOK_UID_RE = /^[0-9a-f]{32}$/;
const PROVIDER_STATUSES = new Set(["want_to_read", "reading", "paused", "finished", "dropped"]);

function requireBookUid(value: unknown): void {
  if (typeof value !== "string" || !BOOK_UID_RE.test(value)) {
    throw policyError("invalid bookUid");
  }
}

function requireNonEmptyString(value: unknown, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw policyError(`invalid ${label}`);
  }
}

function validateBookUidRecord(record: Record<string, unknown>): void {
  requireBookUid(record.bookUid);
}

function validateProviderLink(record: Record<string, unknown>): void {
  requireBookUid(record.bookUid);
  requireNonEmptyString(record.provider, "provider", 64);
  requireNonEmptyString(record.remoteId, "remoteId", 512);
}

function validateProviderUnlink(record: Record<string, unknown>): void {
  requireBookUid(record.bookUid);
  requireNonEmptyString(record.provider, "provider", 64);
}

function validateProviderUpdate(record: Record<string, unknown>): void {
  requireBookUid(record.bookUid);
  requireNonEmptyString(record.provider, "provider", 64);
  const status = record.status;
  if (
    status !== undefined &&
    status !== null &&
    (typeof status !== "string" || !PROVIDER_STATUSES.has(status))
  ) {
    throw policyError("invalid provider status");
  }
  const progress = record.progressPercent;
  if (
    progress !== undefined &&
    progress !== null &&
    (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 100)
  ) {
    throw policyError("invalid progressPercent");
  }
}

function validateBookResource(record: Record<string, unknown>): void {
  requireBookId(record);
  requireResourcePath(record);
}

function validateBookBytes(record: Record<string, unknown>): void {
  requireBookId(record);
  requireByteRange(record);
}

/** Explicit shapes for methods that need more than a book id. */
const METHOD_SHAPES = new Map<string, ShapeCheck>([
  ["import_paths", validatePathList],
  ["unwatch_locations", validatePathList],
  ["search_books", validateSearchQuery],
  ["list_reading_history", validateOptionalSearchQuery],
  ["create_collection", validateCollectionName],
  ["forget_books", validateForgetBooks],
  ["restore_book", validateRestoreBook],
  ["sync_dismiss_issue", validateSyncId],
  ["sync_retry_issue", validateSyncId],
  ["sync_restore", validateSyncId],
  ["sync_resolve_conflict", validateSyncConflictResolution],
  ["sync_set_device_name", validateSyncDeviceName],
  ["remove_book_file", validateBookFile],
  ["link_book_edition", validateEditionLink],
  ["forget_waiting_book", validateBookUidRecord],
  ["list_provider_links", validateBookUidRecord],
  ["link_provider_book", validateProviderLink],
  ["unlink_provider_book", validateProviderUnlink],
  ["apply_provider_reading_update", validateProviderUpdate],
  ["get_book_resource", validateBookResource],
  ["get_book_bytes", validateBookBytes],
]);

for (const method of BOOK_ID_METHODS) {
  if (!METHOD_SHAPES.has(method)) METHOD_SHAPES.set(method, requireBookId);
}

/** Per-method parameter shapes that do not carry issued paths. */
function validateMethodShape(method: string, record: Record<string, unknown>): void {
  METHOD_SHAPES.get(method)?.(record);
}
