# Task 7 report: #85 Electron hardening verification (X-1..X-5)

Worktree: `.worktrees/security-architecture`. Everything below was run there.

## What this task found and changed

The audit found one real X-3 bug and two X-2 gaps. The rest of the work is
verification and pinning.

1. **X-3 bug (fixed):** the `will-navigate` handler in
   `electron/main/index.ts` allowed `file://` navigation through
   (`!url.startsWith("file://")` skipped `preventDefault`). A renderer
   could attempt local navigation; Chromium's renderer-side block caught
   most of it, but the app's own policy permitted it. The handler now
   routes every navigation through `isAllowedAppNavigation`, which
   allows only the app origin's entry point and assets, plus the dev
   server origin while a dev server is actually configured.
2. **X-2 gap (fixed):** no CSP existed for the application UI. The
   `app://bundle` responses now carry a strict CSP header
   (`electron/shared/appCsp.ts`), and the Vite dev server serves the
   development variant of the same policy. The E2E run caught two
   regressions while deploying it, both fixed:
   - The inline theme bootstrap in `frontend/index.html` was blocked by
     the new `script-src`. It moved to
     `frontend/public/themeBootstrap.js`, a static file covered by
     `script-src 'self'` (no hash pin to drift).
   - The reader's `blob:` section frames inherit the app document's CSP,
     so the policy must grant what the frame CSP in `contentPolicy.ts`
     already grants: `blob:` toolkit scripts, ReadiumCSS inline and
     `blob:` styles, and the `tuxbooks://` publication base URI. Without
     these the frames render broken; the renderer console log showed the
     blocked loads and the policy was widened accordingly.
3. **X-4 gap (fixed):** no permission handlers existed, and Electron
   approves every permission request by default. The session now has
   deny-by-default request and check handlers sharing one policy
   function; the single grant is fullscreen from the app's own origin
   (the reader's presentation mode).
4. **X-1/X-5:** the flags were already correct. They are now pinned by a
   startup assertion and a validated `shell.openExternal` seam.

## New modules (all pure, unit-tested in `frontend/tests/security/`)

- `electron/main/windowSecurity.ts`: `RENDERER_ISOLATION` and
  `assertRendererIsolation` (X-1, throws at window creation on a drifted
  flag), `isAllowedAppNavigation` (X-3), `isPermissionAllowed` (X-4), and
  `originOfRequestUrl`.
- `electron/shared/appCsp.ts`: `appUiCsp(variant)` and `APP_UI_CSP` (X-2).
- `electron/shared/linkPolicy.ts`: `parseExternalHttpUrl` (X-5). This is
  the seam Task 8 (untrusted metadata links) should reuse; it returns the
  canonical `href` or null, so raw strings never reach `shell.openExternal`.

`originOfRequestUrl` deserves a note. `new URL("app://bundle/x").origin`
returns the string `"null"` in the JS URL parser for custom schemes, so a
naive origin comparison always denied app-origin requests. The debugging
probe proved it: the permission handler was called with
`permission=fullscreen url=app://bundle/index.html` and issued
`callback(false)`. Electron 44 then leaves the renderer's
`requestFullscreen` promise pending instead of rejecting it, which is why
the first green run hung for 120 seconds. The helper reconstructs the app
origin from the validated host.

## TDD evidence

Unit layer (vitest):

- RED: the three new test files failed on unresolved imports (modules did
  not exist). One test bug was caught by `tsc` during the E2E build
  (`appUiCsp(true)` instead of `appUiCsp("development")`) and by the
  WHATWG parser (`"https:///path"` legitimately parses with host `path`;
  the test now pins that behavior instead of a wrong expectation).
- GREEN: `frontend/tests/security/` 281 tests pass, including the 37 new
  ones. One wiring test ("createWindow passes the literal webPreferences
  through the assertion") failed until `index.ts` was fixed, which was
  its purpose.

E2E layer (real app, security phase). RED against the pre-change app
(run `artifacts/e2e/security-2026-09-16T16-06-03-158Z-1pmdm`):

- X-2 failed: the CSP header on `app://bundle/index.html` was null.
- X-4 failed: `Notification.requestPermission()` returned `"granted"`
  (Electron default approves everything).
- X-1, X-5 passed already (evidence, not RED), and the fullscreen probe
  passed, which gave the baseline for the permission-handler work.
- X-3 failed in a way that drove the test design: a renderer-initiated
  `file://` attempt leaves Chromium's blocked-navigation state, and
  Playwright's locator machinery stalls on it ("waiting for navigation to
  finish"). The final spec polls for the settled end state (the app
  document alive at `app://bundle/index.html`) and resets with a committed
  `page.goto` between attempts so the next spec starts clean.

GREEN (final run): all 9 security-phase tests pass, and the full
`just test-e2e` chain (empty, shell, gpu, security, seeded, 56 seeded
tests) passes, so the readers work completely under the new CSP.

## Per-invariant verification

### X-1 (isolation flags)

- Config: `webPreferences` in `createWindow` spreads `RENDERER_ISOLATION`
  (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`) and passes it through `assertRendererIsolation`
  before `new BrowserWindow`. A flipped or missing flag throws, so the
  startup dies instead of shipping a softer renderer. This satisfies
  "a violation fails the build or startup".
- Dev/E2E: `X-1: the renderer sees no Node.js and only the enumerated
  bridge` (`e2e/specs/app-hardening.e2e.ts`) probes `require`, `process`,
  and `module` (all undefined), the preload bridge (present), and a
  blocked `file:///etc/hostname` fetch.
- Unit: `windowSecurity.test.ts` (assertion semantics, canonical set,
  source wiring).
- Packaged: the assertion call is in the bundled `main.cjs` inside
  `app.asar` (grep hit), and the packaged boot probe run passed.

### X-2 (app UI CSP)

- Config: `content-security-policy: APP_UI_CSP` header on every
  `app://bundle` response; `server.headers` in `frontend/vite.config.ts`
  serves the development variant (unsafe-inline scripts and styles plus
  `ws:` are the documented HMR allowances; default-src stays 'none').
- E2E: `X-2: the app UI ships a strict CSP and enforces it` checks the
  header, an injected inline script (blocked; the CDP-eval probe was
  replaced because DevTools evaluation is CSP-exempt), and an external
  fetch refused with the `connect-src` console violation.
- Unit: `appCsp.test.ts` (directive content, no unsafe-inline/unsafe-eval
  in scripts, frame grants present).
- Packaged: header code and directives are in `app.asar` (grep hits).

### X-3 (navigation restricted, file:// blocked)

- Config: `will-navigate` preventDefaults everything not allowed by
  `isAllowedAppNavigation`; validated http(s) targets go to the system
  browser instead. The old `file://` allowance is gone.
- E2E: `X-3: the renderer cannot navigate the top frame away from the app
  origin` fires renderer-initiated attempts (`tuxbooks://book/1`,
  `file:///etc/passwd`, `data:text/html`) and requires the app document
  to survive at `app://bundle/index.html`.
- Unit: `isAllowedAppNavigation` tests (file, tuxbooks, javascript, data,
  other origins, dev-server gating, malformed input).
- Known limit, documented rather than papered over: Electron does not
  fire `will-navigate` for CDP-driven `Page.navigate` (proved by
  `page.goto('file:///etc/passwd')` committing to an error page). That
  path is main-process tooling (Playwright, DevTools), not reachable from
  publication content or a compromised renderer; every renderer-reachable
  navigation goes through the handler.

### X-4 (permissions denied by default)

- Config: `setPermissionRequestHandler` and `setPermissionCheckHandler`
  on the default session, both feeding `isPermissionAllowed`. Grant list:
  fullscreen, app origin (or dev origin in dev) only.
- E2E: `X-4: permission requests are denied by default` (notifications
  denied, `permissions.query` denied, `getUserMedia` rejected with
  `NotAllowedError`) and `X-4: the reader's own fullscreen request still
  works` (requestFullscreen enters fullscreen after a trusted keydown).
  The second test is the regression guard for the only grant.
- Unit: `isPermissionAllowed` and `originOfRequestUrl` tests.
- Packaged: both handler registrations are in `app.asar` (grep hits).

### X-5 (validated external links)

- Config: both former `shell.openExternal` call sites now call
  `openExternalIfValid`, which passes the input through
  `parseExternalHttpUrl` and forwards only the canonical http(s) `href`.
- E2E: `X-5: unsafe window.open targets spawn no window` (`file:`,
  `javascript:`, `data:`, `tuxbooks://` all return null).
- Unit: `linkPolicy.test.ts` (scheme allowlist, credentials, control
  characters, length cap, non-strings, WHATWG normalization).

## Packaged-build verification

Environment is Linux; packaging is wired here, so the real thing ran:

- `just build` then `pnpm exec electron-builder --linux deb --publish
  never` produced `dist-packages/tuxbooks_0.0.6_amd64.deb` plus
  `dist-packages/linux-unpacked/`. The deb target initially failed with
  "Please specify project homepage"; that metadata gap is fixed in
  `package.json`.
- `just check-deb` passes: version, payload (sidecar + document worker +
  PDFium), desktop entry, icons.
- Boot probe on the unpackaged packaged binary under Xvfb with scratch
  `TEST_*` overrides and `TUXBOOKS_BOOT_PROBE=1`:
  `[boot] renderer mounted` and
  `tuxbooks://book/1 -> fetch-book:404:9 | fetch-cover:400 |
  img-book:error` (typed boundary answers on an empty scratch database).
- `app.asar` carries every hardening seam (grep hits):
  `content-security-policy`, `default-src 'none'`,
  `setPermissionRequestHandler`, `setPermissionCheckHandler`,
  `assertRendererIsolation`, `parseExternalHttpUrl`,
  `isAllowedAppNavigation`, and `themeBootstrap.js`.

**Packaged gap:** the Playwright suites run the unpackaged app over the
same `app://bundle` load path the packaged app uses; they do not drive
the packaged binary. The packaged evidence is the boot-probe smoke plus
the asar contents, backed by identical bundles and one `main.cjs`. Full
E2E against `dist-packages/linux-unpacked/tuxbooks` would need a fixture
option for `executablePath` and is left as follow-up.

## Files changed

- `electron/main/index.ts`: wiring (assertion, nav policy, permission
  handlers, CSP header, link seam); removed the dead `DEV_SERVER_URL`
  default, which would have enabled a localhost allowance in production.
- `electron/main/windowSecurity.ts`, `electron/shared/appCsp.ts`,
  `electron/shared/linkPolicy.ts`: new policy modules.
- `frontend/index.html` + `frontend/public/themeBootstrap.js`: theme
  bootstrap extracted from an inline script.
- `frontend/vite.config.ts`: dev CSP headers.
- `frontend/tests/security/linkPolicy.test.ts`,
  `frontend/tests/security/windowSecurity.test.ts`,
  `frontend/tests/security/appCsp.test.ts`: new unit tests.
- `e2e/specs/app-hardening.e2e.ts`: new; `e2e/playwright.config.ts`:
  added to the security project and the seeded exclude list.
- `package.json`: homepage metadata.
- `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/RELEASE.md`: the
  window-hardening boundary, the security phase contents, and the
  packaged hardening checks.

## Self-review

- The X-2 policy widening (blob: scripts, unsafe-inline styles,
  tuxbooks: base URI) is justified by reader-frame CSP inheritance and
  pinned by tests; the app document itself still has no inline or eval
  script execution, and publication frames remain fenced by their own
  stricter policy (the hostile-EPUB specs still pass).
- The X-3 E2E asserts end state rather than harness internals, after two
  false probes (CDP-exempt eval; Playwright's pending-navigation stall)
  were replaced for cause, with the evidence in the run artifacts.
- The permission policy keeps its one grant under test so the reader's
  presentation mode cannot silently regress.
- No renderer-visible APIs were added; main and preload remain plumbing.

## Concerns

1. CDP-level navigation bypasses `will-navigate` (see X-3). Out of the
   threat model, but worth knowing before anyone treats the fence as
   main-process-wide.
2. Electron 44 leaves a denied fullscreen request pending instead of
   rejecting it. App-origin requests are granted, so the reader is fine;
   other origins get a hung promise, which is Electron's behavior, not
   ours.
3. The production CSP carries `blob:` in script-src and `'unsafe-inline'`
   in style-src because of frame inheritance. A separate origin for
   reader frames would allow tightening both; that is a larger change and
   out of scope here.
4. Full E2E against the packaged binary is the one remaining gap (above).
5. `just dev` was not exercised by hand in this session (no display); the
   dev CSP is unit-pinned and the dev server headers are the same policy
   builder the E2E-verified header uses.
