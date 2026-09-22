import { describe, expect, it } from "vitest";

import {
  IPC_CHANNELS,
  MAX_IPC_PARAM_BYTES,
  MAX_MEMBER_PATH_LENGTH,
  MAX_RESPONSE_LINE_BYTES,
  MAX_SIDECAR_REQUEST_BYTES,
  PRIVILEGED_SCHEMES,
  SIDECAR_METHODS,
  bookSourceMime,
  coverMime,
  decodeUriComponentSafe,
  isAllowedSenderUrl,
  isStorageRootId,
  isValidBookId,
  isValidBookFormat,
  isValidLibraryPath,
  memberMime,
  parseBookId,
  parseCoverName,
  parseMemberPath,
  parseRangeHeader,
} from "../../../electron/shared/pathSchema";
import {
  BAD_BOOK_IDS,
  BAD_RANGES,
  INVALID_LIBRARY_PATHS,
  VALID_LIBRARY_PATHS,
} from "./attackVectors";

describe("parseBookId (T-2: invalid ids fail closed)", () => {
  it("accepts plain positive decimal ids", () => {
    expect(parseBookId("1")).toBe(1);
    expect(parseBookId("123")).toBe(123);
    expect(parseBookId("01")).toBe(1);
  });

  it("rejects every hostile id shape", () => {
    for (const bad of BAD_BOOK_IDS) {
      expect(parseBookId(bad), `expected rejection of ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("accepts the largest safe integer id and nothing beyond", () => {
    expect(parseBookId("9007199254740991")).toBe(9007199254740991);
    expect(parseBookId("9007199254740992")).toBeNull();
  });
});

describe("isValidBookId (T-2)", () => {
  it("accepts positive safe integers only", () => {
    expect(isValidBookId(1)).toBe(true);
    expect(isValidBookId(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isValidBookId(0)).toBe(false);
    expect(isValidBookId(-1)).toBe(false);
    expect(isValidBookId(1.5)).toBe(false);
    expect(isValidBookId(Number.NaN)).toBe(false);
    expect(isValidBookId(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidBookId("1")).toBe(false);
    expect(isValidBookId(null)).toBe(false);
  });
});

describe("parseMemberPath (T-2: member paths normalize and fail closed)", () => {
  it("accepts ordinary in-root member paths", () => {
    expect(parseMemberPath("OEBPS/chapter1.xhtml")).toBe("OEBPS/chapter1.xhtml");
    expect(parseMemberPath("images/pic.png")).toBe("images/pic.png");
    expect(parseMemberPath("style.css")).toBe("style.css");
  });

  it("rejects traversal, absolute, backslash, NUL, and control-character shapes", () => {
    for (const attack of [
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
    ]) {
      expect(parseMemberPath(attack), `expected rejection of ${JSON.stringify(attack)}`).toBeNull();
    }
  });

  it("rejects the empty path and over-long paths", () => {
    expect(parseMemberPath("")).toBeNull();
    expect(parseMemberPath("a".repeat(MAX_MEMBER_PATH_LENGTH + 1))).toBeNull();
    expect(parseMemberPath("a".repeat(MAX_MEMBER_PATH_LENGTH))).not.toBeNull();
  });
});

describe("parseCoverName (T-1/T-3: covers are names, never paths)", () => {
  it("accepts flat image file names", () => {
    expect(parseCoverName("9f2c1a.png")).toBe("9f2c1a.png");
    expect(parseCoverName("cover_1.JPG")).toBe("cover_1.JPG");
    expect(parseCoverName("abc.jpeg")).toBe("abc.jpeg");
    expect(parseCoverName("x.gif")).toBe("x.gif");
    expect(parseCoverName("y.webp")).toBe("y.webp");
  });

  it("rejects every path-shaped input, including absolute filesystem paths", () => {
    for (const attack of [
      "/etc/passwd",
      "../../etc/passwd",
      "sub/dir/cover.png",
      "a\\b.png",
      "..",
      ".",
      ".hidden.png",
      "",
      "no-extension",
      "a.png.txt",
      "a%2fb.png",
      "a\0.png",
      "/home/user/.ssh/id_rsa",
    ]) {
      expect(parseCoverName(attack), `expected rejection of ${JSON.stringify(attack)}`).toBeNull();
    }
  });
});

describe("isValidLibraryPath (T-7: path-bearing IPC params are shape-checked)", () => {
  it("accepts ordinary absolute paths", () => {
    for (const path of VALID_LIBRARY_PATHS) {
      expect(isValidLibraryPath(path), `expected acceptance of ${path}`).toBe(true);
    }
    expect(isValidLibraryPath("/home/user/Books/")).toBe(true);
  });

  it("rejects relative, non-normalized, control-bearing, and oversized paths", () => {
    for (const path of INVALID_LIBRARY_PATHS) {
      expect(isValidLibraryPath(path), `expected rejection of ${JSON.stringify(path)}`).toBe(false);
    }
  });
});

describe("parseRangeHeader (T-2: invalid ranges fail closed)", () => {
  it("treats an absent header as no range", () => {
    expect(parseRangeHeader(null)).toEqual({ kind: "none" });
    expect(parseRangeHeader("")).toEqual({ kind: "none" });
  });

  it("parses open-ended and open-start byte ranges", () => {
    expect(parseRangeHeader("bytes=0-99")).toEqual({ kind: "ok", start: 0, end: 99 });
    expect(parseRangeHeader("bytes=5-")).toEqual({ kind: "ok", start: 5 });
    expect(parseRangeHeader("bytes=-500")).toEqual({ kind: "ok", end: 500 });
    expect(parseRangeHeader(" bytes=0-10 ")).toEqual({ kind: "ok", start: 0, end: 10 });
  });

  it("marks every malformed or unsafe range invalid", () => {
    for (const bad of BAD_RANGES) {
      expect(parseRangeHeader(bad), `expected invalid for ${JSON.stringify(bad)}`).toEqual({
        kind: "invalid",
      });
    }
    expect(parseRangeHeader("bytes=9007199254740991-")).toEqual({
      kind: "ok",
      start: 9007199254740991,
    });
  });
});

describe("decodeUriComponentSafe (T-2: decode failures fail closed)", () => {
  it("decodes well-formed input", () => {
    expect(decodeUriComponentSafe("%2e")).toBe(".");
    expect(decodeUriComponentSafe("OEBPS%2Fch.xhtml")).toBe("OEBPS/ch.xhtml");
    expect(decodeUriComponentSafe("plain")).toBe("plain");
  });

  it("returns null for malformed sequences instead of throwing", () => {
    expect(decodeUriComponentSafe("%")).toBeNull();
    expect(decodeUriComponentSafe("%zz")).toBeNull();
    expect(decodeUriComponentSafe("a%2")).toBeNull();
  });
});

describe("fixed MIME tables (T-4: never document-provided)", () => {
  it("maps the book format query through a fixed table", () => {
    expect(bookSourceMime("epub")).toBe("application/epub+zip");
    expect(bookSourceMime("pdf")).toBe("application/pdf");
    expect(bookSourceMime(null)).toBe("application/octet-stream");
    expect(bookSourceMime("epubz")).toBe("application/octet-stream");
    expect(bookSourceMime("EPUB")).toBe("application/octet-stream");
    expect(bookSourceMime("../../etc/passwd")).toBe("application/octet-stream");
  });

  it("maps member extensions through a fixed table mirroring the sidecar", () => {
    expect(memberMime("OEBPS/ch.xhtml")).toBe("application/xhtml+xml");
    expect(memberMime("a.html")).toBe("text/html");
    expect(memberMime("a.htm")).toBe("text/html");
    expect(memberMime("s.css")).toBe("text/css");
    expect(memberMime("x.js")).toBe("text/javascript");
    expect(memberMime("i.png")).toBe("image/png");
    expect(memberMime("i.jpg")).toBe("image/jpeg");
    expect(memberMime("i.jpeg")).toBe("image/jpeg");
    expect(memberMime("i.gif")).toBe("image/gif");
    expect(memberMime("i.svg")).toBe("image/svg+xml");
    expect(memberMime("i.webp")).toBe("image/webp");
    expect(memberMime("t.ncx")).toBe("application/x-dtbncx+xml");
    expect(memberMime("t.opf")).toBe("application/oebps-package+xml");
    expect(memberMime("a.mp3")).toBe("audio/mpeg");
    expect(memberMime("v.mp4")).toBe("video/mp4");
    expect(memberMime("v.m4v")).toBe("video/mp4");
    expect(memberMime("a.ogg")).toBe("audio/ogg");
    expect(memberMime("a.oga")).toBe("audio/ogg");
    expect(memberMime("v.ogv")).toBe("video/ogg");
    expect(memberMime("v.webm")).toBe("video/webm");
    expect(memberMime("f.woff")).toBe("font/woff");
    expect(memberMime("f.woff2")).toBe("font/woff2");
    expect(memberMime("f.ttf")).toBe("font/ttf");
    expect(memberMime("f.otf")).toBe("font/otf");
    expect(memberMime("d.xml")).toBe("application/xml");
    expect(memberMime("r.txt")).toBe("text/plain");
    expect(memberMime("x.bin")).toBe("application/octet-stream");
    expect(memberMime("noext")).toBe("application/octet-stream");
    expect(memberMime("A.PNG")).toBe("image/png");
  });

  it("maps cover extensions through a fixed table", () => {
    expect(coverMime("a.png")).toBe("image/png");
    expect(coverMime("a.jpg")).toBe("image/jpeg");
    expect(coverMime("a.jpeg")).toBe("image/jpeg");
    expect(coverMime("a.gif")).toBe("image/gif");
    expect(coverMime("a.webp")).toBe("image/webp");
    expect(coverMime("a.svg")).toBe("application/octet-stream");
    expect(coverMime("a.html")).toBe("application/octet-stream");
  });
});

describe("isValidBookFormat (T-2: query schema)", () => {
  it("accepts only the epub and pdf format names", () => {
    expect(isValidBookFormat("epub")).toBe(true);
    expect(isValidBookFormat("pdf")).toBe(true);
    expect(isValidBookFormat("exe")).toBe(false);
    expect(isValidBookFormat("epub%20pdf")).toBe(false);
    expect(isValidBookFormat("")).toBe(false);
    expect(isValidBookFormat(42)).toBe(false);
    expect(isValidBookFormat(null)).toBe(false);
  });
});

describe("isStorageRootId (storage rows are named by stable id, never a path)", () => {
  it("accepts only the two app-owned root ids", () => {
    expect(isStorageRootId("app-data")).toBe(true);
    expect(isStorageRootId("app-config")).toBe(true);
  });

  it("rejects every path, unknown id, and non-string", () => {
    for (const bad of [
      "/home/user/.local/share/com.tuxbooks.app",
      "app-data/../etc",
      "app",
      "",
      "storage",
      null,
      undefined,
      1,
      {},
    ]) {
      expect(isStorageRootId(bad), `expected rejection of ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("payload bound constants (T-6)", () => {
  it("stays positive and above the largest legitimate payloads", () => {
    // A 32-bit signed shift (2 << 30) overflows to a negative cap, which
    // makes the line buffer drop every response; pin the real values.
    expect(MAX_RESPONSE_LINE_BYTES).toBe(2_147_483_648);
    expect(MAX_SIDECAR_REQUEST_BYTES).toBe(8_388_608);
    expect(MAX_IPC_PARAM_BYTES).toBe(8_388_608);
    expect(MAX_RESPONSE_LINE_BYTES).toBeGreaterThan(1_073_741_824); // 1 GiB book
  });
});

describe("boundary configuration tables (T-5)", () => {
  it("enumerates the sidecar method allowlist with the reader-relevant methods", () => {
    for (const method of [
      "ping",
      "list_books",
      "scan_library",
      "import_paths",
      "reconnect_book",
      "set_book_cover",
      "get_book_bytes",
      "get_book_resource",
      "get_epub_session",
      "embed_book_metadata",
      "get_startup_recovery",
    ]) {
      expect(SIDECAR_METHODS.has(method), `missing method ${method}`).toBe(true);
    }
    expect(SIDECAR_METHODS.has("fs_read")).toBe(false);
    expect(SIDECAR_METHODS.has("__proto__")).toBe(false);
  });

  it("enumerates exactly the renderer-facing IPC channels", () => {
    expect(IPC_CHANNELS).toEqual({
      invoke: "tuxbooks:invoke",
      dialog: "tuxbooks:dialog",
      reveal: "tuxbooks:reveal",
      storageReport: "tuxbooks:storage-report",
      openDataFolder: "tuxbooks:open-data-folder",
      event: "tuxbooks:event",
    });
  });

  it("declares exactly the tuxbooks and app privileged schemes", () => {
    expect(PRIVILEGED_SCHEMES.map((entry) => entry.scheme)).toEqual(["tuxbooks", "app"]);
    for (const entry of PRIVILEGED_SCHEMES) {
      expect(entry.privileges.standard).toBe(true);
      expect(entry.privileges.secure).toBe(true);
      expect(entry.privileges.supportFetchAPI).toBe(true);
      expect(entry.privileges.corsEnabled).toBe(true);
      expect(entry.privileges.stream).toBe(true);
    }
  });
});

describe("isAllowedSenderUrl (T-6: IPC senders validated)", () => {
  const devServer = "http://localhost:1420";

  it("accepts the built app origin", () => {
    expect(isAllowedSenderUrl("app://bundle/index.html", undefined)).toBe(true);
    expect(isAllowedSenderUrl("app://bundle/assets/index.js", undefined)).toBe(true);
    expect(isAllowedSenderUrl("app://bundle/index.html?x=1", undefined)).toBe(true);
  });

  it("accepts the dev server origin when one is configured", () => {
    expect(isAllowedSenderUrl("http://localhost:1420/", devServer)).toBe(true);
    expect(isAllowedSenderUrl("http://localhost:1420/src/main.tsx", devServer)).toBe(true);
  });

  it("rejects every other origin, scheme, and garbage input", () => {
    expect(isAllowedSenderUrl("http://localhost:1420/", undefined)).toBe(false);
    expect(isAllowedSenderUrl("http://evil.example/", devServer)).toBe(false);
    expect(isAllowedSenderUrl("app://evil/index.html", undefined)).toBe(false);
    expect(isAllowedSenderUrl("file:///etc/passwd", undefined)).toBe(false);
    expect(isAllowedSenderUrl("tuxbooks://book/1", undefined)).toBe(false);
    expect(isAllowedSenderUrl("chrome-extension://abc/popup.html", devServer)).toBe(false);
    expect(isAllowedSenderUrl("", devServer)).toBe(false);
    expect(isAllowedSenderUrl("not a url", devServer)).toBe(false);
  });
});
