import { describe, expect, it } from "vite-plus/test";

import { IssuedPaths, validateInvokeParams } from "../../../electron/main/ipcPolicy";

function issued(paths: Partial<Record<string, string[]>> = {}): IssuedPaths {
  const issued = new IssuedPaths();
  for (const [kind, list] of Object.entries(paths)) {
    for (const path of list ?? []) issued.issue(kind as never, path);
  }
  return issued;
}

describe("restore_book policy (restore-with-a-file spec)", () => {
  const pickedPath = "/tmp/picked.epub";
  const picked = issued({ "book-file": [pickedPath] });

  it("accepts an issued book-file path next to the trash id", () => {
    expect(() =>
      validateInvokeParams("restore_book", { trashId: 1, pickedPath }, picked),
    ).not.toThrow();
    expect(() =>
      validateInvokeParams("restore_book", { trashId: 1, mode: "replace", pickedPath }, picked),
    ).not.toThrow();
  });

  it("rejects a path the dialog never issued", () => {
    expect(() =>
      validateInvokeParams("restore_book", { trashId: 1, pickedPath: "/etc/passwd" }, picked),
    ).toThrow(/not issued/);
  });

  it("rejects a path issued under another dialog kind", () => {
    expect(() =>
      validateInvokeParams(
        "restore_book",
        { trashId: 1, pickedPath },
        issued({ directory: [pickedPath] }),
      ),
    ).toThrow(/not issued/);
  });

  it("rejects malformed picked paths even when issued", () => {
    expect(() =>
      validateInvokeParams(
        "restore_book",
        { trashId: 1, pickedPath: "relative/pick.epub" },
        issued({ "book-file": ["relative/pick.epub"] }),
      ),
    ).toThrow(/invalid pickedPath/);
    expect(() =>
      validateInvokeParams("restore_book", { trashId: 1, pickedPath: 42 }, picked),
    ).toThrow(/invalid pickedPath/);
  });

  it("still requires the trash id next to an issued path", () => {
    expect(() => validateInvokeParams("restore_book", { trashId: 0, pickedPath }, picked)).toThrow(
      /invalid trashId/,
    );
  });

  it("accepts the lossless modes with an issued picked path", () => {
    expect(() =>
      validateInvokeParams(
        "restore_book",
        { trashId: 1, mode: "link_edition", pickedPath },
        picked,
      ),
    ).not.toThrow();
    expect(() =>
      validateInvokeParams(
        "restore_book",
        { trashId: 1, mode: "without_file", pickedPath },
        picked,
      ),
    ).not.toThrow();
  });

  it("applies the same issued-path rule to the lossless modes", () => {
    for (const mode of ["link_edition", "without_file"]) {
      expect(() =>
        validateInvokeParams(
          "restore_book",
          { trashId: 1, mode, pickedPath: "/etc/passwd" },
          picked,
        ),
      ).toThrow(/not issued/);
    }
  });

  it("still rejects modes outside the five known ones", () => {
    expect(() =>
      validateInvokeParams("restore_book", { trashId: 1, mode: "sideways", pickedPath }, picked),
    ).toThrow(/invalid restore mode/);
  });
});
