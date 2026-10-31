import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppShell } from "@/components/layout/AppShell";
import { Sidebar } from "@/components/layout/Sidebar";
import { SyncAttentionToast } from "@/components/layout/SyncAttentionToast";
import type { SyncStatus } from "@/lib/bridge";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { SyncAttentionProvider } from "@/state/SyncAttentionProvider";
import { useAppState, type AppState } from "@/state/appState";
import { useSyncAttention } from "@/state/syncAttentionState";
import { emitBridgeEvent, installTuxbooksMock, mockInvoke } from "./mocks/bridge";

const IDLE: SyncStatus = {
  enabled: true,
  folder: "/home/me/Dropbox",
  libraryId: "0123456789abcdef0123456789abcdef",
  deviceId: "fedcba9876543210fedcba9876543210",
  deviceName: "Laptop",
  state: "idle",
  lastSyncAt: "2026-10-28T10:00:00.000Z",
  lastError: null,
  pendingLocal: 0,
  waitingBooks: 0,
  issues: 0,
  trash: 0,
  conflicts: 0,
};

const ERROR: SyncStatus = { ...IDLE, state: "error", lastError: "Folder disappeared" };
const WITH_ISSUES: SyncStatus = { ...IDLE, issues: 2 };
const WITH_CONFLICTS: SyncStatus = { ...IDLE, conflicts: 1 };

function Harness() {
  const app = useAppState();
  const { attention, toastVisible } = useSyncAttention();
  return (
    <div>
      <span data-testid="attention">{attention ? "attention" : "clear"}</span>
      <span data-testid="toast-state">{toastVisible ? "visible" : "hidden"}</span>
      <span data-testid="section-kind">{app.section.kind}</span>
      <Sidebar active={app.section} onSectionChange={() => {}} />
    </div>
  );
}

function renderAttention(
  status: SyncStatus | Error | Promise<SyncStatus>,
  initialState?: Partial<AppState>,
) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
    sync_status: status,
  });

  return render(
    <AppStateProvider initialState={initialState}>
      <SyncAttentionProvider>
        <LibraryDataProvider>
          <Harness />
        </LibraryDataProvider>
        <SyncAttentionToast />
      </SyncAttentionProvider>
    </AppStateProvider>,
  );
}

/**
 * Render with a status read the test resolves by hand, so a later event is a
 * real transition rather than the first observed status.
 */
async function renderWithInitialStatus(status: SyncStatus, initialState?: Partial<AppState>) {
  const { view, pending, resolveStatus } = renderPendingStatus(initialState);
  await act(async () => {
    resolveStatus(status);
    await pending;
  });
  return view;
}

/** Render with the mount read still pending, for race tests. */
function renderPendingStatus(initialState?: Partial<AppState>) {
  let resolveStatus!: (value: SyncStatus) => void;
  const pending = new Promise<SyncStatus>((resolve) => {
    resolveStatus = resolve;
  });
  const view = renderAttention(pending, initialState);
  return { view, pending, resolveStatus };
}

function emitStatus(status: SyncStatus) {
  act(() => emitBridgeEvent("sync-status", status));
}

beforeEach(() => {
  installTuxbooksMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SyncAttentionProvider", () => {
  it("shows no dot and no toast for an idle status", async () => {
    await renderWithInitialStatus(IDLE);

    expect(screen.getByTestId("attention")).toHaveTextContent("clear");
    expect(screen.queryByTestId("settings-attention-dot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("keeps the live region mounted while the toast is hidden", async () => {
    await renderWithInitialStatus(IDLE);

    const live = screen.getByTestId("sync-attention-live");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toBeEmptyDOMElement();
  });

  it("shows the dot for an error without toasting on the initial load", async () => {
    await renderWithInitialStatus(ERROR);

    expect(screen.getByTestId("settings-attention-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
    // The dot is not color-only: the entry still reads "Settings" and carries
    // an accessible hint.
    const settings = screen.getByRole("button", { name: /sync needs attention/i });
    expect(settings).toHaveTextContent("Settings");
  });

  it("shows the dot when issues are open", async () => {
    await renderWithInitialStatus(WITH_ISSUES);

    expect(screen.getByTestId("settings-attention-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("shows the dot when conflicts are waiting", async () => {
    await renderWithInitialStatus(WITH_CONFLICTS);

    expect(screen.getByTestId("settings-attention-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("ignores an error while sync is disabled", async () => {
    await renderWithInitialStatus({ ...ERROR, enabled: false, state: "disabled" });

    expect(screen.getByTestId("attention")).toHaveTextContent("clear");
    expect(screen.queryByTestId("settings-attention-dot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("renders the shell when the status read fails", async () => {
    renderAttention(new Error("status unavailable"));
    await act(async () => {});

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-attention-dot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("toasts on the transition from idle into attention", async () => {
    await renderWithInitialStatus(IDLE);

    emitStatus(ERROR);

    const toast = await screen.findByTestId("sync-attention-toast");
    expect(toast).toHaveTextContent("Sync needs attention. Review it in Settings.");
    expect(screen.getByTestId("settings-attention-dot")).toBeInTheDocument();
    expect(screen.getByTestId("toast-state")).toHaveTextContent("visible");
  });

  it("hides the toast card in the reader but keeps the live region", async () => {
    await renderWithInitialStatus(IDLE, { view: "reader" });

    emitStatus(ERROR);

    await waitFor(() => expect(screen.getByTestId("attention")).toHaveTextContent("attention"));
    expect(screen.getByTestId("toast-state")).toHaveTextContent("visible");
    expect(screen.getByTestId("sync-attention-live")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("does not toast again on a later attention event", async () => {
    await renderWithInitialStatus(IDLE);
    emitStatus(ERROR);
    await screen.findByTestId("sync-attention-toast");

    emitStatus(WITH_ISSUES);

    await waitFor(() => expect(screen.getByTestId("attention")).toHaveTextContent("attention"));
    expect(screen.getAllByTestId("sync-attention-toast")).toHaveLength(1);
    expect(screen.getByTestId("toast-state")).toHaveTextContent("visible");
  });

  it("clears the dot and the toast when attention resolves", async () => {
    await renderWithInitialStatus(IDLE);
    emitStatus(ERROR);
    await screen.findByTestId("sync-attention-toast");

    emitStatus(IDLE);

    await waitFor(() =>
      expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("settings-attention-dot")).not.toBeInTheDocument();
    expect(screen.getByTestId("attention")).toHaveTextContent("clear");
  });

  it("keeps a dismissed toast hidden until attention clears and returns", async () => {
    await renderWithInitialStatus(IDLE);
    emitStatus(ERROR);
    await screen.findByTestId("sync-attention-toast");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss sync attention notice" }));

    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-attention-dot")).toBeInTheDocument();

    // Still in attention: another status event must not reopen it.
    emitStatus(WITH_ISSUES);
    await waitFor(() => expect(screen.getByTestId("attention")).toHaveTextContent("attention"));
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();

    emitStatus(IDLE);
    await waitFor(() =>
      expect(screen.queryByTestId("settings-attention-dot")).not.toBeInTheDocument(),
    );

    emitStatus(ERROR);
    expect(await screen.findByTestId("sync-attention-toast")).toBeInTheDocument();
  });

  it("keeps the event status when the mount read resolves later", async () => {
    const { pending, resolveStatus } = renderPendingStatus();

    // The event is newer than the read that is still in flight.
    emitStatus(ERROR);
    await waitFor(() => expect(screen.getByTestId("attention")).toHaveTextContent("attention"));
    expect(screen.getByTestId("settings-attention-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();

    await act(async () => {
      resolveStatus(IDLE);
      await pending;
    });

    expect(screen.getByTestId("attention")).toHaveTextContent("attention");
    expect(screen.getByTestId("settings-attention-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("does not toast from a stale mount read after an idle event", async () => {
    const { pending, resolveStatus } = renderPendingStatus();

    emitStatus(IDLE);

    await act(async () => {
      resolveStatus(ERROR);
      await pending;
    });

    expect(screen.getByTestId("attention")).toHaveTextContent("clear");
    expect(screen.queryByTestId("settings-attention-dot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("unsubscribes from sync-status on unmount", async () => {
    const stop = vi.fn();
    const originalOnEvent = window.tuxbooks!.onEvent;
    vi.spyOn(window.tuxbooks!, "onEvent").mockImplementation((name, callback) => {
      const unlisten = originalOnEvent(name, callback);
      if (name !== "sync-status") return unlisten;
      return () => {
        stop();
        unlisten();
      };
    });

    const { unmount } = await renderWithInitialStatus(IDLE);
    unmount();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("shows the dot in the real app shell", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
      sync_status: ERROR,
    });

    render(<AppShell />);

    expect(await screen.findByTestId("settings-attention-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-attention-toast")).not.toBeInTheDocument();
  });

  it("opens Settings from the toast", async () => {
    await renderWithInitialStatus(IDLE);
    emitStatus(ERROR);
    await screen.findByTestId("sync-attention-toast");

    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));

    expect(screen.getByTestId("section-kind")).toHaveTextContent("settings");
  });
});
