import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { SyncIssue } from "@/lib/bridge";
import { copyTextMock, invokeMock, openSyncFolderMock } from "./mocks/bridge";
import { ENABLED, issue, renderSettings, resetSyncMocks } from "./mocks/syncFixtures";

beforeEach(resetSyncMocks);

describe("Sync issue actions", () => {
  function routeIssue(target: SyncIssue, extra: Record<string, unknown> = {}) {
    invokeMock.mockImplementation((method: string) => {
      if (method === "sync_status") return Promise.resolve({ ...ENABLED, issues: 1 });
      if (method === "sync_issues") return Promise.resolve([target]);
      if (method === "sync_trash") return Promise.resolve([]);
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
      if (method === "sync_trash") return Promise.resolve([]);
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
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));
    const copied = String(copyTextMock.mock.calls[0]?.[0]);
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
