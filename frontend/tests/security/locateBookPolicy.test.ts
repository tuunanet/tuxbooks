import { describe, expect, it } from "vite-plus/test";

import { IssuedPaths, validateInvokeParams } from "../../../electron/main/ipcPolicy";

function issued(paths: Partial<Record<string, string[]>> = {}): IssuedPaths {
  const issued = new IssuedPaths();
  for (const [kind, list] of Object.entries(paths)) {
    for (const path of list ?? []) issued.issue(kind as never, path);
  }
  return issued;
}

describe("locate_book policy", () => {
  const path = "/home/user/Books/present.epub";

  it("accepts a dialog-issued book file for a positive book id", () => {
    expect(() =>
      validateInvokeParams("locate_book", { bookId: 7, path }, issued({ "book-file": [path] })),
    ).not.toThrow();
  });

  it("rejects an unissued path and an invalid book id", () => {
    expect(() => validateInvokeParams("locate_book", { bookId: 7, path }, issued())).toThrow(
      /not issued/,
    );
    expect(() =>
      validateInvokeParams("locate_book", { bookId: 0, path }, issued({ "book-file": [path] })),
    ).toThrow(/invalid bookId/);
  });
});
