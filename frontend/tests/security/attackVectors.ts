/**
 * Negative-path attack corpus for the tuxbooks:// and IPC boundary tests
 * (issue #84 T-1..T-3, T-7). Shared so the corpus/boundary test task (#87)
 * can import and extend the same vectors instead of re-deriving them.
 * Every string here is hostile input built at runtime; nothing is committed
 * as a fixture.
 */

/** Member paths that must never be served (plain traversal shapes). */
export const TRAVERSAL_MEMBER_PATHS: readonly string[] = [
  "../secret.txt",
  "../../etc/passwd",
  "a/../../b",
  "OEBPS/../../../x",
  "..\\windows\\system32",
  "OEBPS\\..\\..\\x",
  "/etc/passwd",
  "C:/Windows/system32/config",
  "\\windows",
  "a\0b",
  "OEBPS/\x01x",
  "OEBPS/\x7fx",
  "line\nbreak",
];

/** Single-encoded traversal: decodes once into a plain traversal shape. */
export const ENCODED_TRAVERSAL_MEMBERS: readonly string[] = [
  "%2e%2e%2fsecret",
  "%2e%2e/secret",
  "..%2fsecret",
  ".%2e/secret",
  "%2e%2e%5csecret",
];

/**
 * Double-encoded traversal decodes once into a literal percent string, which
 * is a legal ZIP member name that simply misses. It must fail closed (404),
 * never escape.
 */
export const DOUBLE_ENCODED_TRAVERSAL_MEMBERS: readonly string[] = [
  "%252e%252e%252fsecret",
  "%252e%252e/secret",
];

/** Book id path segments that must be rejected as 400. */
export const BAD_BOOK_IDS: readonly string[] = [
  "0",
  "-1",
  "5x",
  "x5",
  "",
  "abc",
  "1.5",
  " 1",
  "+1",
  "1e3",
  "99999999999999999999",
  "0x10",
];

/** Range headers that must fail closed (416), never serve the whole file. */
export const BAD_RANGES: readonly string[] = [
  "bytes=",
  "bytes=--",
  "bytes=abc-",
  "bytes=-abc",
  "bytes=5-2",
  "bytes=1-2,3-4",
  "bytes=1e3-",
  "bytes=0-99999999999999999999",
  "bytes=99999999999999999999-",
  "bytes=+1-",
];

/**
 * Filesystem paths a compromised renderer must never be able to turn into a
 * cover URL. The cover route accepts file names only.
 */
export const ABSOLUTE_COVER_PATHS: readonly string[] = [
  "/home/user/.ssh/id_rsa",
  "/etc/shadow",
  "/home/user/.local/share/com.tuxbooks.app/tuxbooks.db",
  "/home/user/.local/share/com.tuxbooks.app/covers",
  "../../etc/shadow",
  "sub/dir/cover.png",
];

/** URLs that try to leave the tuxbooks:// scheme/host allowlist. */
export const SCHEME_CONFUSION_URLS: readonly string[] = [
  "http://book/1",
  "https://book/1",
  "file:///etc/passwd",
  "tuxbooks://evil/1",
  "tuxbooks://evil/cover/a.png",
  "app://bundle/index.html",
];

/** Valid absolute library paths (for the schema's shape validator). */
export const VALID_LIBRARY_PATHS: readonly string[] = [
  "/home/user/Books",
  "/mnt/data/library",
  "/tmp/tuxbooks-import",
];

/** Path shapes that fail the absolute-path schema validation. */
export const INVALID_LIBRARY_PATHS: readonly string[] = [
  "",
  "relative/path",
  "./relative",
  "/x/../y",
  "/a/./b",
  "/a//b",
  "/a/\0b",
  "/a\nb",
  `/${"a".repeat(4097)}`,
  "C:\\Users\\me\\Books",
];

export function bookBytesUrl(bookId: string, format?: string): string {
  const query = format === undefined ? "" : `?format=${format}`;
  return `tuxbooks://book/${bookId}${query}`;
}

export function bookResourceUrl(bookId: string, member: string): string {
  return `tuxbooks://book/${bookId}/${member}`;
}

export function coverUrl(name: string): string {
  return `tuxbooks://cover/${name}`;
}

/** Range header value for an "ok" range request. */
export function rangeHeader(start: number | "", end: number | ""): string {
  return `bytes=${start}-${end}`;
}
