import { describe, expect, it, vi } from "vitest";

import {
  NotFoundError,
  SourceStatusError,
  handleProtocolRequest,
} from "../../../electron/main/protocolHandler";
import { makeProtocolSources, translateSourceError } from "../../../electron/main/protocolSources";
import { RpcFailure } from "../../../electron/main/sidecar";

/**
 * The sidecar's typed JSON-RPC ledger (sidecar/src/rpc.rs): app errors are
 * -32000 (a genuine miss among them), and worker-sourced failures are
 * -32001 deadline, -32002 limit, -32003 sandbox, -32004 crash.
 */
const RPC_MISS = -32000;
const RPC_DEADLINE = -32001;
const RPC_LIMIT = -32002;
const RPC_SANDBOX = -32003;
const RPC_CRASH = -32004;

function protocolRequest(url: string): {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
} {
  return { url, method: "GET", headers: { get: () => null } };
}

describe("translateSourceError", () => {
  it("maps a sidecar miss (-32000) to NotFoundError", () => {
    expect(translateSourceError(new RpcFailure("not found", RPC_MISS))).toBeInstanceOf(
      NotFoundError,
    );
  });

  it("maps ENOENT and EISDIR file errors to NotFoundError", () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory"), {
      code: "EISDIR",
    });
    expect(translateSourceError(enoent)).toBeInstanceOf(NotFoundError);
    expect(translateSourceError(eisdir)).toBeInstanceOf(NotFoundError);
  });

  it("maps the typed worker codes to their non-404 statuses", () => {
    const deadline = translateSourceError(new RpcFailure("deadline exceeded", RPC_DEADLINE));
    const limit = translateSourceError(new RpcFailure("declared 9 MiB", RPC_LIMIT));
    const sandbox = translateSourceError(new RpcFailure("sandbox refused", RPC_SANDBOX));
    expect(deadline).toBeInstanceOf(SourceStatusError);
    expect((deadline as SourceStatusError).status).toBe(504);
    expect(limit).toBeInstanceOf(SourceStatusError);
    expect((limit as SourceStatusError).status).toBe(413);
    expect(sandbox).toBeInstanceOf(SourceStatusError);
    expect((sandbox as SourceStatusError).status).toBe(503);
  });

  it("keeps a codeless RpcFailure (hung sidecar, worker crash) off the 404 path", () => {
    const timeout = new RpcFailure("sidecar call timed out: get_book_bytes");
    expect(translateSourceError(timeout)).toBe(timeout);
    const crash = new RpcFailure("worker crashed", RPC_CRASH);
    expect(translateSourceError(crash)).toBe(crash);
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
  it("answers 404 with a fixed body when the sidecar reports a miss", async () => {
    const call = vi.fn().mockRejectedValue(new RpcFailure("not found", RPC_MISS));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://book/7?format=epub"),
      sources,
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe("not found");
  });

  it("answers 404 for a missing EPUB member", async () => {
    const call = vi.fn().mockRejectedValue(new RpcFailure("not found", RPC_MISS));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://book/7/OEBPS/missing.xhtml"),
      sources,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers 413, never 404, when a member request trips the resource limit", async () => {
    const call = vi
      .fn()
      .mockRejectedValue(
        new RpcFailure("declared total exceeds max_total_uncompressed_bytes", RPC_LIMIT),
      );
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://book/7/OEBPS/chapter1.xhtml"),
      sources,
    );
    expect(response.status).toBe(413);
    expect(await response.text()).not.toBe("not found");
  });

  it("answers 504 when the sidecar reports an exceeded deadline", async () => {
    const call = vi.fn().mockRejectedValue(new RpcFailure("parse deadline exceeded", RPC_DEADLINE));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://book/7/OEBPS/chapter1.xhtml"),
      sources,
    );
    expect(response.status).toBe(504);
    expect(await response.text()).not.toBe("not found");
  });

  it("answers 503 when the sandbox refuses the request", async () => {
    const call = vi.fn().mockRejectedValue(new RpcFailure("sandbox refused", RPC_SANDBOX));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(protocolRequest("tuxbooks://book/7"), sources);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toBe("not found");
  });

  it("answers 500, never 404, when the sidecar hangs past the client timeout", async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new RpcFailure("sidecar call timed out: get_book_bytes"));
    const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
    const response = await handleProtocolRequest(
      protocolRequest("tuxbooks://book/7/OEBPS/chapter1.xhtml"),
      sources,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
  });

  it("answers 500 for a worker crash and unexpected sidecar failures", async () => {
    for (const failure of [
      new RpcFailure("worker crashed", RPC_CRASH),
      new Error("stdio collapsed"),
    ]) {
      const call = vi.fn().mockRejectedValue(failure);
      const sources = makeProtocolSources({ call }, "/tmp/unused-covers");
      const response = await handleProtocolRequest(protocolRequest("tuxbooks://book/7"), sources);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("internal error");
    }
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
