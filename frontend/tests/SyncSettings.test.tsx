import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SyncSettings } from "@/components/settings/SyncSettings";
import type { SyncConflict, SyncIssue, SyncStatus } from "@/lib/bridge";
import {
  invokeMock,
  mockInvoke,
  openSyncFolderMock,
  pickBookFileMock,
  pickSyncFolderMock,
  emitBridgeEvent,
} from "./mocks/bridge";

const DISABLED: SyncStatus = {
  enabled: false,
  folder: null,
  libraryId: null,
  deviceId: null,
  deviceName: null,
  state: "disabled",
  lastSyncAt: null,
  lastError: null,
  pendingLocal: 0,
  waitingBooks: 0,
  issues: 0,
  trash: 0,
  conflicts: 0,
};

const ENABLED: SyncStatus = {
  enabled: true,
  folder: "/home/me/Dropbox",
  libraryId: "0123456789abcdef0123456789abcdef",
  deviceId: "fedcba9876543210fedcba9876543210",
  deviceName: "Laptop",
  state: "idle",
  lastSyncAt: "2026-10-28T10:00:00.000Z",
  lastError: null,
  pendingLocal: 2,
  waitingBooks: 1,
  issues: 0,
  trash: 1,
  conflicts: 0,
};

function renderSettings() {
  return render(<SyncSettings />);
}

const LOCAL_DEVICE = ENABLED.deviceId ?? "";
const OTHER_DEVICE = "11111111111111111111111111111111";
const CONFLICT_TIME = Date.parse("2026-10-28T10:00:00.000Z");

const clipboardWrite = vi.fn(async (_text: string) => {});

function issue(overrides: Partial<SyncIssue> = {}): SyncIssue {
  return {
    id: 7,
    kind: "operation_retrying",
    detail: "attempt 1: operation is not readable",
    fileName: "ops/abc/broken.json",
    action: "retry",
    target: "ops/abc/broken.json",
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:01:00.000Z",
    ...overrides,
  };
}

function conflict(overrides: Partial<SyncConflict> = {}): SyncConflict {
  return {
    id: 1,
    kind: "annotation",
    entityUid: "a".repeat(32),
    bookUid: "b".repeat(32),
    bookTitle: "The Book",
    bookAuthor: "Ada Author",
    field: "note",
    fieldLabel: null,
    winner: "Kept note",
    loser: "Discarded note",
    winnerDeviceId: LOCAL_DEVICE,
    winnerDeviceName: "Laptop",
    winnerWall: CONFLICT_TIME,
    winnerCounter: 0,
    loserDeviceId: OTHER_DEVICE,
    loserDeviceName: "Desktop",
    loserWall: CONFLICT_TIME - 60_000,
    loserCounter: 0,
    createdAt: "2026-10-28T10:05:00.000Z",
    canApplyLoser: true,
    applyLoserBlockedReason: null,
    ...overrides,
  };
}

function invokesFor(method: string) {
  return invokeMock.mock.calls.filter((call) => call[0] === method);
}

beforeEach(() => {
  invokeMock.mockReset();
  pickSyncFolderMock.mockReset();
  pickSyncFolderMock.mockResolvedValue("/home/me/Dropbox");
  pickBookFileMock.mockReset();
  pickBookFileMock.mockResolvedValue(null);
  openSyncFolderMock.mockReset();
  openSyncFolderMock.mockResolvedValue(undefined);
  clipboardWrite.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
});

describe("SyncSettings", () => {
  it("connects a folder and shows the enabled status", async () => {
    mockInvoke({
      sync_status: DISABLED,
      sync_connect: { status: ENABLED, mismatch: null },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [],
    });

    renderSettings();
    expect(await screen.findByText("Syncs between machines")).toBeInTheDocument();
    expect(screen.getByText("Reading progress and last-opened time")).toBeInTheDocument();
    expect(
      screen.getByText("Library metadata edits (values the book file cannot store)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Book files (EPUB and PDF)")).toBeInTheDocument();
    expect(screen.getByText("The library catalog and watched folders")).toBeInTheDocument();
    expect(
      screen.getByText(/Saving metadata into an EPUB or PDF rewrites the book file/i),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("sync-connect"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("sync_connect", { path: "/home/me/Dropbox" });
    });
    expect(await screen.findByTestId("sync-status")).toHaveTextContent("Up to date");
    expect(screen.getByTestId("sync-folder")).toHaveTextContent("/home/me/Dropbox");
    expect(screen.getByTestId("sync-device-name")).toHaveTextContent("Laptop");
  });

  it("shows counts, issues, and the restore affordance", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, issues: 1 },
      sync_issues: [
        issue({
          kind: "duplicate_book",
          action: "copy_details",
          target: "copy-two.epub",
          detail: "two files share one book identity",
          fileName: null,
        }),
      ],
      sync_trash: [
        {
          id: 11,
          kind: "annotation",
          label: "passage",
          deletedAt: "2026-10-27T10:00:00.000Z",
          expiresAt: "2026-11-26T10:00:00.000Z",
        },
      ],
      sync_restore: true,
      sync_dismiss_issue: true,
      sync_conflicts: [],
    });

    renderSettings();
    expect(await screen.findByText("duplicate book")).toBeInTheDocument();
    expect(screen.getByText("passage")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sync-dismiss-7"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_dismiss_issue", { id: 7 }));

    fireEvent.click(screen.getByTestId("sync-restore-11"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_restore", { id: 11 }));
  });

  it("requires confirmation before joining a folder from another library", async () => {
    const mismatch = {
      localLibraryId: "11111111111111111111111111111111",
      remoteLibraryId: "22222222222222222222222222222222",
    };
    invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "sync_status") return Promise.resolve(DISABLED);
      if (method === "sync_connect") {
        if (params?.confirmLibraryId === mismatch.remoteLibraryId) {
          return Promise.resolve({ status: ENABLED, mismatch: null });
        }
        return Promise.resolve({ status: DISABLED, mismatch });
      }
      if (
        method === "sync_issues" ||
        method === "sync_trash" ||
        method === "sync_conflicts" ||
        method === "list_waiting_books"
      ) {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-connect"));
    expect(await screen.findByTestId("sync-mismatch")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sync-confirm-join"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("sync_connect", {
        path: "/home/me/Dropbox",
        confirmLibraryId: mismatch.remoteLibraryId,
      });
    });
    expect(await screen.findByTestId("sync-status")).toHaveTextContent("Up to date");
  });

  it("starts a new library in a folder that already has one, without moving files", async () => {
    const mismatch = {
      localLibraryId: "11111111111111111111111111111111",
      remoteLibraryId: "22222222222222222222222222222222",
    };
    const archived = "/home/me/Dropbox/TuxBooks.before-20261029T150000Z";
    invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "sync_status") return Promise.resolve(DISABLED);
      if (method === "sync_connect") {
        if (params?.startNew === true) {
          return Promise.resolve({
            status: ENABLED,
            mismatch: null,
            archivedLibraryPath: archived,
          });
        }
        return Promise.resolve({ status: DISABLED, mismatch });
      }
      if (
        method === "sync_issues" ||
        method === "sync_trash" ||
        method === "sync_conflicts" ||
        method === "list_waiting_books"
      ) {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-connect"));
    expect(await screen.findByTestId("sync-mismatch")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sync-start-new"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("sync_connect", {
        path: "/home/me/Dropbox",
        startNew: true,
      });
    });
    expect(await screen.findByTestId("sync-notice")).toHaveTextContent(archived);
    expect(await screen.findByTestId("sync-status")).toHaveTextContent("Up to date");
  });

  it("lists waiting books and forgets one on this device", async () => {
    const waiting = {
      bookUid: "a".repeat(32),
      title: null,
      author: null,
      progressPercent: 12.1212121212121,
      annotationCount: 2,
      lastOpenedAt: null,
      sampleAnnotation: "xbooks PDF Fixtur",
    };
    let forgotten = false;
    invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "sync_status") {
        return Promise.resolve({ ...ENABLED, waitingBooks: forgotten ? 0 : 1 });
      }
      if (method === "sync_issues" || method === "sync_trash" || method === "sync_conflicts") {
        return Promise.resolve([]);
      }
      if (method === "list_waiting_books") return Promise.resolve(forgotten ? [] : [waiting]);
      if (method === "forget_waiting_book") {
        expect(params).toEqual({ bookUid: waiting.bookUid });
        forgotten = true;
        return Promise.resolve(true);
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    expect(await screen.findByTestId(`waiting-book-${waiting.bookUid}`)).toBeInTheDocument();
    expect(screen.getByText("Unknown book")).toBeInTheDocument();
    expect(screen.getByText(/12%/)).toBeInTheDocument();
    expect(screen.getByText(/2 annotations/)).toBeInTheDocument();
    expect(screen.getByText(/Sample: xbooks PDF Fixtur/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`forget-waiting-${waiting.bookUid}`));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("forget_waiting_book", {
        bookUid: waiting.bookUid,
      }),
    );
    expect(await screen.findByTestId("waiting-books-empty")).toBeInTheDocument();
  });

  it("locates a waiting book from the picked file and reloads the list", async () => {
    const waiting = {
      bookUid: "c".repeat(32),
      title: "Located",
      author: null,
      progressPercent: 30,
      annotationCount: 1,
      lastOpenedAt: null,
      sampleAnnotation: null,
    };
    const picked = "/home/me/Downloads/located.epub";
    pickBookFileMock.mockResolvedValue(picked);
    let attached = false;
    invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "sync_status") {
        return Promise.resolve({ ...ENABLED, waitingBooks: attached ? 0 : 1 });
      }
      if (method === "sync_issues" || method === "sync_trash" || method === "sync_conflicts") {
        return Promise.resolve([]);
      }
      if (method === "list_waiting_books") {
        return Promise.resolve(attached ? [] : [waiting]);
      }
      if (method === "attach_waiting_book") {
        expect(params).toEqual({ bookUid: waiting.bookUid, path: picked });
        attached = true;
        return Promise.resolve({ id: 9, bookUid: waiting.bookUid });
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId(`locate-waiting-${waiting.bookUid}`));

    expect(await screen.findByTestId("sync-notice")).toHaveTextContent(
      "Attached the waiting book.",
    );
    expect(await screen.findByTestId("waiting-books-empty")).toBeInTheDocument();
  });

  it("does not attach anything when the file picker is cancelled", async () => {
    const waiting = {
      bookUid: "d".repeat(32),
      title: "Cancelled",
      author: null,
      progressPercent: null,
      annotationCount: 0,
      lastOpenedAt: null,
      sampleAnnotation: null,
    };
    pickBookFileMock.mockResolvedValue(null);
    mockInvoke({
      sync_status: { ...ENABLED, waitingBooks: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [],
      list_waiting_books: [waiting],
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId(`locate-waiting-${waiting.bookUid}`));

    await waitFor(() => expect(pickBookFileMock).toHaveBeenCalled());
    expect(invokesFor("attach_waiting_book")).toHaveLength(0);
    expect(screen.getByTestId(`waiting-book-${waiting.bookUid}`)).toBeInTheDocument();
  });

  it("shows a byte mismatch and keeps the waiting row", async () => {
    const waiting = {
      bookUid: "e".repeat(32),
      title: "Mismatch",
      author: null,
      progressPercent: null,
      annotationCount: 0,
      lastOpenedAt: null,
      sampleAnnotation: null,
    };
    pickBookFileMock.mockResolvedValue("/tmp/other-edition.epub");
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") return Promise.resolve({ ...ENABLED, waitingBooks: 1 });
      if (method === "sync_issues" || method === "sync_trash" || method === "sync_conflicts") {
        return Promise.resolve([]);
      }
      if (method === "list_waiting_books") return Promise.resolve([waiting]);
      if (method === "attach_waiting_book") {
        return Promise.reject(
          new Error("those bytes belong to a different book, so nothing was attached"),
        );
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId(`locate-waiting-${waiting.bookUid}`));

    expect(await screen.findByTestId("sync-action-error")).toHaveTextContent("different book");
    expect(screen.getByTestId(`waiting-book-${waiting.bookUid}`)).toBeInTheDocument();
  });

  it("forgets all waiting books and dismisses all issues from their sections", async () => {
    const waiting = {
      bookUid: "b".repeat(32),
      title: "Waiting",
      author: null,
      progressPercent: 12,
      annotationCount: 2,
      lastOpenedAt: null,
      sampleAnnotation: null,
    };
    const issueRow = issue({
      kind: "duplicate_book",
      action: "copy_details",
      detail: "operation rejected",
      fileName: null,
    });
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") {
        return Promise.resolve({ ...ENABLED, waitingBooks: 1, issues: 1 });
      }
      if (method === "sync_issues") return Promise.resolve([issueRow]);
      if (method === "sync_trash") return Promise.resolve([]);
      if (method === "sync_conflicts") return Promise.resolve([]);
      if (method === "list_waiting_books") return Promise.resolve([waiting]);
      if (method === "forget_all_waiting_books") return Promise.resolve(1);
      if (method === "dismiss_all_sync_issues") return Promise.resolve(1);
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("waiting-books-forget-all"));
    fireEvent.click(await screen.findByTestId("waiting-books-forget-all-confirm"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("forget_all_waiting_books"));

    fireEvent.click(await screen.findByTestId("sync-issues-dismiss-all"));
    fireEvent.click(await screen.findByTestId("sync-issues-dismiss-all-confirm"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dismiss_all_sync_issues"));
  });

  it("disconnects only after confirmation", async () => {
    mockInvoke({
      sync_status: ENABLED,
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [],
      sync_disconnect: DISABLED,
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-disconnect"));
    expect(screen.getByTestId("sync-disconnect-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sync-confirm-disconnect"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_disconnect"));
    expect(await screen.findByTestId("sync-connect")).toBeInTheDocument();
  });

  it("shows the conflict empty state when nothing is open", async () => {
    mockInvoke({
      sync_status: ENABLED,
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [],
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflicts-empty")).toHaveTextContent(
      "No conflicts to review.",
    );
    expect(screen.getByText("Conflicts to review")).toBeInTheDocument();
    expect(screen.getByTestId("sync-conflicts-count")).toHaveTextContent("0");
  });

  it("uses the loaded list for the empty state, not the status count", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 3 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [],
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflicts-empty")).toHaveTextContent(
      "No conflicts to review.",
    );
    expect(screen.queryByTestId("sync-conflicts-all-deferred")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-conflicts-count")).toHaveTextContent("3");
  });

  it("groups conflicts by book and puts delete/edit rows first", async () => {
    const alpha = "a".repeat(32);
    const beta = "b".repeat(32);
    const conflicts = [
      conflict({
        id: 1,
        bookUid: alpha,
        bookTitle: "Book Alpha",
        field: "note",
        createdAt: "2026-10-28T10:00:00.000Z",
      }),
      conflict({
        id: 2,
        bookUid: beta,
        bookTitle: "Book Beta",
        field: "note",
        createdAt: "2026-10-28T10:00:00.000Z",
      }),
      conflict({
        id: 3,
        bookUid: alpha,
        bookTitle: "Book Alpha",
        field: "__deleted__",
        fieldLabel: "delete versus edit",
        winner: "deleted",
        loser: { note: "gone" },
        createdAt: "2026-10-28T10:03:00.000Z",
      }),
      conflict({
        id: 4,
        bookUid: beta,
        bookTitle: "Book Beta",
        field: "__entity__",
        fieldLabel: "whole entity",
        winner: { position: "one", percent: 10 },
        loser: { position: "two", percent: 20 },
        createdAt: "2026-10-28T10:04:00.000Z",
      }),
      conflict({
        id: 5,
        bookUid: alpha,
        bookTitle: "Book Alpha",
        field: "color",
        createdAt: "2026-10-28T10:02:00.000Z",
      }),
    ];
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: conflicts.length },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: conflicts,
    });

    renderSettings();
    await screen.findByTestId("sync-conflicts-list");

    expect(
      screen.getAllByTestId(/^sync-conflict-\d+$/).map((row) => row.getAttribute("data-testid")),
    ).toEqual([
      "sync-conflict-3",
      "sync-conflict-5",
      "sync-conflict-1",
      "sync-conflict-4",
      "sync-conflict-2",
    ]);
    expect(screen.getByText("Book Alpha")).toBeInTheDocument();
    expect(screen.getByText("Book Beta")).toBeInTheDocument();
    expect(screen.getByText("delete versus edit")).toBeInTheDocument();
    expect(screen.getByText("whole entity")).toBeInTheDocument();
    expect(screen.getByTestId("sync-conflict-4-kept")).toHaveTextContent("position");
    expect(screen.getByTestId("sync-conflict-4-kept")).toHaveTextContent("one");
    expect(screen.getByTestId("sync-conflict-4-discarded")).toHaveTextContent("two");
  });

  it("shows the current winner as applied before any choice", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [conflict({ bookTitle: null, bookAuthor: null })],
    });

    renderSettings();
    const kept = await screen.findByTestId("sync-conflict-1-kept");
    expect(kept).toHaveTextContent("Currently kept");
    expect(kept).toHaveTextContent("Kept note");
    expect(kept).toHaveTextContent("Laptop (this device)");
    expect(screen.getByTestId("sync-conflict-1-discarded")).toHaveTextContent("Discarded note");
    expect(screen.getByText("Unknown book")).toBeInTheDocument();
    expect(invokesFor("sync_resolve_conflict")).toHaveLength(0);
  });

  it("maps keep this device and keep other for a local winner", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [conflict()],
      sync_resolve_conflict: true,
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflict-1-this-device")).toHaveTextContent(
      "Keep this device",
    );
    expect(screen.getByTestId("sync-conflict-1-other")).toHaveTextContent("Keep other");

    fireEvent.click(screen.getByTestId("sync-conflict-1-this-device"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 1,
        resolution: "keep_winner",
      }),
    );

    await waitFor(() => expect(screen.getByTestId("sync-conflict-1-other")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("sync-conflict-1-other"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 1,
        resolution: "apply_loser",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sync-conflict-1-this-device")).not.toBeDisabled(),
    );
  });

  it("maps keep this device to applying the loser when the loser is local", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [
        conflict({
          winnerDeviceId: OTHER_DEVICE,
          winnerDeviceName: "Desktop",
          loserDeviceId: LOCAL_DEVICE,
          loserDeviceName: "Laptop",
        }),
      ],
      sync_resolve_conflict: true,
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflict-1-this-device")).toHaveTextContent(
      "Keep this device",
    );

    fireEvent.click(screen.getByTestId("sync-conflict-1-this-device"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 1,
        resolution: "apply_loser",
      }),
    );

    await waitFor(() => expect(screen.getByTestId("sync-conflict-1-other")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("sync-conflict-1-other"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 1,
        resolution: "keep_winner",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sync-conflict-1-this-device")).not.toBeDisabled(),
    );
  });

  it("uses neutral labels when neither device is this device", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [
        conflict({
          winnerDeviceId: OTHER_DEVICE,
          winnerDeviceName: "Desktop",
          loserDeviceId: "3".repeat(32),
          loserDeviceName: "Tablet",
        }),
      ],
      sync_resolve_conflict: true,
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflict-1-this-device")).toHaveTextContent(
      "Keep winner",
    );
    expect(screen.getByTestId("sync-conflict-1-other")).toHaveTextContent("Apply other");

    fireEvent.click(screen.getByTestId("sync-conflict-1-other"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 1,
        resolution: "apply_loser",
      }),
    );
  });

  it("disables applying the loser when the backend blocks it", async () => {
    const reason = "book identity merges are deterministic and cannot be replayed";
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [
        conflict({
          kind: "book_identity",
          field: "content_hash",
          winner: "abc",
          loser: "def",
          canApplyLoser: false,
          applyLoserBlockedReason: reason,
        }),
      ],
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflict-1-other")).toBeDisabled();
    expect(screen.getByTestId("sync-conflict-1-this-device")).not.toBeDisabled();
    expect(screen.getByTestId("sync-conflict-1-blocked")).toHaveTextContent(reason);
  });

  it("keeps the current winner for every shown conflict from the bulk action", async () => {
    let open = [
      conflict({ id: 1, createdAt: "2026-10-28T10:05:00.000Z" }),
      conflict({ id: 2, createdAt: "2026-10-28T10:04:00.000Z" }),
    ];
    invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "sync_status") return Promise.resolve({ ...ENABLED, conflicts: open.length });
      if (method === "sync_issues" || method === "sync_trash" || method === "list_waiting_books") {
        return Promise.resolve([]);
      }
      if (method === "sync_conflicts") return Promise.resolve(open);
      if (method === "sync_resolve_conflict") {
        open = open.filter((row) => row.id !== Number(params?.id));
        return Promise.resolve(true);
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-conflicts-keep-all"));
    fireEvent.click(screen.getByTestId("sync-conflicts-keep-all-confirm"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 1,
        resolution: "keep_winner",
      });
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 2,
        resolution: "keep_winner",
      });
    });
    expect(await screen.findByTestId("sync-conflicts-empty")).toHaveTextContent(
      "No conflicts to review.",
    );
    expect(await screen.findByTestId("sync-notice")).toHaveTextContent(
      "Kept the current winner for 2 conflicts.",
    );
  });

  it("continues the bulk action after one conflict fails and reloads", async () => {
    let open = [conflict({ id: 1 }), conflict({ id: 2 })];
    invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "sync_status") return Promise.resolve({ ...ENABLED, conflicts: open.length });
      if (method === "sync_issues" || method === "sync_trash" || method === "list_waiting_books") {
        return Promise.resolve([]);
      }
      if (method === "sync_conflicts") return Promise.resolve(open);
      if (method === "sync_resolve_conflict") {
        if (Number(params?.id) === 1) {
          return Promise.reject(new Error("could not keep conflict 1"));
        }
        open = open.filter((row) => row.id !== Number(params?.id));
        return Promise.resolve(true);
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-conflicts-keep-all"));
    fireEvent.click(screen.getByTestId("sync-conflicts-keep-all-confirm"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 2,
        resolution: "keep_winner",
      }),
    );
    expect(await screen.findByTestId("sync-action-error")).toHaveTextContent(
      "could not keep conflict 1",
    );
    expect(screen.getByTestId("sync-conflict-1")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("sync-conflict-2")).not.toBeInTheDocument());
    expect(screen.getByTestId("sync-conflicts-count")).toHaveTextContent("1");
  });

  it("keeps the bulk action to conflicts that are not set aside", async () => {
    let open = [conflict({ id: 1 }), conflict({ id: 2 })];
    invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "sync_status") return Promise.resolve({ ...ENABLED, conflicts: open.length });
      if (method === "sync_issues" || method === "sync_trash" || method === "list_waiting_books") {
        return Promise.resolve([]);
      }
      if (method === "sync_conflicts") return Promise.resolve(open);
      if (method === "sync_resolve_conflict") {
        open = open.filter((row) => row.id !== Number(params?.id));
        return Promise.resolve(true);
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-conflict-2-later"));
    fireEvent.click(screen.getByTestId("sync-conflicts-keep-all"));
    fireEvent.click(screen.getByTestId("sync-conflicts-keep-all-confirm"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_resolve_conflict", {
        id: 1,
        resolution: "keep_winner",
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("sync_resolve_conflict", {
      id: 2,
      resolution: "keep_winner",
    });
    expect(await screen.findByTestId("sync-conflicts-all-deferred")).toBeInTheDocument();
    expect(screen.getByText(/1 conflict is set aside for now/)).toBeInTheDocument();
    expect(await screen.findByTestId("sync-notice")).toHaveTextContent(
      "Kept the current winner for 1 conflict.",
    );
  });

  it("describes a delete/edit conflict without dumping JSON", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [
        conflict({
          field: "__deleted__",
          fieldLabel: "delete versus edit",
          winner: "deleted",
          loser: { note: "old note", color: "yellow" },
        }),
      ],
    });

    renderSettings();
    expect(await screen.findByText("delete versus edit")).toBeInTheDocument();
    expect(screen.getByTestId("sync-conflict-1-kept")).toHaveTextContent("Deleted");
    const discarded = screen.getByTestId("sync-conflict-1-discarded");
    expect(discarded).toHaveTextContent("Edited · 2 fields");
    expect(discarded).toHaveTextContent("note:");
    expect(discarded).toHaveTextContent("old note");
    expect(discarded).toHaveTextContent("color:");
    expect(discarded).toHaveTextContent("yellow");
    expect(discarded).not.toHaveTextContent("{");
    expect(discarded).toHaveAttribute("title", expect.stringContaining('"note"'));
  });

  it("sets a conflict aside for the session without resolving it", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [conflict()],
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflicts-count")).toHaveTextContent("1");
    expect(await screen.findByTestId("sync-conflict-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sync-conflict-1-later"));

    expect(screen.queryByTestId("sync-conflict-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-conflicts-count")).toHaveTextContent("1");
    expect(screen.getByTestId("sync-conflicts-all-deferred")).toBeInTheDocument();
    expect(screen.getByText(/1 conflict is set aside for now/)).toBeInTheDocument();
    expect(invokesFor("sync_resolve_conflict")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("sync-conflicts-show-deferred"));
    expect(await screen.findByTestId("sync-conflict-1")).toBeInTheDocument();
  });

  it("clears set-aside rows when the sync library changes", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 1 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: [conflict()],
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-conflict-1-later"));
    expect(screen.queryByTestId("sync-conflict-1")).not.toBeInTheDocument();

    emitBridgeEvent("sync-status", {
      ...ENABLED,
      libraryId: "9".repeat(32),
      folder: "/home/me/OtherDropbox",
    });

    expect(await screen.findByTestId("sync-conflict-1")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-conflicts-all-deferred")).not.toBeInTheDocument();
  });

  it("shows every conflict in the view all dialog", async () => {
    const conflicts = Array.from({ length: 6 }, (_, index) =>
      conflict({
        id: index + 1,
        entityUid: `${index}`.repeat(32),
        createdAt: `2026-10-28T10:0${index}:00.000Z`,
      }),
    );
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: conflicts.length },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: conflicts,
    });

    renderSettings();
    expect(await screen.findAllByTestId(/^sync-conflict-\d+$/)).toHaveLength(5);

    fireEvent.click(screen.getByTestId("sync-conflicts-view-all"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByTestId(/^sync-conflict-\d+$/)).toHaveLength(6);

    fireEvent.click(within(dialog).getByTestId("sync-conflicts-keep-all-dialog"));
    expect(await screen.findByTestId("sync-conflicts-keep-all-confirm")).toBeInTheDocument();
  });

  it("reports the loaded rows when the backend has more conflicts", async () => {
    const conflicts = Array.from({ length: 6 }, (_, index) =>
      conflict({
        id: index + 1,
        entityUid: `${index}`.repeat(32),
        createdAt: `2026-10-28T10:0${index}:00.000Z`,
      }),
    );
    mockInvoke({
      sync_status: { ...ENABLED, conflicts: 150 },
      sync_issues: [],
      sync_trash: [],
      sync_conflicts: conflicts,
    });

    renderSettings();
    expect(await screen.findByTestId("sync-conflicts-count")).toHaveTextContent("150");
    expect(screen.getByText("Showing first 6 of 150.")).toBeInTheDocument();
    expect(screen.getByTestId("sync-conflicts-view-all")).toHaveTextContent("View all 150");

    fireEvent.click(screen.getByTestId("sync-conflicts-view-all"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Showing first 6 of 150.")).toBeInTheDocument();
    expect(within(dialog).getAllByTestId(/^sync-conflict-\d+$/)).toHaveLength(6);

    fireEvent.click(within(dialog).getByTestId("sync-conflicts-keep-all-dialog"));
    expect(
      await screen.findByText(/The list loads the first 6 of 150 conflicts/),
    ).toBeInTheDocument();
  });
});

describe("Sync issue actions", () => {
  function routeIssue(target: SyncIssue, extra: Record<string, unknown> = {}) {
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") return Promise.resolve({ ...ENABLED, issues: 1 });
      if (method === "sync_issues") return Promise.resolve([target]);
      if (method === "sync_trash" || method === "sync_conflicts") return Promise.resolve([]);
      if (method === "list_waiting_books") return Promise.resolve([]);
      if (method in extra) {
        const response = extra[method];
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      }
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });
  }

  it("retries an actionable row without offering Dismiss", async () => {
    let resolved = false;
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") {
        return Promise.resolve({ ...ENABLED, issues: resolved ? 0 : 1 });
      }
      if (method === "sync_issues") return Promise.resolve(resolved ? [] : [issue()]);
      if (method === "sync_retry_issue") {
        resolved = true;
        return Promise.resolve(true);
      }
      if (method === "sync_trash" || method === "sync_conflicts") return Promise.resolve([]);
      if (method === "list_waiting_books") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });
    renderSettings();

    const retry = await screen.findByTestId("sync-retry-7");
    expect(retry).toHaveAccessibleName("Retry ops/abc/broken.json");
    expect(screen.queryByTestId("sync-dismiss-7")).not.toBeInTheDocument();

    fireEvent.click(retry);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_retry_issue", { id: 7 }));
    await waitFor(() => expect(screen.queryByTestId("sync-retry-7")).not.toBeInTheDocument());
    expect(screen.getByText("No sync issues.")).toBeInTheDocument();
  });

  it("keeps the row and shows the error when a retry fails", async () => {
    routeIssue(issue(), { sync_retry_issue: new Error("retry failed: bookmark is gone") });
    renderSettings();

    fireEvent.click(await screen.findByTestId("sync-retry-7"));
    expect(await screen.findByTestId("sync-action-error")).toHaveTextContent(
      "retry failed: bookmark is gone",
    );
    expect(screen.getByTestId("sync-retry-7")).toBeInTheDocument();
  });

  it("opens the sync folder for a rejected operation without a renderer path", async () => {
    routeIssue(
      issue({
        kind: "operation_rejected",
        action: "open_folder",
        target: "ops/abc/broken.json",
      }),
    );
    renderSettings();

    fireEvent.click(await screen.findByTestId("sync-open-folder-7"));
    expect(screen.getByTestId("sync-open-folder-7")).toHaveAccessibleName(
      "Open folder for ops/abc/broken.json",
    );
    await waitFor(() => expect(openSyncFolderMock).toHaveBeenCalledTimes(1));
    expect(openSyncFolderMock).toHaveBeenCalledWith();
    expect(screen.queryByTestId("sync-dismiss-7")).not.toBeInTheDocument();
  });

  it("copies a readable detail block and keeps Dismiss for informational rows", async () => {
    routeIssue(
      issue({
        kind: "duplicate_book",
        action: "copy_details",
        target: "copy-two.epub",
      }),
      { sync_dismiss_issue: true },
    );
    renderSettings();

    fireEvent.click(await screen.findByTestId("sync-copy-details-7"));
    expect(screen.getByTestId("sync-copy-details-7")).toHaveAccessibleName(
      "Copy details for copy-two.epub",
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copied = String(clipboardWrite.mock.calls[0]?.[0]);
    expect(copied).toContain("Sync issue: duplicate book");
    expect(copied).toContain("Target: copy-two.epub");
    expect(copied).toContain("File: ops/abc/broken.json");
    expect(copied).toContain("Detail: attempt 1");
    expect(await screen.findByTestId("sync-notice")).toHaveTextContent("Copied issue details.");

    fireEvent.click(screen.getByTestId("sync-dismiss-7"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_dismiss_issue", { id: 7 }));
  });

  it("shows Copy details and Dismiss on an informational row", async () => {
    routeIssue(
      issue({
        kind: "duplicate_book",
        action: "copy_details",
        target: "copy-two.epub",
      }),
      { sync_dismiss_issue: true },
    );
    renderSettings();

    expect(await screen.findByTestId("sync-copy-details-7")).toHaveTextContent("Copy details");
    fireEvent.click(screen.getByTestId("sync-dismiss-7"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_dismiss_issue", { id: 7 }));
  });

  it("shows Dismiss as the primary action for an internal marker", async () => {
    routeIssue(
      issue({
        kind: "invalid_dirty_kind",
        action: "dismiss",
        target: "mystery",
      }),
      { sync_dismiss_issue: true },
    );
    renderSettings();

    fireEvent.click(await screen.findByTestId("sync-dismiss-7"));
    expect(screen.getByTestId("sync-dismiss-7")).toHaveAccessibleName("Dismiss mystery");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_dismiss_issue", { id: 7 }));
    expect(screen.queryByTestId("sync-retry-7")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-copy-details-7")).toBeInTheDocument();
  });
});
