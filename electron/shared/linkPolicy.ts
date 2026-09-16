/**
 * External-link validation (issue #85, X-5): the single gate every
 * `shell.openExternal` call site goes through. A URL string, whatever its
 * origin in the renderer, publication metadata, or content, is either a
 * plain http(s) URL, re-serialized canonically, or it is dropped. Callers
 * never pass the raw input to shell; they pass this function's output.
 *
 * Shared with main and available to the renderer-side metadata work (issue
 * #78 M group) so both sides classify links identically.
 */

/** Upper bound for one external URL string. */
export const MAX_EXTERNAL_URL_LENGTH = 2048;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate `raw` as an external http(s) URL and return its canonical
 * `href` for `shell.openExternal`, or null when anything about it is not a
 * plain web URL. Rejects non-strings, control characters, script/data/file
 * and custom schemes, credentials, host-less URLs, and over-long input.
 */
export function parseExternalHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EXTERNAL_URL_LENGTH) return null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (url.hostname.length === 0) return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  return url.href;
}
