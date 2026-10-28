import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { SyncSettings } from "@/components/settings/SyncSettings";
import type { SyncStatus } from "@/lib/bridge";
import { invokeMock, mockInvoke, pickSyncFolderMock } from "./mocks/bridge";

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

beforeEach(() => {
  invokeMock.mockReset();
  pickSyncFolderMock.mockReset();
  pickSyncFolderMock.mockResolvedValue("/home/me/Dropbox");
});

describe("SyncSettings", () => {
  it("connects a folder and shows the enabled status", async () => {
    mockInvoke({
      sync_status: DISABLED,
      sync_connect: { status: ENABLED, mismatch: null },
      sync_issues: [],
      sync_trash: [],
    });

    renderSettings();
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
        {
          id: 7,
          kind: "operation_rejected",
          detail: "operation is larger than the 1 MiB limit",
          fileName: "ops/abc/broken.json",
          createdAt: "2026-10-28T10:00:00.000Z",
          updatedAt: "2026-10-28T10:01:00.000Z",
        },
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
    expect(await screen.findByText("operation rejected")).toBeInTheDocument();
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
      if (method === "sync_issues" || method === "sync_trash") return Promise.resolve([]);
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
