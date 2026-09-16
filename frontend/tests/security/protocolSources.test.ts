import { describe, expect, it, vi } from "vitest";

import { NotFoundError, handleProtocolRequest } from "../../../electron/main/protocolHandler";
import { makeProtocolSources, translateSourceError } from "../../../electron/main/protocolSources";
import { RpcFailure } from "../../../electron/main/sidecar";

function protocolRequest(url: string): {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
} {
  return { url, method: "GET", headers: { get: () => null } };
}

describe("translateSourceError", () => {
  it("maps a sidecar RpcFailure to NotFoundError", () => {
    expect(translateSourceError(new RpcFailure("book 7 not found"))).toBeInstanceOf(NotFoundError);
  });

  it("maps ENOENT and EISDIR file errors to NotFoundError", () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory"), {
      code: "EISDIR",
    });
    expect(translateSourceError(enoent)).toBeInstanceOf(NotFoundError);
    expect(translateSourceError(eisdir)).toBeInstanceOf(NotFoundError);
  });

  it("keeps NotFoundError and unexpected errors unchanged", () => {
    const notFound = new NotFoundError("missing member");
    const unexpected = new Error("disk on fire");
    expect(translateSourceError(notFound)).toBe(notFound);
    expect(translateSourceError(unexpected)).toBe(unexpected);
    expect(translateSourceError("garbage")).toBeInstanceOf(Error);
  });
});

describe("makeProtocolSources (the wiring must translate, not pass through)", () => {
  it("answers 404 with a fixed body when the sidecar rejects a book with RpcFailure", async () => {
    const call = vi.fn().mockRejectedValue(new RpcFailure("book 7 not found"));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://book/7?format=epub"),
      sources,
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe("not found");
    expect(body).not.toContain("book 7");
  });

  it("answers 404 for a missing EPUB member RpcFailure", async () => {
    const call = vi.fn().mockRejectedValue(new RpcFailure("no such member"));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://book/7/OEBPS/missing.xhtml"),
      sources,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers 500 for unexpected sidecar failures", async () => {
    const call = vi.fn().mockRejectedValue(new Error("stdio collapsed"));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(protocolRequest("tuxbooks://book/7"), sources);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
  });

  it("answers 404 when a cover read fails with ENOENT", async () => {
    const sources = makeProtocolSources({ call: vi.fn() }, "/tmp/unused-covers", () =>
      Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
    );
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://cover/gone.png"),
      sources,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers 500 when a cover read fails with something else", async () => {
    const sources = makeProtocolSources({ call: vi.fn() }, "/tmp/unused-covers", () =>
      Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })),
    );
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://cover/locked.png"),
      sources,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
  });
});
