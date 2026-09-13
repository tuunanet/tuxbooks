# Global Light/Dark Theme — Handover Plan

Status: implemented on `feat/global-light-dark-mode` (unit + E2E green;
manual visual QA items in tasks 3/7 remain for a human pass).
Goal: app-wide light/dark theming with a **System / Light / Dark** choice in
Settings → General. Default is System (follows the OS, live-updates when the
OS flips). Reader-internal themes (EPUB/PDF) stay independent.

## Current state (verified)

- Tailwind v4, CSS-first config. `frontend/src/index.css` already defines the
  full light token palette on `:root` and a complete `.dark` override set, and
  `@custom-variant dark (&:is(.dark *))` makes dark mode **class-based**
  (`.dark` on `<html>`). No token work needed — the palette exists; nothing
  toggles the class today, so the app is permanently light.
- No theme handling anywhere: no `nativeTheme` in `electron/main/`, no
  `localStorage` usage in the frontend, no settings persistence at all.
  `frontend/src/components/settings/SettingsShell.tsx` is deliberately
  presentational-only (rows describe behavior; its docstring forbids controls
  that "pretend to persist").
- Reader themes are separate and session-scoped: `ReaderTheme` (= `EpubThemeName`,
  default/light/paper/dark/contrast/…) in `frontend/src/state/readerState.ts`,
  applied to the reader surface only, via `ReaderProvider`. PDF has its own
  theme module (`frontend/src/lib/pdf/theme.ts`). Global app theme must not
  touch these.
- `electron/main/index.ts:472` hardcodes `backgroundColor: "#0b0b0f"` (dark)
  on the BrowserWindow — mismatched with the current light UI at startup.
- Providers mount in `frontend/src/components/layout/AppShell.tsx`
  (`AppStateProvider → ShortcutProvider → LibraryDataProvider → ImportProvider`);
  `frontend/src/App.tsx` renders `<AppShell />`; entry is
  `frontend/src/main.tsx` + `frontend/index.html` (bare module script, no head
  bootstrap).

## Design decisions

1. **Class strategy stays JS-driven.** Keep `@custom-variant dark` as-is; a
   `ThemeProvider` adds/removes `.dark` on `document.documentElement` and sets
   `color-scheme: light | dark` (correct native scrollbars, form controls,
   dialogs). One source of truth; no hybrid media-query variant.
2. **Preference = `"system" | "light" | "dark"`, resolved theme =
   `"light" | "dark"`.** `system` resolves via
   `window.matchMedia("(prefers-color-scheme: dark)")` and the provider
   subscribes to `change` events so a live OS flip updates the app
   immediately.
3. **Persistence: `localStorage`** (key `tuxbooks.theme`), the honest
   frontend-only mechanism — survives restarts, works offline, no pretend
   backend. This becomes the first persisted setting; the SettingsShell
   docstring and the General section copy must be updated accordingly.
   A future sidecar `settings` table (Rust mirror) is a separate enhancement,
   out of scope here.
4. **No FOUC:** inline bootstrap script in `frontend/index.html` `<head>`
   reads localStorage, applies the class before the bundle loads. Must be a
   tiny plain script (no CSP issue; Vite inlines HTML as-is). System default
   needs no stored value — absence of `.dark` + `color-scheme` is not enough,
   so the script resolves the media query itself when no stored preference.
5. **New module boundary:** pure logic in `frontend/src/lib/theme.ts`
   (parse/serialize, resolve, DOM apply, media-query helpers — all unit-
   testable without React), React wiring in
   `frontend/src/state/ThemeStateProvider.tsx` following the existing
   provider naming (`state/` = app shell state + providers per
   `docs/ARCHITECTURE.md`).
6. **Settings UI:** three-option segmented control (shadcn `ToggleGroup`,
   single-select, already used by ReaderAppearance) — System / Light / Dark —
   as the first real interactive row in Settings → General. User explicitly
   wants the choice here (not only a header toggle). No quick-toggle in the
   header for now (optional follow-up below).
7. **Reader boundary untouched:** the reader chrome (toolbars) follows the
   global theme; the reading surface keeps its own `ReaderTheme`. Verify both
   global modes against reader "default"/paper themes visually (QA task).

## Tasks

Order matters only for 1→2→4; the rest are parallelizable.

### 1. Theme core module — `frontend/src/lib/theme.ts`

- [x] `AppThemePreference` / `ResolvedTheme` types; `THEME_STORAGE_KEY`.
- [x] `parseStoredTheme(raw: string | null): AppThemePreference` (invalid /
      missing → `"system"`).
- [x] `resolveTheme(pref, systemDark: boolean): ResolvedTheme`.
- [x] `applyTheme(theme: ResolvedTheme, doc: Document)` — toggle `.dark` on
      `documentElement` + set `style.colorScheme`.
- [x] `systemPrefersDark(win: Window): boolean` + a `subscribe` helper around
      `matchMedia(...).addEventListener("change", ...)`.
- [x] Unit tests `frontend/tests/theme.test.ts` (pure DOM/matchMedia fakes,
      no React).

### 2. Provider — `frontend/src/state/ThemeStateProvider.tsx`

- [x] Context `{ preference, resolvedTheme, setPreference }`; mounts once in
      `App.tsx` above `AppShell` (must wrap the reader view too). Context +
      `useThemeState` hook live in `state/themeState.ts`, matching the
      `appState.ts` / `AppStateProvider.tsx` split.
- [x] Init: parse localStorage; apply on mount; re-apply on `preference` or
      system `change` (subscribe only while `preference === "system"`).
- [x] `setPreference` writes localStorage + state; guard
      `window.matchMedia` absence (happy-dom) with the module fallbacks.
- [x] Test `frontend/tests/ThemeStateProvider.test.tsx`: defaults to system,
      follows OS flip live, persists explicit choice, restores after
      "remount". Note: vitest's jsdom global resolves `window.localStorage`
      to `undefined`; `tests/setup.ts` installs a working storage shim
      (same pattern as its matchMedia shim).

### 3. FOUC bootstrap — `frontend/index.html`

- [x] Inline `<script>` in `<head>`: read key, resolve, set class +
      `colorScheme` before `main.tsx` runs (~10 lines, mirrored logic).
- [ ] Manually verify: launch `just dev` with OS in dark → no light flash.

### 4. Settings UI — General section

- [x] Add labeled "App theme" row with a single-select `ToggleGroup`
      (System / Light / Dark) wired to `setPreference`; show current resolved
      source as the hint (e.g. "Following system (dark)").
- [x] Rework `SECTION_ROWS.general` from static strings to a component row;
      update the `SettingsShell` docstring (first real persisted control).
- [x] Update `frontend/tests/SettingsShell.test.tsx`; add interaction test
      (click Dark → `.dark` on `documentElement`, reload-safe via storage).

### 5. Electron polish (small, recommended)

- [x] Initial `backgroundColor` mismatch: set to the light token
      `oklch(1 0 0)` ≈ `#ffffff` to match default System-on-light (the
      bootstrap script paints the real choice before first content paint).
- [ ] Optional: IPC `theme:changed` → `nativeTheme.themeSource` so the window
      frame/titlebar and any `prefers-color-scheme` consumers inside reader
      webviews follow the override. Only worth it if reader engines are shown
      to consult the media query; check before building.

### 6. Coverage + docs

- [x] `just check` green; `just coverage` — new categories must meet floors
      (`docs/COVERAGE.md`; frontend thresholds enforced on every vitest run).
      Theme code lands in existing categories (`src/lib/`, `src/state/`,
      `src/components/settings/`); no new gate rows needed; frontend
      coverage run verified green.
- [x] Update `docs/ARCHITECTURE.md` state/provider list if it enumerates
      providers (ThemeStateProvider joins it); mention the localStorage key.
- [x] Update Settings → General row hints that currently say "saving
      preferences needs backend support" (theme no longer fits that copy) —
      the Reading → Font size hint now scopes the claim to reader
      preferences.

### 7. QA pass

- [x] Full-app E2E suite green on the real binary (`just test-e2e`, 53/53):
      app boots and library/reader/settings flows work with the provider
      mounted and the bootstrap script in place.
- [ ] All four combos: pref × OS theme, incl. live OS flip while running.
- [ ] Reader: EPUB + PDF surfaces under global light/dark (their own themes
      must win; check `paper`/`default` readability).
- [ ] Dialogs, context menus, global search overlay, drop overlay in dark.
- [ ] Restart app → preference survives; clear localStorage → system default.

## Out of scope / follow-ups

- Quick theme toggle button in the sidebar/header (nice-to-have; the settings
  control is the agreed home).
- Sidecar-persisted settings table mirroring theme (first real backend
  settings work; would also carry reader preferences later). Reader
  appearance now persists device-local in `localStorage`
  (`tuxbooks.reader`, `lib/readerSettings.ts`) via the Settings Reading/PDF
  sections; a sidecar table remains the path to unifying all settings.
- ~~Making reader "default" theme track the global resolved theme~~ — done
  during UAT: the reader surface now auto-follows the global theme
  (`autoReaderTheme` + `ReaderProvider globalTheme`), light → publisher
  default, dark → `dark` preset / PDF invert; an appearance-menu pick (any,
  including "Default") pins the surface for the session.
- Extra accent themes beyond light/dark (token palettes would be added to
  `index.css` the same way `.dark` is).

## Verification commands

```sh
pnpm install
just check                 # format+lint+typecheck+unit tests
pnpm --filter frontend exec vitest run tests/theme.test.ts tests/ThemeStateProvider.test.tsx tests/SettingsShell.test.tsx
just dev                   # manual FOUC + flip verification
```
