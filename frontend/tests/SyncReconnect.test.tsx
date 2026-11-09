import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { invokeMock } from "./mocks/bridge";
import { ENABLED, renderSettings, resetSyncMocks } from "./mocks/syncFixtures";
import type { SyncStatus } from "@/lib/bridge";

/**
 * The Reconnect affordance on the sync error state: shown only when the
 * folder's library changed underneath the device ("belongs to a different
 * library"), it re-opens the existing mismatch confirmation.
 */

const MISMATCH_ERROR = "sync folder belongs to a different library; reconnect to confirm";
// The sidecar stores last_error as the error's Display form, so the stable
// pass message arrives prefixed by the AppError wrapper ("invalid input: ").
// Fixtures replay that full string; the UI matches on the suffix only.
const LAST_MISMATCH_ERROR = `invalid input: ${MISMATCH_ERROR}`;

const MISMATCHED: SyncStatus = {
  ...ENABLED,
  state: "error",
  lastError: LAST_MISMATCH_ERROR,
};

const mismatch = {
  localLibraryId: "11111111111111111111111111111111",
  remoteLibraryId: "22222222222222222222222222222222",
};

/** Route invokes for a connected device whose folder now holds another library. */
function mockMismatchedConnect(confirmed?: { status: SyncStatus }) {
  invokeMock.mockImplementation((method: string, params?: Record<string, unknown>) => {
    if (method === "sync_status") return Promise.resolve(MISMATCHED);
    if (method === "sync_connect") {
      if (params?.confirmLibraryId === mismatch.remoteLibraryId && confirmed) {
        return Promise.resolve({ status: confirmed.status, mismatch: null });
      }
      return Promise.resolve({ status: MISMATCHED, mismatch });
    }
    if (method === "sync_issues" || method === "sync_trash") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected invoke(${method})`));
  });
}

beforeEach(resetSyncMocks);

describe("SyncSettings reconnect", () => {
  it("shows Reconnect next to Sync now and Disconnect on the library-mismatch error", async () => {
    mockMismatchedConnect();

    renderSettings();
    expect(await screen.findByTestId("sync-reconnect")).toBeInTheDocument();
    expect(screen.getByTestId("sync-now")).toBeInTheDocument();
    expect(screen.getByTestId("sync-disconnect")).toBeInTheDocument();
    expect(screen.getByTestId("sync-error")).toHaveTextContent("belongs to a different library");
  });

  it("shows no Reconnect for other sync errors", async () => {
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") {
        return Promise.resolve({
          ...ENABLED,
          state: "error",
          // Same AppError wrapper shape as the mismatch error's real payload.
          lastError: "invalid input: sync folder /home/me/Dropbox is missing library.json",
        });
      }
      if (method === "sync_issues" || method === "sync_trash") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    expect(await screen.findByTestId("sync-error")).toHaveTextContent("missing library.json");
    expect(screen.queryByTestId("sync-reconnect")).not.toBeInTheDocument();
  });

  it("disables Reconnect while a pass runs with the stale mismatch error", async () => {
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") {
        return Promise.resolve({ ...MISMATCHED, state: "syncing" });
      }
      if (method === "sync_issues" || method === "sync_trash") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected invoke(${method})`));
    });

    renderSettings();
    expect(await screen.findByTestId("sync-reconnect")).toBeDisabled();
    expect(screen.getByTestId("sync-status")).toHaveTextContent("Syncing");
  });

  it("reconnect opens the existing mismatch confirmation with both choices", async () => {
    mockMismatchedConnect();

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-reconnect"));

    expect(await screen.findByTestId("sync-mismatch")).toBeInTheDocument();
    // No folder picker: reconnect reuses the folder the device points at.
    expect(invokeMock).toHaveBeenCalledWith("sync_connect", { path: "/home/me/Dropbox" });
    expect(screen.getByTestId("sync-confirm-join")).toHaveTextContent("Use this library");
    expect(screen.getByTestId("sync-start-new")).toHaveTextContent("Start a new library here");
  });

  it("cancelling reconnect keeps the folder connected and the error visible", async () => {
    mockMismatchedConnect();

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-reconnect"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("sync-mismatch")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-folder")).toHaveTextContent("/home/me/Dropbox");
    expect(screen.getByTestId("sync-error")).toHaveTextContent("belongs to a different library");
    expect(screen.getByTestId("sync-reconnect")).toBeInTheDocument();
    const connects = invokeMock.mock.calls.filter((call) => call[0] === "sync_connect");
    expect(connects).toHaveLength(1);
  });

  it("a confirmed reconnect merges into the folder's library and clears the error", async () => {
    mockMismatchedConnect({ status: { ...ENABLED, lastError: null } });

    renderSettings();
    fireEvent.click(await screen.findByTestId("sync-reconnect"));
    fireEvent.click(await screen.findByTestId("sync-confirm-join"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("sync_connect", {
        path: "/home/me/Dropbox",
        confirmLibraryId: mismatch.remoteLibraryId,
      });
    });
    expect(await screen.findByTestId("sync-status")).toHaveTextContent("Up to date");
    expect(screen.queryByTestId("sync-error")).not.toBeInTheDocument();
  });
});
