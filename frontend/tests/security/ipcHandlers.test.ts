import { describe, expect, it, vi } from "vitest";

import { registerIpcHandlers, type IpcHandler } from "../../../electron/main/ipcHandlers";
import { IssuedPaths } from "../../../electron/main/ipcPolicy";
import { IPC_CHANNELS } from "../../../electron/shared/pathSchema";

const ALLOWED = "app://bundle/index.html";
const HOSTILE = "app://evil/index.html";

function senderEvent(url: string): { senderFrame: { url: string } } {
  return { senderFrame: { url } };
}

function argsFor(channel: string): unknown[] {
  if (channel === IPC_CHANNELS.invoke) return ["list_books", {}];
  if (channel === IPC_CHANNELS.dialog) return ["directory"];
  return [3];
}

function harness(): {
  handlers: Map<string, IpcHandler>;
  sidecar: { call: ReturnType<typeof vi.fn> };
  dialog: { showOpenDialog: ReturnType<typeof vi.fn> };
  shell: { showItemInFolder: ReturnType<typeof vi.fn> };
} {
  const handlers = new Map<string, IpcHandler>();
  const sidecar = {
    call: vi.fn(async (method: string) =>
      method === "list_books" ? [{ id: 3, path: "/library/3.epub" }] : {},
    ),
  };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/picked/one.epub"] })),
  };
  const shell = { showItemInFolder: vi.fn() };
  registerIpcHandlers((channel, handler) => handlers.set(channel, handler), {
    sidecar,
    issued: new IssuedPaths(),
    dialog,
    shell,
    debugIpc: false,
  });
  return { handlers, sidecar, dialog, shell };
}

describe("ipcHandlers (every renderer-facing channel gates its sender, T-6)", () => {
  it.each([IPC_CHANNELS.invoke, IPC_CHANNELS.dialog, IPC_CHANNELS.reveal])(
    "%s rejects a disallowed sender before touching anything native",
    async (channel) => {
      const { handlers, sidecar, dialog, shell } = harness();
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await expect(handler!(senderEvent(HOSTILE) as never, ...argsFor(channel))).rejects.toThrow(
        /sender/,
      );
      expect(sidecar.call).not.toHaveBeenCalled();
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it.each([IPC_CHANNELS.invoke, IPC_CHANNELS.dialog, IPC_CHANNELS.reveal])(
    "%s admits the application page",
    async (channel) => {
      const { handlers, sidecar, dialog, shell } = harness();
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await handler!(senderEvent(ALLOWED) as never, ...argsFor(channel));
      if (channel === IPC_CHANNELS.dialog) {
        expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
      }
      if (channel === IPC_CHANNELS.reveal) {
        expect(shell.showItemInFolder).toHaveBeenCalledWith("/library/3.epub");
        expect(sidecar.call).toHaveBeenCalledWith("list_books");
      }
      if (channel === IPC_CHANNELS.invoke) {
        expect(sidecar.call).toHaveBeenCalled();
      }
    },
  );
});
