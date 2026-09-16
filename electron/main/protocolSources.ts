import fsp from "node:fs/promises";
import path from "node:path";

import { NotFoundError, type BookSources } from "./protocolHandler";
import { RpcFailure, type Sidecar } from "./sidecar";

/**
 * The sidecar-backed byte sources the `tuxbooks://` handler serves from
 * (issue #84 T-1..T-4). This adapter is where sidecar and cover-file
 * rejections are translated into the handler's protocol errors: a sidecar
 * `RpcFailure` (unknown book, member, not an EPUB) and a missing cover file
 * (ENOENT/EISDIR) mean "not found" (404); anything else stays unexpected
 * (500). The handler answers both with fixed bodies that leak no detail.
 */

function isMissingEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EISDIR";
}

/** Map one source rejection to the protocol error the handler understands. */
export function translateSourceError(error: unknown): Error {
  if (error instanceof NotFoundError) return error;
  if (error instanceof RpcFailure || isMissingEntry(error)) {
    return new NotFoundError("not found");
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Read one artwork-cache cover file by its flat name. Containment is
 * checked twice: lexically against the cache root, then against the
 * realpath of both root and file, so a symlink planted in the cache cannot
 * point the read elsewhere (issue #84 T-2).
 */
export async function readCoverFile(root: string, name: string): Promise<Uint8Array> {
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("outside covers root");
  }
  const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(resolved)]);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
    throw new Error("outside covers root");
  }
  return fsp.readFile(realFile);
}

/** Build the protocol's byte sources: sidecar calls plus contained covers. */
export function makeProtocolSources(
  sidecar: Pick<Sidecar, "call">,
  coversRoot: string,
  readCover: (name: string) => Promise<Uint8Array> = (name) => readCoverFile(coversRoot, name),
): BookSources {
  const translated = async <T>(call: Promise<T>): Promise<T> => {
    try {
      return await call;
    } catch (error) {
      throw translateSourceError(error);
    }
  };
  return {
    getBookBytes: (bookId, offset, length) =>
      translated(
        sidecar.call("get_book_bytes", { bookId, offset, length }) as Promise<{
          data: string;
          offset: number;
          total: number;
        }>,
      ),
    getBookResource: (bookId, member, offset, length) =>
      translated(
        sidecar.call("get_book_resource", {
          bookId,
          path: member,
          offset,
          length,
        }) as Promise<{ data: string; offset: number; total: number; mediaType: string }>,
      ),
    readCover: (name) => translated(readCover(name)),
  };
}
