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
export type IssuedKind = "directory" | "book-file" | "book-files" | "cover-image";

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
const ISSUED_PATH_METHODS = new Set(["scan_library", "reconnect_book", "set_book_cover"]);

const BOOK_ID_METHODS = new Set([
  "remove_book",
  "get_book_metadata",
  "get_book_file_properties",
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
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw policyError("params must be an object");
  }
  const record = params as Record<string, unknown>;

  if (JSON.stringify(params).length > MAX_IPC_PARAM_BYTES) {
    throw policyError("params too large");
  }

  if (ISSUED_PATH_METHODS.has(method)) {
    if (method === "reconnect_book" || method === "set_book_cover") {
      requireBookId(record);
    }
    if (method === "scan_library") {
      requireLibraryPath(record.path, "path");
      requireIssued(issued, "directory", record.path, "path");
    } else if (method === "reconnect_book") {
      requireLibraryPath(record.path, "path");
      requireIssued(issued, "book-file", record.path, "path");
    } else {
      requireIssued(issued, "cover-image", record.imagePath, "imagePath");
    }
  }

  if (method === "import_paths") {
    const paths = record.paths;
    if (
      !Array.isArray(paths) ||
      paths.length > MAX_IMPORT_PATHS ||
      paths.some((candidate) => typeof candidate !== "string" || !isValidLibraryPath(candidate))
    ) {
      throw policyError("invalid paths");
    }
  }

  if (method === "search_books" && typeof record.query !== "string") {
    throw policyError("invalid query");
  }

  if (method === "create_collection" && typeof record.name !== "string") {
    throw policyError("invalid name");
  }

  if (BOOK_ID_METHODS.has(method)) {
    requireBookId(record);
  }

  if (method === "get_book_resource") {
    requireBookId(record);
    requireResourcePath(record);
  }

  if (method === "get_book_bytes") {
    requireBookId(record);
    requireByteRange(record);
  }
}
