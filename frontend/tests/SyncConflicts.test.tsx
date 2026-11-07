import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { invokeMock, mockInvoke } from "./mocks/bridge";
import {
  ENABLED,
  LOCAL_DEVICE,
  OTHER_DEVICE,
  conflict,
  invokesFor,
  renderSettings,
  resetSyncMocks,
} from "./mocks/syncFixtures";

beforeEach(resetSyncMocks);

describe("SyncSettings conflicts", () => {
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
});
