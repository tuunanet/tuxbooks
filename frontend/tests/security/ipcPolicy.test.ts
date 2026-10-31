import { describe, expect, it } from "vite-plus/test";

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
    expect(() => validateInvokeParams("list_reading_history", {}, new IssuedPaths())).not.toThrow();
    expect(() =>
      validateInvokeParams("list_reading_history", { query: "verne" }, new IssuedPaths()),
    ).not.toThrow();
    expect(() =>
      validateInvokeParams("list_reading_history", { query: 7 }, new IssuedPaths()),
    ).toThrow(/invalid query/);
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

  describe("sync_connect", () => {
    it("accepts a dialog-issued sync folder", () => {
      expect(() =>
        validateInvokeParams(
          "sync_connect",
          {
            path: "/home/user/Dropbox",
            deviceName: "Laptop",
            confirmLibraryId: "0123456789abcdef0123456789abcdef",
          },
          issued({ "sync-folder": ["/home/user/Dropbox"] }),
        ),
      ).not.toThrow();
      expect(() =>
        validateInvokeParams(
          "sync_connect",
          { path: "/home/user/Dropbox", startNew: true },
          issued({ "sync-folder": ["/home/user/Dropbox"] }),
        ),
      ).not.toThrow();
    });

    it("rejects an unissued folder, malformed ids, and oversized names", () => {
      expect(() =>
        validateInvokeParams(
          "sync_connect",
          { path: "/home/user/Dropbox" },
          issued({ directory: ["/home/user/Dropbox"] }),
        ),
      ).toThrow(/not issued/);
      expect(() =>
        validateInvokeParams(
          "sync_connect",
          { path: "/home/user/Dropbox", confirmLibraryId: "../evil" },
          issued({ "sync-folder": ["/home/user/Dropbox"] }),
        ),
      ).toThrow(/confirmLibraryId/);
      expect(() =>
        validateInvokeParams(
          "sync_connect",
          { path: "/home/user/Dropbox", deviceName: "x".repeat(81) },
          issued({ "sync-folder": ["/home/user/Dropbox"] }),
        ),
      ).toThrow(/deviceName/);
      expect(() =>
        validateInvokeParams(
          "sync_connect",
          { path: "/home/user/Dropbox", startNew: "yes" },
          issued({ "sync-folder": ["/home/user/Dropbox"] }),
        ),
      ).toThrow(/startNew/);
      expect(() =>
        validateInvokeParams(
          "sync_connect",
          {
            path: "/home/user/Dropbox",
            startNew: true,
            confirmLibraryId: "0123456789abcdef0123456789abcdef",
          },
          issued({ "sync-folder": ["/home/user/Dropbox"] }),
        ),
      ).toThrow(/join or start new/);
    });

    it("validates the sync id and device name methods", () => {
      expect(() => validateInvokeParams("sync_restore", { id: 1 }, issued())).not.toThrow();
      expect(() => validateInvokeParams("sync_retry_issue", { id: 2 }, issued())).not.toThrow();
      expect(() => validateInvokeParams("sync_retry_issue", { id: 0 }, issued())).toThrow(
        /invalid sync id/,
      );
      expect(() => validateInvokeParams("sync_restore", { id: 0 }, issued())).toThrow(
        /invalid sync id/,
      );
      expect(() =>
        validateInvokeParams("sync_set_device_name", { name: "Laptop" }, issued()),
      ).not.toThrow();
      expect(() => validateInvokeParams("sync_set_device_name", { name: "  " }, issued())).toThrow(
        /invalid device name/,
      );
    });

    it("validates the conflict id and resolution choice", () => {
      for (const resolution of ["keep_winner", "apply_loser"]) {
        expect(() =>
          validateInvokeParams("sync_resolve_conflict", { id: 3, resolution }, issued()),
        ).not.toThrow();
      }
      expect(() =>
        validateInvokeParams(
          "sync_resolve_conflict",
          { id: 0, resolution: "keep_winner" },
          issued(),
        ),
      ).toThrow(/sync conflict id/);
      expect(() =>
        validateInvokeParams(
          "sync_resolve_conflict",
          { id: 3, resolution: "apply_winner" },
          issued(),
        ),
      ).toThrow(/conflict resolution/);
      expect(() => validateInvokeParams("sync_resolve_conflict", { id: 3 }, issued())).toThrow(
        /conflict resolution/,
      );
    });

    it("accepts the no-parameter diagnostics command", () => {
      expect(() => validateInvokeParams("sync_diagnostics", {}, issued())).not.toThrow();
    });

    it("validates Reset, Forget, and restore parameters", () => {
      expect(() => validateInvokeParams("retry_indexing", { bookId: 1 }, issued())).not.toThrow();
      expect(() => validateInvokeParams("retry_indexing", { bookId: 0 }, issued())).toThrow(
        /invalid bookId/,
      );
      expect(() =>
        validateInvokeParams("reset_book_reading_data", { bookId: 1 }, issued()),
      ).not.toThrow();
      expect(() => validateInvokeParams("forget_book", { bookId: 1 }, issued())).not.toThrow();
      expect(() => validateInvokeParams("forget_book", { bookId: 0 }, issued())).toThrow(
        /invalid bookId/,
      );
      expect(() =>
        validateInvokeParams("forget_books", { bookIds: [1, 2] }, issued()),
      ).not.toThrow();
      expect(() => validateInvokeParams("forget_books", { bookIds: "1" }, issued())).toThrow(
        /invalid bookIds/,
      );
      expect(() => validateInvokeParams("forget_books", { bookIds: [1, 0] }, issued())).toThrow(
        /invalid bookIds/,
      );
      expect(() => validateInvokeParams("list_book_trash", {}, issued())).not.toThrow();
      expect(() => validateInvokeParams("restore_book", { trashId: 1 }, issued())).not.toThrow();
      expect(() =>
        validateInvokeParams("restore_book", { trashId: 1, mode: "merge" }, issued()),
      ).not.toThrow();
      expect(() =>
        validateInvokeParams("restore_book", { trashId: 1, mode: "sideways" }, issued()),
      ).toThrow(/invalid restore mode/);
      expect(() => validateInvokeParams("restore_book", { trashId: 0 }, issued())).toThrow(
        /invalid trashId/,
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

  describe("unwatch_locations", () => {
    it("accepts watch-list paths, with no keep/remove choice on the wire", () => {
      const paths = ["/home/u/Books"];
      expect(() => validateInvokeParams("unwatch_locations", { paths }, issued())).not.toThrow();
    });

    it("rejects malformed paths", () => {
      expect(() => validateInvokeParams("unwatch_locations", { paths: "x" }, issued())).toThrow(
        /invalid paths/,
      );
      expect(() =>
        validateInvokeParams("unwatch_locations", { paths: ["../relative"] }, issued()),
      ).toThrow(/invalid paths/);
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

  describe("relink_book", () => {
    it("accepts a dialog-issued file for a valid book id", () => {
      expect(() =>
        validateInvokeParams(
          "relink_book",
          { bookId: 7, path: "/tmp/found.epub" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).not.toThrow();
    });

    it("rejects un-issued paths and invalid book ids", () => {
      expect(() =>
        validateInvokeParams(
          "relink_book",
          { bookId: 7, path: "/etc/passwd" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).toThrow(/not issued/);
      expect(() =>
        validateInvokeParams(
          "relink_book",
          { bookId: 0, path: "/tmp/found.epub" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).toThrow(/invalid bookId/);
    });
  });

  describe("attach_waiting_book", () => {
    it("accepts a dialog-issued file for a waiting book uid", () => {
      expect(() =>
        validateInvokeParams(
          "attach_waiting_book",
          { bookUid: "a".repeat(32), path: "/tmp/found.epub" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).not.toThrow();
    });

    it("rejects an un-issued path and a malformed uid", () => {
      expect(() =>
        validateInvokeParams(
          "attach_waiting_book",
          { bookUid: "a".repeat(32), path: "/etc/passwd" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).toThrow(/not issued/);
      expect(() =>
        validateInvokeParams(
          "attach_waiting_book",
          { bookUid: "not-a-uid", path: "/tmp/found.epub" },
          issued({ "book-file": ["/tmp/found.epub"] }),
        ),
      ).toThrow(/invalid bookUid/);
    });
  });

  describe("set_book_cover", () => {
    it("requires a book id even with an issued image", () => {
      expect(() =>
        validateInvokeParams(
          "set_book_cover",
          { imagePath: "/tmp/picked.png" },
          issued({ "cover-image": ["/tmp/picked.png"] }),
        ),
      ).toThrow(/invalid bookId/);
    });

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
        "list_book_files",
        "remove_book_file",
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

    it("requires a positive file id when removing one copy", () => {
      expect(() =>
        validateInvokeParams("remove_book_file", { bookId: 1, fileId: 0 }, issued()),
      ).toThrow(/invalid fileId/);
      expect(() =>
        validateInvokeParams("remove_book_file", { bookId: 1, fileId: "2" }, issued()),
      ).toThrow(/invalid fileId/);
      expect(() =>
        validateInvokeParams("remove_book_file", { bookId: 1, fileId: 2 }, issued()),
      ).not.toThrow();
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

  describe("durable-state and provider methods", () => {
    const bookUid = "a".repeat(32);

    it("validates waiting-book actions by durable book uid", () => {
      expect(() => validateInvokeParams("list_waiting_books", {}, issued())).not.toThrow();
      expect(() =>
        validateInvokeParams("forget_waiting_book", { bookUid }, issued()),
      ).not.toThrow();
      expect(() =>
        validateInvokeParams("forget_waiting_book", { bookUid: "nope" }, issued()),
      ).toThrow(/invalid bookUid/);
    });

    it("validates provider link parameters by durable book uid", () => {
      expect(() =>
        validateInvokeParams("list_provider_links", { bookUid }, issued()),
      ).not.toThrow();
      expect(() =>
        validateInvokeParams("list_provider_links", { bookUid: "nope" }, issued()),
      ).toThrow(/invalid bookUid/);
      expect(() =>
        validateInvokeParams(
          "link_provider_book",
          { bookUid, provider: "hardcover", remoteId: "remote-1" },
          issued(),
        ),
      ).not.toThrow();
      expect(() =>
        validateInvokeParams(
          "link_provider_book",
          { bookUid, provider: "", remoteId: "remote-1" },
          issued(),
        ),
      ).toThrow(/invalid provider/);
      expect(() =>
        validateInvokeParams(
          "link_provider_book",
          { bookUid, provider: "hardcover", remoteId: "" },
          issued(),
        ),
      ).toThrow(/invalid remoteId/);
      expect(() =>
        validateInvokeParams("unlink_provider_book", { bookUid, provider: "hardcover" }, issued()),
      ).not.toThrow();
      expect(() =>
        validateInvokeParams(
          "apply_provider_reading_update",
          { bookUid, provider: "hardcover", status: "reading", progressPercent: 42.5 },
          issued(),
        ),
      ).not.toThrow();
      expect(() =>
        validateInvokeParams(
          "apply_provider_reading_update",
          { bookUid, provider: "hardcover", status: "sideways" },
          issued(),
        ),
      ).toThrow(/invalid provider status/);
      expect(() =>
        validateInvokeParams(
          "apply_provider_reading_update",
          { bookUid, provider: "hardcover", progressPercent: 101 },
          issued(),
        ),
      ).toThrow(/invalid progressPercent/);
    });
  });
});
