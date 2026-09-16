import {
  bookSourceMime,
  coverMime,
  decodeUriComponentSafe,
  memberMime,
  parseBookId,
  parseCoverName,
  parseMemberPath,
  parseRangeHeader,
} from "../shared/pathSchema";

/**
 * Pure `tuxbooks://` request handling (docs/ARCHITECTURE.md, issue #84
 * T-1..T-4): URL routing, validation, range slicing, and response headers
 * against injected byte sources. No Electron, no filesystem imports — the
 * main process wires the sidecar calls and the cover reader into
 * `handleProtocolRequest`, which keeps every decision unit-testable.
 *
 * All error bodies are fixed strings; upstream failure details, which can
 * contain paths, never reach the response (T-4).
 */

/** Signals "the requested book, member, or cover does not exist" (404). */
export class NotFoundError extends Error {}

interface ByteRange {
  start?: number;
  end?: number;
}

/** Byte sources the protocol serves from; all failures are closed. */
export interface BookSources {
  getBookBytes(
    bookId: number,
    offset?: number,
    length?: number,
  ): Promise<{ data: string; offset: number; total: number }>;
  getBookResource(
    bookId: number,
    member: string,
    offset?: number,
    length?: number,
  ): Promise<{ data: string; offset: number; total: number; mediaType: string }>;
  readCover(name: string): Promise<Uint8Array>;
}

const CORS = { "access-control-allow-origin": "*" } as const;

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", ...CORS } });
}

function asBody(bytes: Uint8Array): BodyInit {
  // Buffers are ArrayBuffer-backed at runtime; the cast only bridges the
  // DOM type's ArrayBuffer-specific variance and avoids copying book-sized
  // payloads.
  return bytes as unknown as BodyInit;
}

function bytesResponse(
  bytes: Uint8Array,
  contentType: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(asBody(bytes), {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.length),
      "accept-ranges": "bytes",
      ...extra,
      ...CORS,
    },
  });
}

/**
 * Handle one protocol request. Never throws: any unexpected failure becomes
 * a fixed 500. Returns 404 for `NotFoundError`, 400/405/416 for rejected
 * inputs, and the fixed-body 500 for everything else.
 */
export async function handleProtocolRequest(
  request: { url: string; method: string; headers: { get(name: string): string | null } },
  sources: BookSources,
): Promise<Response> {
  try {
    if (request.method !== "GET") return textResponse(405, "method not allowed");

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse(400, "malformed url");
    }
    if (url.protocol !== "tuxbooks:") return textResponse(404, "not found");

    // tuxbooks://book/<id>?format=epub|pdf — a stored book's source bytes.
    // tuxbooks://book/<id>/<encoded member path> — one EPUB ZIP member for
    // the Readium navigator, percent-encoded exactly like the manifest's
    // hrefs and decoded exactly once here.
    if (url.host === "book") return await serveBook(url, request, sources);

    // tuxbooks://cover/<name> — artwork-cache cover file. The renderer sends
    // a flat file name, never a path; the handler resolves it inside the
    // covers directory (T-1, T-3).
    if (url.host === "cover") return await serveCover(url, sources);

    return textResponse(404, "not found");
  } catch {
    return textResponse(500, "internal error");
  }
}

async function serveBook(
  url: URL,
  request: { headers: { get(name: string): string | null } },
  sources: BookSources,
): Promise<Response> {
  const rest = url.pathname.slice(1);
  const slash = rest.indexOf("/");
  const bookId = parseBookId(slash === -1 ? rest : rest.slice(0, slash));
  if (bookId === null) return textResponse(400, "invalid book id");
  if (slash === -1) return await serveBookBytes(url, request, sources, bookId);

  const decoded = decodeUriComponentSafe(rest.slice(slash + 1));
  const member = decoded === null ? null : parseMemberPath(decoded);
  if (member === null) return textResponse(400, "invalid member path");
  return await serveBookResource(request, sources, bookId, member);
}

async function serveBookBytes(
  url: URL,
  request: { headers: { get(name: string): string | null } },
  sources: BookSources,
  bookId: number,
): Promise<Response> {
  const range = parseRangeHeader(request.headers.get("range"));
  if (range.kind === "invalid") {
    return textResponse(416, "invalid range");
  }
  const requested: ByteRange = range.kind === "ok" ? range : {};
  try {
    if (requested.start !== undefined) {
      const end = requested.end ?? Number.MAX_SAFE_INTEGER;
      const payload = await sources.getBookBytes(
        bookId,
        requested.start,
        end - requested.start + 1,
      );
      if (requested.start >= payload.total) {
        return new Response("range not satisfiable", {
          status: 416,
          headers: { "content-range": `bytes */${payload.total}`, ...CORS },
        });
      }
      const bytes = Buffer.from(payload.data, "base64");
      return bytesResponse(bytes, bookSourceMime(url.searchParams.get("format")), 206, {
        "content-range": `bytes ${payload.offset}-${payload.offset + bytes.length - 1}/${payload.total}`,
      });
    }
    // No range, or a suffix range (bytes=-N) which the source cannot seek
    // for: serve the whole file and let the client slice.
    const payload = await sources.getBookBytes(bookId);
    const bytes = Buffer.from(payload.data, "base64");
    return bytesResponse(bytes, bookSourceMime(url.searchParams.get("format")), 200);
  } catch (error) {
    return sourceError(error);
  }
}

async function serveBookResource(
  request: { headers: { get(name: string): string | null } },
  sources: BookSources,
  bookId: number,
  member: string,
): Promise<Response> {
  const range = parseRangeHeader(request.headers.get("range"));
  if (range.kind === "invalid") {
    return textResponse(416, "invalid range");
  }
  const requested: ByteRange = range.kind === "ok" ? range : {};
  try {
    const payload = await sources.getBookResource(
      bookId,
      member,
      requested.start,
      requested.start !== undefined
        ? (requested.end ?? Number.MAX_SAFE_INTEGER) - requested.start + 1
        : undefined,
    );
    if (requested.start !== undefined && requested.start >= payload.total) {
      return new Response("range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${payload.total}`, ...CORS },
      });
    }
    // The source applies the range itself; payload.data is the sliced
    // window starting at payload.offset.
    const bytes = Buffer.from(payload.data, "base64");
    // The content type comes from the fixed extension table, never from the
    // wire payload's mediaType string (T-4).
    return bytesResponse(
      bytes,
      memberMime(member),
      requested.start !== undefined ? 206 : 200,
      requested.start !== undefined
        ? {
            "content-range": `bytes ${payload.offset}-${payload.offset + bytes.length - 1}/${payload.total}`,
          }
        : {},
    );
  } catch (error) {
    return sourceError(error);
  }
}

async function serveCover(url: URL, sources: BookSources): Promise<Response> {
  const decoded = decodeUriComponentSafe(url.pathname.slice(1));
  const name = decoded === null ? null : parseCoverName(decoded);
  if (name === null) return textResponse(400, "invalid cover name");
  try {
    const bytes = await sources.readCover(name);
    return bytesResponse(bytes, coverMime(name), 200);
  } catch (error) {
    return sourceError(error);
  }
}

function sourceError(error: unknown): Response {
  if (error instanceof NotFoundError) {
    return textResponse(404, "not found");
  }
  return textResponse(500, "internal error");
}
