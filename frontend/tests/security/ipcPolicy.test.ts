import { describe, expect, it } from "vitest";

import { IssuedPaths, validateInvokeParams } from "../../../electron/main/ipcPolicy";
import { MAX_IPC_PARAM_BYTES } from "../../../electron/shared/pathSchema";

function issued(paths: Partial<Record<string, string[]>> = {}): IssuedPaths {
  const issued = new IssuedPaths();
  for (const [kind, list] of Object.entries(paths)) {
    for (const path of list ?? []) issued.issue(kind as never, path);
  }
  return issued;
}

describe("IssuedPaths (T-6: only main-issued paths are accepted back)", () => {
  it("records dialog-issued paths per kind", () => {
    const issued = new IssuedPaths();
    expect(issued.has("cover-image", "/tmp/picked.png")).toBe(false);
    issued.issue("cover-image", "/tmp/picked.png");
    expect(issued.has("cover-image", "/tmp/picked.png")).toBe(true);
  });

  it("keeps kinds separate", () => {
    const issued = new IssuedPaths();
    issued.issue("directory", "/tmp/library");
    expect(issued.has("book-file", "/tmp/library")).toBe(false);
    expect(issued.has("directory", "/tmp/library")).toBe(true);
  });
});

describe("validateInvokeParams (T-5, T-6, T-7)", () => {
  it("accepts a known method with plain-object params", () => {
    expect(() => validateInvokeParams("list_books", {}, new IssuedPaths())).not.toThrow();
    expect(() =>
      validateInvokeParams("search_books", { query: "verne" }, new IssuedPaths()),
    ).not.toThrow();
  });

  it("rejects unknown methods and non-object params", () => {
    expect(() => validateInvokeParams("fs_read", {}, new IssuedPaths())).toThrow(/not allowed/);
    expect(() => validateInvokeParams("list_books", null, new IssuedPaths())).toThrow(
      /params must be an object/,
    );
    expect(() => validateInvokeParams("list_books", [1], new IssuedPaths())).toThrow(
      /params must be an object/,
    );
    expect(() => validateInvokeParams("list_books", "x", new IssuedPaths())).toThrow(
      /params must be an object/,
    );
  });

  it("rejects oversized param payloads", () => {
    const params = { blob: "x".repeat(MAX_IPC_PARAM_BYTES + 1) };
    expect(() => validateInvokeParams("search_books", params, new IssuedPaths())).toThrow(
      /too large/,
    );
  });

  describe("scan_library", () => {
    it("accepts a dialog-issued absolute directory", () => {
      expect(() =>
        validateInvokeParams(
          "scan_library",
          { path: "/home/user/Books" },
          issued({ directory: ["/home/user/Books"] }),
        ),
      ).not.toThrow();
    });

    it("rejects paths main never issued and malformed paths", () => {
      expect(() =>
        validateInvokeParams("scan_library", { path: "/home/user/Books" }, issued()),
      ).toThrow(/not issued/);
      expect(() =>
        validateInvokeParams(
          "scan_library",
          { path: "relative/path" },
          issued({ directory: ["relative/path"] }),
        ),
      ).toThrow(/invalid path/);
      expect(() => validateInvokeParams("scan_library", { path: 42 }, issued())).toThrow(
        /invalid path/,
      );
    });
  });

  describe("import_paths", () => {
    it("accepts dialog-issued and external (drag-drop) absolute paths", () => {
      const params = { paths: ["/home/user/Books", "/mnt/data/novel.epub"] };
      expect(() => validateInvokeParams("import_paths", params, issued())).not.toThrow();
    });

    it("rejects non-arrays, oversized batches, and malformed paths", () => {
      expect(() => validateInvokeParams("import_paths", { paths: "x" }, issued())).toThrow(
        /invalid paths/,
      );
      expect(() =>
        validateInvokeParams("import_paths", { paths: ["../relative"] }, issued()),
      ).toThrow(/invalid paths/);
      const tooMany = { paths: Array.from({ length: 1001 }, (_, i) => `/tmp/${i}`) };
      expect(() => validateInvokeParams("import_paths", tooMany, issued())).toThrow(
        /invalid paths/,
      );
    });
  });

  describe("reconnect_book", () => {
    it("accepts a dialog-issued file for a valid book id", () => {
      expect(() =>
        validateInvokeParams(
          "reconnect_book",
          { bookId: 7, path: "/tmp/found.epub" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).not.toThrow();
    });

    it("rejects un-issued paths and invalid book ids", () => {
      expect(() =>
        validateInvokeParams(
          "reconnect_book",
          { bookId: 7, path: "/etc/passwd" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).toThrow(/not issued/);
      expect(() =>
        validateInvokeParams(
          "reconnect_book",
          { bookId: 0, path: "/tmp/found.epub" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).toThrow(/invalid bookId/);
    });
  });

  describe("set_book_cover", () => {
    it("accepts a dialog-issued image for a valid book id", () => {
      expect(() =>
        validateInvokeParams(
          "set_book_cover",
          { bookId: 3, imagePath: "/tmp/picked.png" },
          issued({ "cover-image": ["/tmp/picked.png"] }),
        ),
      ).not.toThrow();
    });

    it("rejects un-issued image paths", () => {
      expect(() =>
        validateInvokeParams(
          "set_book_cover",
          { bookId: 3, imagePath: "/home/user/.ssh/id_rsa" },
          issued(),
        ),
      ).toThrow(/not issued/);
    });
  });

  describe("book ids on other methods", () => {
    it("rejects invalid book ids on bookId-bearing methods", () => {
      for (const method of [
        "remove_book",
        "get_book_metadata",
        "get_book_bytes",
        "get_book_resource",
        "clear_book_cover_override",
      ]) {
        expect(() => validateInvokeParams(method, { bookId: -1 }, issued())).toThrow(
          /invalid bookId/,
        );
      }
    });

    it("rejects oversized member paths on get_book_resource", () => {
      expect(() =>
        validateInvokeParams(
          "get_book_resource",
          { bookId: 1, path: `a/${".".repeat(2048)}` },
          issued(),
        ),
      ).toThrow(/invalid resource path/);
      expect(() =>
        validateInvokeParams(
          "get_book_resource",
          { bookId: 1, path: "../../etc/passwd" },
          issued(),
        ),
      ).toThrow(/invalid resource path/);
    });

    it("validates offset/length are non-negative safe integers", () => {
      expect(() =>
        validateInvokeParams("get_book_bytes", { bookId: 1, offset: -5 }, issued()),
      ).toThrow(/invalid byte range/);
      expect(() =>
        validateInvokeParams("get_book_bytes", { bookId: 1, length: 1.5 }, issued()),
      ).toThrow(/invalid byte range/);
      expect(() =>
        validateInvokeParams("get_book_bytes", { bookId: 1, offset: 0, length: 10 }, issued()),
      ).not.toThrow();
    });
  });
});
