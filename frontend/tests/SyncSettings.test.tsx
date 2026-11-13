import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { invokeMock, mockInvoke, pickBookFileMock, emitBridgeEvent } from "./mocks/bridge";
import {
  DISABLED,
  ENABLED,
  invokesFor,
  issue,
  renderSettings,
  resetSyncMocks,
} from "./mocks/syncFixtures";

beforeEach(resetSyncMocks);

describe("SyncSettings", () => {
  it("connects a folder and shows the enabled status", async () => {
    mockInvoke({
      sync_status: DISABLED,
      sync_connect: { status: ENABLED, mismatch: null },
      sync_issues: [],
      sync_trash: [],
    });

    renderSettings();
    expect(await screen.findByText("Syncs between machines")).toBeInTheDocument();
    expect(screen.getByText("Reading progress and last-opened time")).toBeInTheDocument();
    expect(
      screen.getByText("Library metadata edits (values the book file cannot store)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Book files themselves")).toBeInTheDocument();
    expect(screen.getByText("The library catalog and watched folders")).toBeInTheDocument();
    expect(
      screen.getByText(/Saving metadata into a book file rewrites that file/i),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("sync-connect"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("sync_connect", { path: "/home/me/Dropbox" });
    });
    expect(await screen.findByTestId("sync-status")).toHaveTextContent("Up to date");
    expect(screen.getByTestId("sync-folder")).toHaveTextContent("/home/me/Dropbox");
    expect(screen.getByTestId("sync-device-name")).toHaveTextContent("Laptop");
  });

  it("keeps the typed device name when a status refresh arrives", async () => {
    mockInvoke({
      sync_status: ENABLED,
      sync_issues: [],
      sync_trash: [],
      sync_set_device_name: { ...ENABLED, deviceName: "Desk" },
    });

    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Name");
    expect(input).toHaveValue("Laptop");
    fireEvent.change(input, { target: { value: "Desk" } });

    // The settings page polls and listens for sync-status; neither may reset
    // the draft while the dialog is open.
    act(() => emitBridgeEvent("sync-status", ENABLED));

    expect(input).toHaveValue("Desk");

    fireEvent.click(screen.getByTestId("sync-save-device"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_set_device_name", { name: "Desk" }),
    );
  });

  it("shows counts, issues, and the restore affordance", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, issues: 1 },
      sync_issues: [
        issue({
          kind: "duplicate_book",
          action: "copyDetails",
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
      if (method === "sync_issues" || method === "sync_trash" || method === "list_waiting_books") {
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
      if (method === "sync_issues" || method === "sync_trash" || method === "list_waiting_books") {
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
      if (method === "sync_issues" || method === "sync_trash") {
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
      if (method === "sync_issues" || method === "sync_trash") {
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
      if (method === "sync_issues" || method === "sync_trash") {
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
      action: "copyDetails",
      detail: "operation rejected",
      fileName: null,
    });
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") {
        return Promise.resolve({ ...ENABLED, waitingBooks: 1, issues: 1 });
      }
      if (method === "sync_issues") return Promise.resolve([issueRow]);
      if (method === "sync_trash") return Promise.resolve([]);
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

  it("toggles automatic retry through the bridge and adopts the stored value", async () => {
    mockInvoke({
      sync_status: ENABLED,
      sync_issues: [],
      sync_trash: [],
      sync_set_auto_retry: { ...ENABLED, autoRetry: false },
    });

    renderSettings();
    const toggle = await screen.findByTestId("sync-auto-retry");
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("sync_set_auto_retry", { enabled: false }),
    );
    expect(await screen.findByTestId("sync-auto-retry")).not.toBeChecked();
  });

  it("shows the next auto-retry attempt time on a scheduled row", async () => {
    mockInvoke({
      sync_status: { ...ENABLED, issues: 1 },
      sync_issues: [
        issue({
          autoAttempts: 1,
          nextAutoRetryAt: "2026-10-28T10:05:00.000Z",
        }),
      ],
      sync_trash: [],
    });

    renderSettings();
    const next = await screen.findByText(/Next retry/);
    // Local rendering, not the raw ISO payload the bridge hands over.
    expect(next).toHaveTextContent("2026");
    expect(next).not.toHaveTextContent("T10:05");
  });

  it("disconnects only after confirmation", async () => {
    mockInvoke({
      sync_status: ENABLED,
      sync_issues: [],
      sync_trash: [],
      sync_disconnect: DISABLED,
    });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-disconnect"));
    expect(screen.getByTestId("sync-disconnect-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sync-confirm-disconnect"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("sync_disconnect"));
    expect(await screen.findByTestId("sync-connect")).toBeInTheDocument();
  });
});
