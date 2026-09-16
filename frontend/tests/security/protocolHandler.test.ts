import { describe, expect, it, vi } from "vitest";

import {
  NotFoundError,
  handleProtocolRequest,
  type BookSources,
} from "../../../electron/main/protocolHandler";
import {
  ABSOLUTE_COVER_PATHS,
  BAD_BOOK_IDS,
  BAD_RANGES,
  DOUBLE_ENCODED_TRAVERSAL_MEMBERS,
  ENCODED_TRAVERSAL_MEMBERS,
  SCHEME_CONFUSION_URLS,
  bookBytesUrl,
  bookResourceUrl,
  coverUrl,
} from "./attackVectors";

const TEN_BYTES = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/** Slice the canned payload the way the sidecar would for the given range. */
function sliceB64(offset?: number, length?: number): string {
  const start = offset ?? 0;
  const end = length === undefined ? TEN_BYTES.length : Math.min(start + length, TEN_BYTES.length);
  return Buffer.from(TEN_BYTES.subarray(start, end)).toString("base64");
}

function makeSources(overrides: Partial<BookSources> = {}): BookSources {
  return {
    getBookBytes: vi
      .fn()
      .mockImplementation((_bookId: number, offset?: number, length?: number) =>
        Promise.resolve({ data: sliceB64(offset, length), offset: offset ?? 0, total: 10 }),
      ),
    getBookResource: vi
      .fn()
      .mockImplementation((_bookId: number, _member: string, offset?: number, length?: number) =>
        Promise.resolve({
          data: sliceB64(offset, length),
          offset: offset ?? 0,
          total: 10,
          mediaType: "text/html",
        }),
      ),
    readCover: vi.fn().mockResolvedValue(Uint8Array.from([137, 80, 78, 71])),
    ...overrides,
  };
}

async function bodyBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function protocolRequest(
  url: string,
  options: { method?: string; range?: string | null } = {},
): { url: string; method: string; headers: { get(name: string): string | null } } {
  return {
    url,
    method: options.method ?? "GET",
    headers: { get: (name) => (name.toLowerCase() === "range" ? (options.range ?? null) : null) },
  };
}

async function status(url: string, sources: BookSources, range?: string): Promise<Response> {
  return handleProtocolRequest(protocolRequest(url, { range }), sources);
}

describe("scheme and host allowlist (T-2)", () => {
  it("answers 404 for every non-tuxbooks or non-book/cover URL", async () => {
    for (const url of SCHEME_CONFUSION_URLS) {
      const response = await status(url, makeSources());
      expect(response.status, `expected 404 for ${url}`).toBe(404);
    }
  });

  it("serves only GET requests", async () => {
    const response = await handleProtocolRequest(
      protocolRequest(bookBytesUrl("1"), { method: "POST" }),
      makeSources(),
    );
    expect(response.status).toBe(405);
  });
});

describe("book bytes route (T-1, T-2, T-4)", () => {
  it("serves a stored book's bytes with the fixed format MIME", async () => {
    const sources = makeSources();
    const response = await status(bookBytesUrl("5", "epub"), sources);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/epub+zip");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await bodyBytes(response)).toEqual(TEN_BYTES);
    expect(sources.getBookBytes).toHaveBeenCalledWith(5);
  });

  it("falls back to the fixed octet-stream type for unknown formats", async () => {
    const response = await status(bookBytesUrl("5", "exe"), makeSources());
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const responseNoQuery = await status(bookBytesUrl("5"), makeSources());
    expect(responseNoQuery.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("answers 400 for invalid book ids without touching the byte source", async () => {
    for (const bad of BAD_BOOK_IDS) {
      const sources = makeSources();
      const response = await status(bookBytesUrl(bad), sources);
      expect(response.status, `expected 400 for id ${JSON.stringify(bad)}`).toBe(400);
      expect(sources.getBookBytes).not.toHaveBeenCalled();
    }
  });

  it("answers byte ranges with 206 and a content-range", async () => {
    const sources = makeSources();
    const response = await status(bookBytesUrl("5"), sources, "bytes=2-4");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(response.headers.get("content-length")).toBe("3");
    expect(await bodyBytes(response)).toEqual(Uint8Array.from([2, 3, 4]));
    expect(sources.getBookBytes).toHaveBeenCalledWith(5, 2, 3);
  });

  it("serves an open-ended range to the end of the file", async () => {
    const response = await status(bookBytesUrl("5"), makeSources(), "bytes=8-");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(await bodyBytes(response)).toEqual(Uint8Array.from([8, 9]));
  });

  it("treats a suffix range as a whole-file request (200)", async () => {
    const response = await status(bookBytesUrl("5"), makeSources(), "bytes=-3");
    expect(response.status).toBe(200);
  });

  it("answers 416 for malformed, inverted, and unsafe ranges without a source call", async () => {
    for (const bad of BAD_RANGES) {
      const sources = makeSources();
      const response = await status(bookBytesUrl("5"), sources, bad);
      expect(response.status, `expected 416 for range ${JSON.stringify(bad)}`).toBe(416);
      expect(sources.getBookBytes).not.toHaveBeenCalled();
    }
  });

  it("answers 416 when the range starts past the end, with the total", async () => {
    const response = await status(bookBytesUrl("5"), makeSources(), "bytes=10-");
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  it("answers 404 with a fixed body when the book is unknown", async () => {
    const sources = makeSources({
      getBookBytes: vi.fn().mockRejectedValue(new NotFoundError("no book")),
    });
    const response = await status(bookBytesUrl("5"), sources);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers 500 with a fixed body that discloses no paths (T-4)", async () => {
    const sources = makeSources({
      getBookBytes: vi
        .fn()
        .mockRejectedValue(new Error("read failed at /home/user/.local/share/tuxbooks.db")),
    });
    const response = await status(bookBytesUrl("5"), sources);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe("internal error");
    expect(body).not.toContain("/home");
  });
});

describe("book resource route (T-2, T-4)", () => {
  it("serves a member with the MIME from the fixed table, ignoring the wire media type", async () => {
    const sources = makeSources();
    const response = await status(bookResourceUrl("7", "OEBPS/ch.xhtml"), sources);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xhtml+xml");
    expect(sources.getBookResource).toHaveBeenCalledWith(7, "OEBPS/ch.xhtml", undefined, undefined);
  });

  it("rejects encoded traversal member paths with 400", async () => {
    for (const member of [...ENCODED_TRAVERSAL_MEMBERS, "../secret", "..\\secret", "/etc/passwd"]) {
      const sources = makeSources();
      const response = await status(bookResourceUrl("7", member), sources);
      expect(
        response.status,
        `expected 400 for member ${JSON.stringify(member)}`,
      ).toBeGreaterThanOrEqual(400);
      expect(sources.getBookResource).not.toHaveBeenCalled();
    }
  });

  it("treats double-encoded traversal as a literal member that misses (404)", async () => {
    for (const member of DOUBLE_ENCODED_TRAVERSAL_MEMBERS) {
      const sources = makeSources({
        getBookResource: vi.fn().mockRejectedValue(new NotFoundError("missing member")),
      });
      const response = await status(bookResourceUrl("7", member), sources);
      expect(response.status, `expected 404 for ${member}`).toBe(404);
      const calls = (sources.getBookResource as ReturnType<typeof vi.fn>).mock.calls as Array<
        [number, string]
      >;
      expect(calls[0]?.[1]).toBeDefined();
      expect(calls[0]?.[1]).not.toContain("..");
    }
  });

  it("rejects NUL and malformed encodings with 400", async () => {
    for (const member of ["%00", "a%00b", "%", "a%zz"]) {
      const sources = makeSources();
      const response = await status(bookResourceUrl("7", member), sources);
      expect(response.status, `expected 400 for member ${JSON.stringify(member)}`).toBe(400);
      expect(sources.getBookResource).not.toHaveBeenCalled();
    }
  });

  it("rejects an empty member path with 400", async () => {
    const sources = makeSources();
    const response = await status("tuxbooks://book/7/", sources);
    expect(response.status).toBe(400);
    expect(sources.getBookResource).not.toHaveBeenCalled();
  });

  it("slices decoded members for byte ranges", async () => {
    const response = await status(bookResourceUrl("7", "o.png"), makeSources(), "bytes=1-3");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-3/10");
    expect(await bodyBytes(response)).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("answers 416 for invalid member ranges without a source call", async () => {
    for (const bad of BAD_RANGES) {
      const sources = makeSources();
      const response = await status(bookResourceUrl("7", "o.png"), sources, bad);
      expect(response.status, `expected 416 for range ${JSON.stringify(bad)}`).toBe(416);
      expect(sources.getBookResource).not.toHaveBeenCalled();
    }
  });

  it("answers 404 with a fixed body when the member is unknown", async () => {
    const sources = makeSources({
      getBookResource: vi.fn().mockRejectedValue(new NotFoundError("OEBPS/../../secret")),
    });
    const response = await status(bookResourceUrl("7", "OEBPS/missing.xhtml"), sources);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers 500 with a fixed body on unexpected source failures", async () => {
    const sources = makeSources({
      getBookResource: vi.fn().mockRejectedValue(new Error("boom /home/user/secret")),
    });
    const response = await status(bookResourceUrl("7", "o.png"), sources);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe("internal error");
    expect(body).not.toContain("/home");
  });
});

describe("cover route (T-1, T-3: covers are names, never paths)", () => {
  it("serves a cover by flat file name through the fixed MIME table", async () => {
    const sources = makeSources();
    const response = await status(coverUrl("9f2c1a.png"), sources);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(sources.readCover).toHaveBeenCalledWith("9f2c1a.png");
    expect(await bodyBytes(response)).toEqual(Uint8Array.from([137, 80, 78, 71]));
  });

  it("answers 400 for every path-shaped cover URL without reading anything", async () => {
    for (const path of ABSOLUTE_COVER_PATHS) {
      const sources = makeSources();
      const response = await status(coverUrl(path), sources);
      expect(response.status, `expected 400 for cover ${JSON.stringify(path)}`).toBe(400);
      expect(sources.readCover).not.toHaveBeenCalled();
    }
  });

  it("answers 400 for single-encoded traversal cover names", async () => {
    for (const name of ["%2e%2e%2fsecret.png", "a%2fb.png", "x%00.png", "%", "a%zz.png"]) {
      const sources = makeSources();
      const response = await status(coverUrl(name), sources);
      expect(response.status, `expected 400 for cover ${JSON.stringify(name)}`).toBe(400);
      expect(sources.readCover).not.toHaveBeenCalled();
    }
  });

  it("answers 404 with a fixed body when the cover is missing", async () => {
    const sources = makeSources({ readCover: vi.fn().mockRejectedValue(new NotFoundError("")) });
    const response = await status(coverUrl("missing.png"), sources);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers 500 with a fixed body on unexpected cover read failures", async () => {
    const sources = makeSources({
      readCover: vi.fn().mockRejectedValue(new Error("escape attempt /etc/shadow")),
    });
    const response = await status(coverUrl("ok.png"), sources);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe("internal error");
    expect(body).not.toContain("/etc");
  });
});
