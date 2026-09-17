# Issue #82 EPUB active content and network fencing (E-1..E-5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EPUB content cannot execute scripts, fetch the network, reach local files, see real filesystem paths, or traverse out of the publication root. Scripted EPUBs are not a supported feature: a book that ships scripts or script media types fails to open, and every document that does open is sanitized, CSP-fenced, and served only through validated member paths.

**Architecture:** Each invariant is enforced where it is actually effective, in two layers:

- **Sidecar pre-serve (Rust, `sidecar/src/epub/`)** — before a book can open at all: reject script media types in the manifest, reject spine documents containing `<script>` elements (detected in the existing positions pass), reject spine hrefs that name remote or opaque-scheme targets, drop TOC entries whose hrefs use dangerous schemes, and reject hostile renderer-supplied member paths with a typed error instead of relying on a lookup miss.
- **Engine seam (TS, `frontend/src/lib/epub/`)** — for every document the navigator actually renders: a policy fetch client wrapped around the publication's `HttpFetcher` sanitizes HTML/XHTML/SVG text in flight (strips scripts, inline handlers, `javascript:` URLs, `object`/`embed`/`iframe`) and injects a strict frame CSP `<meta>` as the first head child. The toolkit's own frame CSP (`script-src 'unsafe-inline'`, publication-base script files, `object-src`, `child-src` allowed) intersects with ours, so the stricter of the two governs. A post-mount DOM belt re-sweeps each loaded frame, and locator/TOC href classification keeps publication content from navigating anywhere but in-book targets.

All policy logic lives in one pure module (`frontend/src/lib/epub/contentPolicy.ts`) with a `sanitize()`/`validate()` seam: the CSP string, URL guards, href classification, and both DOM and text sanitizers are unit-testable in vitest; the engine seam only wires them. `readiumEngine.ts` stays the only Readium import site; its public handle API is unchanged.

**Tech Stack:** TypeScript (vitest, jsdom + Node web globals), Rust (`quick-xml`, `zip`, `crate::limits`). No new dependencies.

**Spec:** `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-82-spec.md` (invariants E-1..E-5) under the umbrella `.superpowers/sdd/2026-09-16-security-architecture-sequencing/issue-78-umbrella.md`.

## Global Constraints

- TDD: each invariant's test exists and fails (RED) before the code that passes it (GREEN). Import/compile errors naming the missing API count as RED (task-1 convention). Behavior pins that already hold (E-4's no-path-leak property is architecture today) are labeled pins in the evidence trail, not fake REDs.
- No sidecar JSON-RPC contract change and no `tuxbooks://` protocol surface change. New `EpubError` variants surface only as new failure messages for books that must fail to open (content fencing strictly requires them); renderer-facing protocol behavior (status codes, headers, fixed bodies) is untouched.
- Hostile fixtures are generated at runtime in tests (strings, `write_zip` temp files); no committed hostile fixtures; nothing hostile in production paths.
- Reuse `sidecar/src/limits.rs` for any size/count caps; reuse `frontend/tests/security/attackVectors.ts` by extending it, not duplicating.
- `just check` green before finishing; `just format` after Rust/markdown edits; `just test-e2e` once at the end (the engine seam's real behavior is E2E-covered by contract); never two concurrent E2E runs.
- Commit messages: Conventional Commits, imperative, no em dashes.

## Invariant-to-mechanism map

| Invariant                           | Sidecar (pre-serve, Rust)                                                                                                                                                                                                                 | Engine seam (renderer, TS)                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-1 no script execution             | `build_session` rejects manifest items with script media types (`text/javascript`, `application/javascript`, ecmascript, `application/wasm`); the positions pass rejects spine XHTML containing `<script>` elements                       | fetch-wrapper sanitizer strips `<script>`, `on*` handlers, `javascript:` URLs (incl. `xlink:href`), scripted SVG paths; frame meta CSP `script-src blob:` blocks inline scripts, inline handlers, `javascript:` navigation, and script files from the publication base or the network; frame-load DOM belt                                                                 |
| E-2 object/embed/iframe neutralized | (active elements live in content, not the manifest)                                                                                                                                                                                       | fetch-wrapper sanitizer removes `object`, `embed`, `iframe`, `frame`, `frameset` (and their `param` payloads); frame meta CSP `object-src 'none'`, `frame-src 'none'`, `child-src 'none'`; frame-load DOM belt                                                                                                                                                             |
| E-3 no arbitrary network            | spine hrefs with explicit remote/opaque schemes rejected (`ExternalRef`); TOC entries with `javascript:`/`data:`/`vbscript:`/`file:` hrefs dropped (http(s) TOC links stay, they are intercepted as external links)                       | fetch wrapper rejects any request URL outside the session base (`tuxbooks://book/<id>/`) before network access; frame CSP `connect-src 'none'`, `default-src 'none'`, `img/font/media/style-src` limited to `tuxbooks: blob: data:`; href classification (`classifyPublicationHref`) routes absolute non-publication targets to the external-link report, never navigation |
| E-4 no real filesystem paths        | pinned: the session manifest and positions list carry only book-id-relative encoded hrefs; a test greps them for the book's absolute path                                                                                                 | `publicationBaseUrl(bookId)` is the only URL the engine forms: `tuxbooks://book/<id>/`, positive integer id, no paths (pinned by test)                                                                                                                                                                                                                                     |
| E-5 member paths validated          | `read_member` validates renderer-supplied member paths (traversal segments, absolute, backslash, NUL, control chars, Windows drive) with a typed `InvalidMemberPath` error before normalize+lookup; container rootfile path is normalized | protocol layer (Task 2 `parseMemberPath`) already rejects at 400; `contentPolicy` re-exports no member-path logic — the cross-layer test drives the Task-2 parser over the shared `TRAVERSAL_MEMBER_PATHS` corpus                                                                                                                                                          |

## Frame CSP (single source: `contentPolicy.ts`)

```text
default-src 'none'; script-src blob:; style-src tuxbooks: blob: data: 'unsafe-inline';
img-src tuxbooks: blob: data:; font-src tuxbooks: blob: data:; media-src tuxbooks: blob: data:;
connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src blob:;
form-action 'none'; base-uri tuxbooks:
```

`script-src blob:` (no `'unsafe-inline'`) blocks inline scripts, inline event handlers, and `javascript:` URLs while still running the toolkit's own injected scripts, which are always `blob:`-URL `<script src>` elements created by its Injector. Multiple CSP policies intersect, so this meta tightens the toolkit's permissive one without touching toolkit functionality. Style allows `'unsafe-inline'` because ReadiumCSS appearance injection is inline styling. The toolkit's `connect-src 'none'` is matched, not loosened.

---

### Task 1: Detail plan (this document)

- [x] Write `docs/superpowers/plans/2026-09-16-issue-82-epub-content.md`; commit with the first code task.

### Task 2: Policy module, E-1 and E-2 (`frontend/src/lib/epub/contentPolicy.ts`)

**Files:**

- Create: `frontend/src/lib/epub/contentPolicy.ts`
- Create: `frontend/tests/security/contentPolicy.test.ts`
- Modify: `frontend/tests/security/attackVectors.ts` (extend with EPUB content vectors)

**Interfaces produced (consumed by Task 4 wiring and by #87):**

```ts
export const PUBLICATION_FRAME_CSP: string;
export function isSanitizableContentType(contentType: string | null): boolean;
export function sanitizePublicationText(text: string, isXml: boolean): string;
export function insertFrameCspMeta(html: string, isXml: boolean): string;
export function sanitizeFrameDocument(doc: Document): void;
export function declaredEncoding(text: string): string | null;
```

`sanitizePublicationText` parses with `DOMParser` (`application/xhtml+xml` vs `text/html`), removes content-authored active content (`script`, `object`, `embed`, `iframe`, `frame`, `frameset`, `param`, `on*` attributes, `javascript:`/`data:` `href`/`src`/`xlink:href`, external-`href` SVG `use`), and returns the serialized result. `insertFrameCspMeta` injects the CSP `<meta>` as the first `<head>` child. Both are string→string so tests run in jsdom without the toolkit.

**Steps (TDD):**

- [ ] RED: `contentPolicy.test.ts` imports the module and pins E-1 (script element inline/src, `on*` handlers, `javascript:` anchors, scripted SVG) and E-2 (object/embed/iframe/frame/frameset/param removal) using the extended `attackVectors` corpus; observe the import failure.
- [ ] GREEN E-1: implement the module with script-class removal only; E-1 tests pass, E-2 cases still RED.
- [ ] GREEN E-2: extend removal to the active-element list; all pass. Clean documents round-trip byte-identically (sanitizers do not re-serialize untouched docs).

### Task 3: Policy module, E-3 and E-4

**Steps (TDD):**

- [ ] RED E-3: tests for `classifyPublicationHref` (http/https/mailto/tel → `"external"`; `file:`/`javascript:`/`data:`/`blob:`/`about:`/`view-source:`/`app:`/`tuxbooks:`/protocol-relative → `"blocked"`; relative → `"in-book"`) and for the fetch client wrapper `policyFetchClient(base, fetchImpl)`: URL outside the session base rejects without calling fetch; sanitizable content types come back sanitized + CSP meta; other content types pass through byte-identically. Observe failures (missing exports).
- [ ] GREEN E-3: implement both.
- [ ] RED E-4: tests for `publicationBaseUrl(bookId)` (`tuxbooks://book/<id>/`, rejects 0/negative/float/non-int) and `isPublicationResourceUrl` (same base only; other book ids, http(s), `file:` all false). Observe failures.
- [ ] GREEN E-4: implement both.

### Task 4: Engine seam wiring (`frontend/src/lib/epub/readiumEngine.ts`)

**Files:**

- Modify: `frontend/src/lib/epub/readiumEngine.ts`

**Wiring (thin glue; the seam is coverage-excluded and E2E-covered by contract):**

- Session base comes from `publicationBaseUrl(bookId)`; the fetcher becomes `new HttpFetcher(policyFetchClient(sessionBaseUrl), sessionBaseUrl)` so every manifest/position/frame-resource read is policy-guarded.
- `handleFrameLoaded` runs `sanitizeFrameDocument(doc)` (skips the toolkit's own `[data-readium]` nodes) before dispatching load handlers.
- `handleLocator` and `goTo` string targets classify through `classifyPublicationHref`: `"external"` reported (existing behavior), `"blocked"` reported and never navigated, `"in-book"` handled by the engine as before.

**Steps:**

- [ ] Apply wiring; `just check` streams stay green (existing reader unit tests mock the seam, so no mock updates are expected).

### Task 5: Sidecar fencing, E-1 and E-3 (Rust)

**Files:**

- Modify: `sidecar/src/epub/mod.rs` (`EpubError::ScriptedContent`, `EpubError::ExternalRef` variants)
- Modify: `sidecar/src/epub/session.rs`
- Modify: `sidecar/src/epub/parser.rs` (normalize the container rootfile path)

**Steps (TDD):**

- [ ] RED E-1: `session.rs` tests — a manifest item with `media-type="text/javascript"` (and each script media type) fails `build_session` with `ScriptedContent`; a spine XHTML containing `<script>` fails with `ScriptedContent`; the clean session book still opens. Observe failures.
- [ ] GREEN E-1: implement the media-type gate (const list) and the script-element detection in the existing `extract_visible_text` pass (return `Result`, reject on `<script>` starts).
- [ ] RED E-3: tests — a spine item whose OPF href is `https://…` fails with `ExternalRef`; a `javascript:` spine href fails; a nav document with a `javascript:` TOC href opens but drops that TOC entry; an http(s) TOC href is kept. Observe failures.
- [ ] GREEN E-3: implement scheme detection for spine hrefs and TOC-entry filtering.
- [ ] `just format` after Rust edits; cargo tests green.

### Task 6: Sidecar fencing, E-5 (Rust) and E-4 pins

**Files:**

- Modify: `sidecar/src/epub/mod.rs` (`EpubError::InvalidMemberPath`)
- Modify: `sidecar/src/epub/session.rs` (`read_member` validation)

**Steps (TDD):**

- [ ] RED E-5: tests — `read_member` rejects `../x`, `..\\x`, `%2e%2e/x`-decoded shapes, `/abs`, `C:/x`, `a\0b`, control-char paths with `InvalidMemberPath` (today they silently miss → the mismatch is the RED); ordinary member reads still work; the internal miss-based test (`reads_members_by_decoded_path`) is updated to the typed rejection.
- [ ] GREEN E-5: implement `validate_member_path` (reject `..` segments pre-normalization, absolute, backslash, NUL, `is_control`, drive prefixes) and wire into `read_member`.
- [ ] E-4 pin (expected green immediately, recorded as a pin): a built session's manifest and positions JSON contain no substring of the book's absolute filesystem path.
- [ ] `just format`; cargo tests green.

### Task 7: Verification and documentation

- [ ] `just format` (Rust + markdown touched), `just check` green.
- [ ] `just test-e2e` green (single run) — proves the policy fetch client, frame sanitization, and locator classification do not regress the real reader (chapter navigation, search, highlights, restore).
- [ ] `docs/EPUB.md`: rewrite the Security section to describe the actual enforcement (sidecar pre-serve gates, policy fetch client, CSP intersection, DOM belt, href classification) and name E-1..E-5.
- [ ] Task report with per-invariant RED/GREEN evidence, files changed, and residual risks.
