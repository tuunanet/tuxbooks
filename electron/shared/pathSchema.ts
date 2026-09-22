import path from "node:path";

/**
 * The validated path/query schema for the renderer-facing boundary
 * (docs/ARCHITECTURE.md, issue #84 T-1..T-7): book ids, EPUB member paths,
 * cover file names, absolute library paths, range headers, and fixed MIME
 * tables, shared by the Electron main process, the preload bridge, and the
 * boundary tests. Every parser returns null (or a typed "invalid" marker)
 * instead of throwing, so callers fail closed.
 *
 * The renderer names books and covers; it never names filesystem paths.
 */

/** Largest JSON-safe value of the sidecar's i64 row ids. */
export const MAX_SAFE_I64 = Number.MAX_SAFE_INTEGER;

export const MAX_MEMBER_PATH_LENGTH = 1024;
export const MAX_LIBRARY_PATH_LENGTH = 4096;
export const MAX_IMPORT_PATHS = 1000;

/** Cap on the JSON text of one renderer invoke's params. */
export const MAX_IPC_PARAM_BYTES = 8 << 20;

/** Cap on the JSON text of one request line sent to the sidecar. */
export const MAX_SIDECAR_REQUEST_BYTES = 8 << 20;

/**
 * Cap on one buffered response line from the sidecar. A whole-book fetch is
 * the largest legitimate line: the sidecar's 1 GiB source-file quota is
 * ~1.4 GiB as base64 inside the JSON envelope, so 2 GiB bounds runaway
 * growth without clipping a legal read. Keep above the sidecar quota.
 * (Written as multiplication, not `2 << 30`: the 32-bit signed shift
 * overflows to a negative cap, which drops every line.)
 */
export const MAX_RESPONSE_LINE_BYTES = 2 * 1024 * 1024 * 1024;

const BOOK_ID_PATTERN = /^\d+$/;

/** Parse a book-id URL segment: digits only, positive, JSON-safe. */
export function parseBookId(raw: string): number | null {
  if (!BOOK_ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

/** Type guard for renderer-supplied book ids (preload/bridge arguments). */
export function isValidBookId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate an EPUB member path (already decoded exactly once). It must stay
 * inside the logical publication root: relative, forward slashes only, no
 * `..` segment, no NUL or control characters, bounded length. Returns the
 * validated path or null.
 */
export function parseMemberPath(decoded: string): string | null {
  if (decoded.length === 0 || decoded.length > MAX_MEMBER_PATH_LENGTH) return null;
  if (decoded.startsWith("/") || decoded.includes("\\")) return null;
  if (decoded.includes("\0")) return null;
  for (const char of decoded) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  if (segments.some((segment) => /^[A-Za-z]:$/.test(segment))) return null;
  return decoded;
}

const COVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg|gif|webp)$/i;

/**
 * Validate a cover reference. Covers are flat generated file names inside
 * the artwork cache; the renderer may never send a directory-qualified or
 * path-bearing value.
 */
export function parseCoverName(decoded: string): string | null {
  return COVER_NAME_PATTERN.test(decoded) ? decoded : null;
}

/**
 * Shape-check an absolute filesystem path supplied through a user-driven IPC
 * call (scan root, import target, reconnect file). It must be absolute on
 * this platform, already normalized (no `..`/`.`/duplicate segments), free
 * of NUL and control characters, and bounded in length. This validates
 * shape, not authority; authority comes from the user picking the path.
 */
export function isValidLibraryPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_LIBRARY_PATH_LENGTH) return false;
  if (!path.isAbsolute(candidate)) return false;
  if (candidate.includes("\0")) return false;
  for (const char of candidate) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return path.normalize(candidate) === candidate;
}

/** Result of parsing a `Range` header. */
export type RangeParse =
  { kind: "none" } | { kind: "invalid" } | { kind: "ok"; start?: number; end?: number };

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * Parse a single `bytes=start-end` range header (open ends allowed). A
 * missing header is "none"; anything malformed, multi-range, or outside the
 * safe-integer domain is "invalid" so the caller can answer 416 instead of
 * serving the whole file.
 */
export function parseRangeHeader(header: string | null): RangeParse {
  if (!header) return { kind: "none" };
  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return { kind: "invalid" };
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "invalid" };
  const start = rawStart === "" ? undefined : Number(rawStart);
  const end = rawEnd === "" ? undefined : Number(rawEnd);
  for (const value of [start, end]) {
    if (value !== undefined && !Number.isSafeInteger(value)) return { kind: "invalid" };
  }
  if (start !== undefined && end !== undefined && end < start) return { kind: "invalid" };
  return { kind: "ok", start, end };
}

/** decodeURIComponent that fails closed on malformed sequences. */
export function decodeUriComponentSafe(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function mimeTypeForExtension(
  name: string,
  table: Record<string, string>,
  fallback: string,
): string {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return table[extension] ?? fallback;
}

const OCTET_STREAM = "application/octet-stream";

/** Type guard for the fixed set of book source formats. */
export function isValidBookFormat(value: unknown): value is "epub" | "pdf" {
  return value === "epub" || value === "pdf";
}

/** Fixed content type for a stored book's source bytes, by format query. */
export function bookSourceMime(format: string | null): string {
  if (format === "epub") return "application/epub+zip";
  if (format === "pdf") return "application/pdf";
  return OCTET_STREAM;
}

/**
 * Fixed content type for an EPUB ZIP member, by file extension. Mirrors the
 * sidecar's `guess_member_media_type` table; the protocol handler uses this
 * instead of any wire-provided media-type string (T-4).
 */
export function memberMime(member: string): string {
  return mimeTypeForExtension(
    member,
    {
      xhtml: "application/xhtml+xml",
      html: "text/html",
      htm: "text/html",
      css: "text/css",
      js: "text/javascript",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      ncx: "application/x-dtbncx+xml",
      opf: "application/oebps-package+xml",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      m4v: "video/mp4",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      ogv: "video/ogg",
      webm: "video/webm",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      otf: "font/otf",
      xml: "application/xml",
      txt: "text/plain",
    },
    OCTET_STREAM,
  );
}

/** Fixed content type for a cover file, by extension. */
export function coverMime(name: string): string {
  return mimeTypeForExtension(
    name,
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    },
    OCTET_STREAM,
  );
}

/**
 * The renderer may only call these sidecar methods through the bridge —
 * an explicit allowlist, not a passthrough (T-5).
 */
export const SIDECAR_METHODS: ReadonlySet<string> = new Set([
  "ping",
  "get_library_stats",
  "get_storage_stats",
  "list_books",
  "search_books",
  "remove_book",
  "scan_library",
  "import_paths",
  "reconnect_book",
  "get_book_metadata",
  "get_book_file_properties",
  "update_book_metadata",
  "reset_book_metadata",
  "set_metadata_field_source",
  "set_book_cover",
  "clear_book_cover_override",
  "embed_book_metadata",
  "get_reading_progress",
  "save_reading_progress",
  "mark_book_finished",
  "mark_book_opened",
  "get_book_bytes",
  "get_epub_session",
  "get_book_resource",
  "list_collections",
  "create_collection",
  "delete_collection",
  "add_book_to_collection",
  "remove_book_from_collection",
  "list_annotations",
  "create_annotation",
  "update_annotation",
  "delete_annotation",
]);

/** Stable ids for the two app-owned storage roots. */
export type StorageRootId = "app-data" | "app-config";

/** Type guard for renderer-supplied storage root ids. */
export function isStorageRootId(value: unknown): value is StorageRootId {
  return value === "app-data" || value === "app-config";
}

/** The only ipcMain channels the preload may touch. */
export const IPC_CHANNELS = {
  invoke: "tuxbooks:invoke",
  dialog: "tuxbooks:dialog",
  reveal: "tuxbooks:reveal",
  storageReport: "tuxbooks:storage-report",
  openDataFolder: "tuxbooks:open-data-folder",
  event: "tuxbooks:event",
} as const;

/**
 * Privileged scheme declarations, registered before app ready so the flags
 * apply to every navigation and fetch. corsEnabled matters: the renderer
 * origin fetch()es these schemes cross-origin, and Chromium refuses
 * non-CORS-enabled schemes before the handler even runs.
 */
export const PRIVILEGED_SCHEMES = [
  {
    scheme: "tuxbooks",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    // The built renderer's own origin. A standard, secure scheme — not
    // file:// — because opaque file origins leak into blob: child frames
    // (the reader engines' sandboxed section documents), whose postMessage
    // then fails with "Invalid target origin 'null'". app:// keeps the page
    // and its blob frames same-origin.
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
] as const;

/** Origin of the built renderer page, served over the app scheme. */
export const APP_ORIGIN = "app://bundle";

/**
 * Whether an ipcMain invocation came from the application's own page: the
 * built app://bundle origin, or the dev server when one is configured
 * (T-6). Anything else — file:, extensions, other frames — is rejected.
 */
export function isAllowedSenderUrl(raw: string, devServerUrl: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "app:") return url.host === "bundle";
  if (devServerUrl !== undefined) {
    try {
      return url.origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}
