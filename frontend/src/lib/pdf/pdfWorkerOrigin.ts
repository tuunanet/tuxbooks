/**
 * Whether a worker message's serialized `origin` comes from the worker's own
 * document.
 *
 * The bundle is served from `app://bundle` (production) or the Vite origin
 * (development). For the custom `app://` scheme Chromium serializes the
 * sending document's origin as an empty string rather than `app://bundle`,
 * so an exact comparison drops every message. A dedicated worker is only
 * reachable by its creating document, so the check is defence in depth:
 * accept the empty same-origin form, and require any non-empty origin to
 * match the worker's own exactly.
 */
export function isTrustedWorkerOrigin(senderOrigin: string, workerOrigin: string): boolean {
  return senderOrigin === "" || senderOrigin === workerOrigin;
}
