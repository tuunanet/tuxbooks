import { beforeEach, describe, expect, it } from "vite-plus/test";

import { forgetBooks } from "@/lib/bridge";
import type { BulkForgetOutcome } from "@/lib/bridge";
import { invokeMock } from "./mocks/bridge";

/**
 * The main process bounds bulk Forget: validateForgetBooks in
 * electron/main/ipcPolicy.ts rejects any forget_books invoke carrying more
 * than MAX_BULK_BOOK_IDS ids with "invalid bookIds". The renderer must chunk
 * large selections across several invokes, or "Forget selected" on a big
 * Reading history always fails (tuxbooks-2ec).
 */
const MAX_BULK_BOOK_IDS = 1000;

/**
 * invoke stub mirroring the main-process policy: rejects oversized bookIds
 * exactly like validateForgetBooks, and answers each compliant call with the
 * next queued outcome (the sidecar returns one BulkForgetOutcome per call).
 */
function installPolicyStub(outcomes: BulkForgetOutcome[]): void {
  let next = 0;
  invokeMock.mockImplementation((_method: string, params?: Record<string, unknown>) => {
    const bookIds = (params as { bookIds?: unknown })?.bookIds;
    if (
      !Array.isArray(bookIds) ||
      bookIds.length > MAX_BULK_BOOK_IDS ||
      bookIds.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    ) {
      return Promise.reject(new Error("invalid bookIds"));
    }
    const outcome = outcomes[next];
    next += 1;
    return Promise.resolve(outcome);
  });
}

function ids(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("forgetBooks bulk bound", () => {
  it("forgets a 1002-book selection by chunking under the policy bound", async () => {
    const selection = ids(1002);
    installPolicyStub([
      { forgotten: MAX_BULK_BOOK_IDS, trashIds: selection.slice(0, MAX_BULK_BOOK_IDS) },
      { forgotten: 2, trashIds: selection.slice(MAX_BULK_BOOK_IDS) },
    ]);

    const outcome = await forgetBooks(selection);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "forget_books", {
      bookIds: selection.slice(0, MAX_BULK_BOOK_IDS),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "forget_books", {
      bookIds: selection.slice(MAX_BULK_BOOK_IDS),
    });
    expect(outcome).toEqual({ forgotten: 1002, trashIds: selection });
  });

  it("splits 1001 books into a full chunk and a one-book remainder", async () => {
    const selection = ids(1001);
    installPolicyStub([
      { forgotten: MAX_BULK_BOOK_IDS, trashIds: selection.slice(0, MAX_BULK_BOOK_IDS) },
      { forgotten: 1, trashIds: selection.slice(MAX_BULK_BOOK_IDS) },
    ]);

    const outcome = await forgetBooks(selection);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ forgotten: 1001, trashIds: selection });
  });

  it("keeps a selection at the bound a single invoke", async () => {
    const selection = ids(MAX_BULK_BOOK_IDS);
    installPolicyStub([{ forgotten: MAX_BULK_BOOK_IDS, trashIds: selection }]);

    const outcome = await forgetBooks(selection);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("forget_books", { bookIds: selection });
    expect(outcome).toEqual({ forgotten: MAX_BULK_BOOK_IDS, trashIds: selection });
  });
});
