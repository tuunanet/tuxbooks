# Issue #84 tuxbooks:// and path-bearing IPC (T-1..T-7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `tuxbooks://` protocol and every renderer-facing, path-bearing IPC call enforce the T invariants from the security umbrella: the renderer names books and covers, never paths; every resource URL is parsed, normalized, and validated against its expected root before anything is opened; MIME types come from fixed tables; the preload surface stays enumerated; payloads are bounded; failures are generic and closed.

**Architecture:** Two new main-process modules plus one shared schema module carry all the boundary logic, extracted out of `electron/main/index.ts` so it is unit-testable without Electron:

- `electron/shared/pathSchema.ts` — the validated path/query schema shared by main, preload, and tests: book-id/member/cover-name/range parsers, the absolute-path shape validator, the fixed MIME tables, the sidecar method allowlist, IPC channel names, the privileged-scheme declarations, and the renderer-sender origin policy.
- `electron/main/protocolHandler.ts` — pure `tuxbooks://` request handling: URL routing (scheme/host allowlist), status-code decisions, range slicing, and response headers, against injected byte sources (sidecar calls, cover file reads). No Electron, no fs imports.
- `electron/main/ipcPolicy.ts` — pure `tuxbooks:invoke` policy: sender-origin validation, method allowlist, params-shape validation for path-bearing methods, dialog-issued path tokens, and payload size caps.

`electron/main/index.ts` shrinks to wiring: it registers the schemes from the shared table, delegates `protocol.handle` to the pure handler with real byte sources (sidecar calls, cover reads with realpath containment), and routes `ipcMain.handle` through the policy module. `electron/preload/preload.ts` imports the same schema to validate its arguments before they ever reach main.

**Tech Stack:** TypeScript (Electron main/preload, esbuild CJS bundles), vitest (jsdom env with Node web globals for `Response`), Rust test-only additions in `sidecar/src/rpc.rs`. No new dependencies.

**Spec:** `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-84-spec.md` (invariants T-1..T-7) under the umbrella `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-78-umbrella.md`.

## Global Constraints

- TDD: each invariant's test exists and fails (RED) before the code that passes it (GREEN). Import/compile errors naming the missing API count as RED, matching the task-1 convention.
- The sidecar's IPC/JSON-RPC contract with Electron is not changed (that is Task 4's W territory). The only sidecar edits are `#[cfg(test)]` additions that pin existing rejection behavior.
- Errors crossing the protocol boundary are generic fixed strings (`not found`, `forbidden`, `internal error`); sidecar error messages are never echoed into responses.
- Malicious inputs are built at runtime in tests (strings, temp dirs); no committed hostile fixtures.
- `just check` green before finishing; `just format` after Rust edits; `just test-e2e` green (headless) once at the end; never two concurrent E2E runs.
- Commit messages: Conventional Commits, imperative, no em dashes.
- Housekeeping: `.superpowers/` added to `.prettierignore` as its own small commit.

## Invariant-to-mechanism map

| Invariant | Mechanism | Where enforced |
| --- | --- | --- |
| T-1 renderer never supplies filesystem paths | Cover URLs carry the cover file name, not the stored path; the handler resolves names inside the covers dir itself. Reveal takes a book id; main resolves the path via the sidecar. | `coverFileUrl`, `revealBook`, protocol handler |
| T-2 normalize + validate against expected root, fail closed | Strict parsers for book id (digits only, positive, safe integer), member path (relative, no `..`/backslash/NUL/control, bounded), cover name (flat image file name only), range header (safe integers, `end >= start`, else 416). Host allowlist (`book`, `cover`) after scheme check. Cover reads re-check containment against the realpath of the resolved file. | `pathSchema.ts` parsers, `protocolHandler.ts` |
| T-3 no generic filesystem read primitive | The cover route no longer accepts a path at all (400 on the old path-bearing shape); the only filesystem reads are book-id-derived sidecar calls and name-resolved covers inside one root. | protocol handler |
| T-4 fixed MIME types | `bookSourceMime` (format query, fixed map), `memberMime` (fixed extension table mirroring the sidecar's `guess_member_media_type`; the wire `mediaType` string is ignored), `coverMime` (fixed extension map). | `pathSchema.ts`, handler headers |
| T-5 preload enumerated, no passthrough, JSON-RPC hidden | Preload API keeps explicitly enumerated functions; IPC channel names and the privileged-scheme table move to the shared module; config-verification tests assert the enumeration, the two registered schemes, and that `lib/bridge.ts` is the only `window.tuxbooks` consumer. | `pathSchema.ts`, `preloadSurface.test.ts` |
| T-6 callers/senders validated; unknown methods rejected; malformed input cannot crash; payloads bounded | `ipcMain.handle` checks the sender frame origin (app://bundle or the dev server), the method allowlist, params shape, and a byte cap; `Sidecar.call` rejects oversized requests; the response line buffer has an overflow cap; Rust tests pin unknown-method/-32600/-32602/malformed-JSON handling. | `ipcPolicy.ts`, `sidecar.ts`, `rpc.rs` tests |
| T-7 path-bearing command review | `scan_library`, `import_paths`, `reconnect_book`, `set_book_cover` params are schema-validated (absolute, normalized, bounded); `reconnect_book`/`set_book_cover`/`scan_library` additionally require paths that main itself issued via a dialog; findings beyond that are recorded in the task report. | `ipcPolicy.ts` + report |

---

### Task 1: Shared path/query schema (`electron/shared/pathSchema.ts`)

**Files:**

- Create: `electron/shared/pathSchema.ts`
- Create: `frontend/tests/security/pathSchema.test.ts`
- Create: `frontend/tests/security/attackVectors.ts` (negative-path helper corpus, importable by #87)

**Interfaces produced (consumed by tasks 2-3, then #87):**

```ts
export const MAX_SAFE_I64: number;                 // 2^53-1
export const MAX_MEMBER_PATH_LENGTH = 1024;
export const MAX_LIBRARY_PATH_LENGTH = 4096;
export const MAX_IMPORT_PATHS = 1000;
export const MAX_IPC_PARAM_BYTES = 8 << 20;
export const MAX_SIDECAR_REQUEST_BYTES = 8 << 20;
export const MAX_RESPONSE_LINE_BYTES = 2 << 30;    // >= 1 GiB book x 4/3 base64
export function parseBookId(raw: string): number | null;
export function isValidBookId(value: unknown): value is number;
export function parseMemberPath(decoded: string): string | null;
export function parseCoverName(decoded: string): string | null;
export function isValidLibraryPath(path: string): boolean;
export type RangeParse = { kind: "none" } | { kind: "invalid" } | { kind: "ok"; start?: number; end?: number };
export function parseRangeHeader(header: string | null): RangeParse;
export function decodeUriComponentSafe(raw: string): string | null;
export function bookSourceMime(format: string | null): string;
export function memberMime(member: string): string;
export function coverMime(name: string): string;
export const SIDECAR_METHODS: ReadonlySet<string>;
export const IPC_CHANNELS: { invoke; dialog; reveal; event };
export const PRIVILEGED_SCHEMES: readonly { scheme: string; privileges: {...} }[];
export function isAllowedSenderUrl(raw: string, devServerUrl: string | undefined): boolean;
```

**Steps:**

- [ ] RED: `pathSchema.test.ts` names every export above; run `pnpm --filter frontend exec vitest run tests/security/pathSchema.test.ts` and observe the import failure.
- [ ] GREEN: implement the module minimally; tests pass.
- [ ] `attackVectors.ts`: export traversal member paths (plain, percent-encoded, double-encoded, backslash, absolute, NUL, control chars, oversized), bad book ids, bad ranges, scheme-confusion URLs, and absolute-path cover URLs; typed so #87 can extend the arrays.

### Task 2: Pure protocol handler (`electron/main/protocolHandler.ts`)

**Files:**

- Create: `electron/main/protocolHandler.ts`
- Create: `frontend/tests/security/protocolHandler.test.ts`

**Interfaces produced:**

```ts
export class NotFoundError extends Error {}
export interface BookSources {
  getBookBytes(bookId: number, offset?: number, length?: number): Promise<{ data: string; offset: number; total: number }>;
  getBookResource(bookId: number, member: string, offset?: number, length?: number): Promise<{ data: string; offset: number; total: number; mediaType: string }>;
  readCover(name: string): Promise<Uint8Array>;
}
export function handleProtocolRequest(
  request: { url: string; method: string; headers: { get(name: string): string | null } },
  sources: BookSources,
): Promise<Response>;
```

Behavior: scheme/host allowlist (only `tuxbooks://book`, `tuxbooks://cover`; anything else 404); decode failures 400; book bytes (200/206/416) and resources (200/206/416) through the shared parsers with `NotFoundError` mapping to 404 and any other rejection to 500, bodies always fixed strings; resource `content-type` from `memberMime(member)` (wire mediaType ignored); cover route 400s on any path-shaped or traversal name and serves only `parseCoverName`-valid names through `readCover` (404 on failure, fixed body).

**Steps:**

- [ ] RED: `protocolHandler.test.ts` covering the full negative matrix (host allowlist, decode errors, ids, members, covers, ranges, error mapping, MIME pinning) plus happy paths; observe import failure.
- [ ] GREEN: implement; tests pass.
- [ ] Wire in `electron/main/index.ts`: delete the in-file `parseRange`/MIME maps/`SIDECAR_METHODS` (now imported), replace `registerProtocol` body with a `handleProtocolRequest` delegation whose `readCover` does resolve + startsWith + realpath containment, and whose sidecar calls map `RpcFailure` to `NotFoundError`.

### Task 3: IPC policy (`electron/main/ipcPolicy.ts`)

**Files:**

- Create: `electron/main/ipcPolicy.ts`
- Create: `frontend/tests/security/ipcPolicy.test.ts`

**Interfaces produced:**

```ts
export type IssuedKind = "directory" | "book-file" | "book-files" | "cover-image";
export class IssuedPaths { issue(kind: IssuedKind, path: string): void; has(kind: IssuedKind, path: string): boolean; }
export function validateInvokeParams(method: string, params: unknown, issued: IssuedPaths): void; // throws SidecarError-shaped Error
```

`validateInvokeParams` enforces: method in `SIDECAR_METHODS`; params a plain object; JSON size <= `MAX_IPC_PARAM_BYTES`; for `scan_library`/`reconnect_book`/`set_book_cover`, an absolute, normalized, bounded path that `issued.has(...)` recorded from a dialog; for `import_paths`, an array of <= `MAX_IMPORT_PATHS` valid absolute paths (no token requirement: drag-drop paths are legitimate); book ids positive safe integers.

**Steps:**

- [ ] RED: `ipcPolicy.test.ts` (allowlist, shape, size, per-method schema, token requirement, drag-drop exemption); observe import failure.
- [ ] GREEN: implement; tests pass.
- [ ] Wire in `index.ts`: `registerIpc` issues dialog results into `IssuedPaths`, routes `tuxbooks:invoke` through `validateInvokeParams`, and changes `tuxbooks:reveal` to take a book id (resolve via `sidecar.call("list_books")`).

### Task 4: Preload + renderer call sites

**Files:**

- Modify: `electron/preload/preload.ts` (`revealBook(bookId)` replaces `revealInFileManager(path)`; `fetchBookBytes` validates id/format through the shared schema)
- Modify: `frontend/src/lib/bridge.ts` (`revealBook`, `coverFileUrl` basename-only, `TuxbooksApi` type)
- Modify: `frontend/src/components/library/LibraryView.tsx` (`handleReveal` calls `revealBook(bookId)`)
- Modify: `frontend/tests/mocks/bridge.ts`, affected frontend tests
- Create: `frontend/tests/security/preloadSurface.test.ts` (T-5 config verification: privileged schemes exactly tuxbooks+app; channel names from the shared table; no `ipcRenderer` passthrough in preload source; `lib/bridge.ts` the only `window.tuxbooks` consumer)

**Steps:**

- [ ] RED: preload-surface audit test + updated mock expectations fail.
- [ ] GREEN: implement; full frontend suite passes.

### Task 5: Payload bounds + Rust rejection pins

**Files:**

- Modify: `electron/main/sidecar.ts` (request byte cap in `call()`; response-line overflow guard in `onData()`)
- Modify: `sidecar/src/rpc.rs` (test-only: malformed JSON line, missing method, unknown method, malformed params)

**Steps:**

- [ ] RED: extend `ipcPolicy.test.ts`/new sidecar tests for the caps; Rust `cargo test --manifest-path sidecar/Cargo.toml rpc::` for the new pins (compile error first where the harness is new).
- [ ] GREEN: implement caps; `just test-rust` green.

### Task 6: Verification

- [ ] `just format` (Rust touched), `just check` green.
- [ ] `just test-e2e` green (headless, single run).
- [ ] `docs/ARCHITECTURE.md`: IPC section records the path schema, cover-name URLs, id-based reveal, sender validation, and payload caps.
- [ ] Task report with per-invariant RED/GREEN evidence and T-7 review findings.
