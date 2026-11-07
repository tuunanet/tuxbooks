import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { invokeMock, mockInvoke, emitBridgeEvent } from "./mocks/bridge";
import {
  ENABLED,
  conflict,
  invokesFor,
  renderSettings,
  resetSyncMocks,
} from "./mocks/syncFixtures";

beforeEach(resetSyncMocks);

describe("SyncSettings conflict actions", () => {
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
