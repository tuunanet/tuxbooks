import { render } from "@testing-library/react";

import { SyncSettings } from "@/components/settings/SyncSettings";
import type { SyncConflict, SyncIssue, SyncStatus } from "@/lib/bridge";
import {
  copyTextMock,
  invokeMock,
  openSyncFolderMock,
  pickBookFileMock,
  pickSyncFolderMock,
} from "./bridge";

/**
 * Shared fixtures and render helper for the Settings > Sync test files, plus
 * the mock reset every one of them runs before each test.
 */

export const DISABLED: SyncStatus = {
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

export const ENABLED: SyncStatus = {
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

export const LOCAL_DEVICE = ENABLED.deviceId ?? "";
export const OTHER_DEVICE = "11111111111111111111111111111111";
export const CONFLICT_TIME = Date.parse("2026-10-28T10:00:00.000Z");

export function renderSettings() {
  return render(<SyncSettings />);
}

export function issue(overrides: Partial<SyncIssue> = {}): SyncIssue {
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

export function conflict(overrides: Partial<SyncConflict> = {}): SyncConflict {
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

export function invokesFor(method: string) {
  return invokeMock.mock.calls.filter((call) => call[0] === method);
}

export function resetSyncMocks(): void {
  invokeMock.mockReset();
  pickSyncFolderMock.mockReset();
  pickSyncFolderMock.mockResolvedValue("/home/me/Dropbox");
  pickBookFileMock.mockReset();
  pickBookFileMock.mockResolvedValue(null);
  openSyncFolderMock.mockReset();
  openSyncFolderMock.mockResolvedValue(undefined);
  copyTextMock.mockReset();
  copyTextMock.mockResolvedValue(undefined);
}
