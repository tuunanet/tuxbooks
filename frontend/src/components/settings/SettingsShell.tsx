import { useCallback, useState, useSyncExternalStore } from "react";
import {
  BookOpen,
  Database,
  ExternalLink,
  FolderOpen,
  Info,
  Keyboard,
  Palette,
  RefreshCw,
  RotateCcw,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { AboutSection } from "@/components/settings/AboutSection";
import { ReaderAppearanceControls } from "@/components/reader/ReaderAppearance";
import { DataSettings } from "@/components/settings/DataSettings";
import { FoldersSettings } from "@/components/settings/FoldersSettings";
import { SyncSettings } from "@/components/settings/SyncSettings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLibrary } from "@/hooks/useLibrary";
import { isEpubHexColor } from "@/lib/epub/appearance";
import { FORMATS } from "@/lib/formats";
import {
  HIGHLIGHT_COLOR_KEYS,
  defaultHighlightHex,
  type HighlightColor,
  type HighlightOverrides,
  type HighlightThemeFamily,
} from "@/lib/highlightPalette";
import {
  applyReaderSettingsPatch,
  clearReaderSettings,
  effectiveReaderPreferences,
  readReaderSettings,
  subscribeReaderSettings,
  writeReaderSettings,
} from "@/lib/readerSettings";
import {
  formatShortcutDisplay,
  isMacPlatform,
  READER_SHORTCUTS,
  type ShortcutGroup,
} from "@/lib/readerShortcuts";
import type { AppThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type ReaderPreferences } from "@/state/readerState";
import { useThemeState } from "@/state/themeState";
import type { BookFormat } from "@/types/domain";

type SettingsSectionId = "general" | "viewer" | "shortcuts" | "folders" | "sync" | "data" | "about";

const SECTIONS: { id: SettingsSectionId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "viewer", label: "Viewer settings", icon: Palette },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard },
  { id: "folders", label: "Watched folders", icon: FolderOpen },
  { id: "sync", label: "Sync", icon: RefreshCw },
  { id: "data", label: "Application Data", icon: Database },
  { id: "about", label: "About", icon: Info },
];

const RELEASES_URL = "https://github.com/tuunanet/tuxbooks/releases";

const APP_THEME_OPTIONS: { value: AppThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Read and write the persisted reader-appearance defaults. Theme handling
 * mirrors `ReaderProvider`: an explicit theme pick pins the surface, and a
 * foreground override that stops fitting the new surface is dropped.
 */
function useStoredReaderSettings(resolvedTheme: "light" | "dark") {
  const stored = useSyncExternalStore(
    subscribeReaderSettings,
    readReaderSettings,
    readReaderSettings,
  );

  const setPreferences = useCallback(
    (patch: Partial<ReaderPreferences>) => {
      writeReaderSettings(applyReaderSettingsPatch(readReaderSettings(), patch, resolvedTheme));
    },
    [resolvedTheme],
  );

  const reset = useCallback(() => {
    clearReaderSettings();
  }, []);

  return { stored, setPreferences, reset };
}

/** One highlight slot: swatch trigger opening a hex picker popover. */
function HighlightColorField({
  family,
  color,
  hex,
  overridden,
  onChange,
}: {
  family: HighlightThemeFamily;
  color: HighlightColor;
  hex: string;
  overridden: boolean;
  onChange: (hex: string) => void;
}) {
  const commit = (next: string): void => {
    if (isEpubHexColor(next)) onChange(next);
  };
  const testId = `${family}-${color}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`highlight-color-${testId}`}
          aria-label={`Highlight color ${color} (${family} themes)`}
          title={`Highlight color ${color} (${family} themes)`}
          className={cn(
            "size-6 cursor-pointer rounded-sm border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            overridden && "ring-2 ring-ring/50",
          )}
          style={{ backgroundColor: hex }}
        />
      </PopoverTrigger>
      <PopoverContent
        data-testid={`highlight-picker-${testId}`}
        align="end"
        collisionPadding={8}
        className="w-[232px] gap-2 p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <HexColorPicker
          color={hex}
          onChange={commit}
          className={cn("[&_.react-colorful\\_\\_saturation]:rounded-sm")}
        />
        <div data-testid={`highlight-hex-${testId}`}>
          <HexColorInput
            color={hex}
            onChange={commit}
            prefixed
            className="w-full rounded-sm border border-input bg-transparent px-2 py-1 text-sm tabular-nums"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One theme family: its five highlight slots plus a family reset. */
function HighlightFamilyRow({
  family,
  label,
  themes,
  overrides,
  onChange,
  onReset,
}: {
  family: HighlightThemeFamily;
  label: string;
  themes: string;
  overrides: HighlightOverrides;
  onChange: (family: HighlightThemeFamily, color: HighlightColor, hex: string) => void;
  onReset: (family: HighlightThemeFamily) => void;
}) {
  const overridden = Object.keys(overrides[family]).length > 0;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{themes}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {HIGHLIGHT_COLOR_KEYS.map((color) => (
          <HighlightColorField
            key={color}
            family={family}
            color={color}
            hex={overrides[family][color] ?? defaultHighlightHex(color, family)}
            overridden={overrides[family][color] !== undefined}
            onChange={(hex) => onChange(family, color, hex)}
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          data-testid={`highlight-reset-${family}`}
          onClick={() => onReset(family)}
          disabled={!overridden}
        >
          <RotateCcw data-icon="inline-start" />
          Reset
        </Button>
      </div>
    </div>
  );
}

/**
 * Highlight color defaults and overrides, shared by every reader (the
 * annotation model is format-agnostic). One row per theme family; the wash
 * for the active family is applied at render time, so a picked hue needs no
 * dark-mode variant.
 */
function HighlightsSettingsCard({
  overrides,
  onChange,
  onReset,
}: {
  overrides: HighlightOverrides;
  onChange: (family: HighlightThemeFamily, color: HighlightColor, hex: string) => void;
  onReset: (family: HighlightThemeFamily) => void;
}) {
  return (
    <div className="rounded-lg border p-4" data-testid="highlight-settings">
      <p className="text-sm font-medium">Highlight colors</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Applies to highlights in every book. Colors are tuned per theme family; picking a color
        overrides the default for that family.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <HighlightFamilyRow
          family="light"
          label="Light themes"
          themes="Default · Light · Paper · Mint"
          overrides={overrides}
          onChange={onChange}
          onReset={onReset}
        />
        <HighlightFamilyRow
          family="dark"
          label="Dark themes"
          themes="Dark · Invert · High contrast · Blue"
          overrides={overrides}
          onChange={onChange}
          onReset={onReset}
        />
      </div>
    </div>
  );
}

/**
 * Appearance card copy per format. Titles name the format because the tabs do;
 * `FORMATS` owns the ids, labels, and display order.
 */
const VIEWER_FORMAT_COPY: Record<BookFormat, { title: string; description: string }> = {
  epub: {
    title: "Default reading appearance",
    description:
      "Applied to every EPUB you open. You can still adjust these per session in the reader.",
  },
  pdf: {
    title: "Default PDF appearance",
    description:
      "Applied to every PDF you open. PDFs are fixed-layout, so only the theme can be defaulted.",
  },
};

/**
 * Viewer settings: persisted default appearance, one tab per format. Highlight
 * colors apply to every format, so that card sits below the tabs and is written
 * once. Reset clears every stored default, so it sits above the tabs instead of
 * inside one.
 */
function ViewerSettingsSection() {
  const { resolvedTheme } = useThemeState();
  const { stored, setPreferences, reset } = useStoredReaderSettings(resolvedTheme);
  const [format, setFormat] = useState<BookFormat>("epub");
  const surfaceTheme = effectiveReaderPreferences(stored, resolvedTheme).theme;
  const formats = Object.keys(FORMATS) as BookFormat[];

  const setHighlightOverride = useCallback(
    (family: HighlightThemeFamily, color: HighlightColor, hex: string) => {
      const current = stored.preferences.highlightOverrides;
      setPreferences({
        highlightOverrides: { ...current, [family]: { ...current[family], [color]: hex } },
      });
    },
    [stored.preferences.highlightOverrides, setPreferences],
  );

  const resetHighlightFamily = useCallback(
    (family: HighlightThemeFamily) => {
      const current = stored.preferences.highlightOverrides;
      setPreferences({ highlightOverrides: { ...current, [family]: {} } });
    },
    [stored.preferences.highlightOverrides, setPreferences],
  );

  return (
    <div data-testid="settings-rows" className="mt-6 flex flex-col gap-6">
      <Tabs
        value={format}
        onValueChange={(value) => {
          if (Object.hasOwn(FORMATS, value)) setFormat(value as BookFormat);
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <TabsList aria-label="Default appearance per format">
            {formats.map((id) => (
              <TabsTrigger key={id} value={id} data-testid={`viewer-tab-${id}`}>
                {FORMATS[id].label}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button variant="ghost" size="sm" data-testid="reader-settings-reset" onClick={reset}>
            <RotateCcw data-icon="inline-start" />
            Reset all
          </Button>
        </div>
        {formats.map((id) => (
          <TabsContent key={id} value={id} className="mt-3">
            <div className="rounded-lg border p-4">
              <p className="text-sm font-medium">{VIEWER_FORMAT_COPY[id].title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {VIEWER_FORMAT_COPY[id].description}
              </p>
              <div className="mt-4">
                <ReaderAppearanceControls
                  preferences={stored.preferences}
                  surfaceTheme={surfaceTheme}
                  setPreferences={setPreferences}
                  format={id}
                />
              </div>
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <HighlightsSettingsCard
        overrides={stored.preferences.highlightOverrides}
        onChange={setHighlightOverride}
        onReset={resetHighlightFamily}
      />
    </div>
  );
}

const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = ["global", "library", "reader", "pdf"];

const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  global: "Global",
  library: "Library",
  reader: "Reader",
  pdf: "PDF reader",
};

const ARROW_GLYPHS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function formatComboDisplay(combo: string, mac: boolean): string {
  return formatShortcutDisplay(combo, mac).replace(
    /Arrow(Up|Down|Left|Right)/g,
    (token) => ARROW_GLYPHS[token] ?? token,
  );
}

/** The complete keyboard reference, grouped by where each key works. */
function ShortcutReference() {
  const mac = isMacPlatform();

  return (
    <div data-testid="settings-rows" className="mt-6 flex flex-col gap-6">
      {SHORTCUT_GROUP_ORDER.map((group) => (
        <section key={group}>
          <h3 className="text-sm font-medium">{SHORTCUT_GROUP_LABELS[group]}</h3>
          <dl className="mt-2 divide-y">
            {READER_SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
              <div key={shortcut.id} className="grid grid-cols-[10rem_1fr] gap-4 py-2.5">
                <dt className="text-sm text-muted-foreground">{shortcut.label}</dt>
                <dd className="flex flex-wrap items-center gap-1 text-sm">
                  {shortcut.combos.map((combo, index) => (
                    <span key={`${shortcut.id}-${combo}`} className="flex items-center gap-1">
                      {index > 0 && (
                        <span aria-hidden="true" className="text-xs text-muted-foreground">
                          /
                        </span>
                      )}
                      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1.5 font-mono text-[0.7rem] text-muted-foreground">
                        {formatComboDisplay(combo, mac)}
                      </kbd>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/**
 * The first persisted control in Settings: stored in localStorage via
 * ThemeStateProvider and applied app-wide; the reader surface keeps its own
 * device-local themes.
 */
function AppThemeRow() {
  const { preference, resolvedTheme, setPreference } = useThemeState();
  const hint =
    preference === "system" ? `Following system (${resolvedTheme})` : `Always ${preference}`;
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-4 py-3">
      <dt className="text-sm text-muted-foreground">App theme</dt>
      <dd className="min-w-0">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={preference}
          onValueChange={(value) => value && setPreference(value as AppThemePreference)}
          aria-label="App theme"
        >
          {APP_THEME_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </dd>
    </div>
  );
}

/**
 * General holds the app theme, the version/release entry point, and a
 * read-only library summary. Library contents are managed in the Watched
 * folders tab; importing also runs from the header menu and by drag-and-drop.
 */
function GeneralSection() {
  const { stats } = useLibrary();
  return (
    <div data-testid="settings-rows" className="flex flex-col gap-5">
      <section className="flex items-start gap-3 rounded-xl border p-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
          <BookOpen aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">TuxBooks {__TUXBOOKS_VERSION__}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            See what changed in each release on GitHub.
          </p>
        </div>
        <Button size="sm" asChild>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            View releases
            <ExternalLink data-icon="inline-end" />
          </a>
        </Button>
      </section>

      <section className="rounded-xl border p-4">
        <p className="text-sm font-medium">Appearance</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Sets the app chrome. Reader themes stay per book and per format.
        </p>
        <dl className="mt-3 divide-y">
          <AppThemeRow />
        </dl>
      </section>

      <section className="rounded-xl border p-4">
        <p className="text-sm font-medium">Library</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Books are read from disk and indexed locally.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Books</dt>
            <dd className="text-lg font-semibold tabular-nums">{stats?.bookCount ?? 0}</dd>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Collections</dt>
            <dd className="text-lg font-semibold tabular-nums">{stats?.collectionCount ?? 0}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function SettingsNavigation({
  active,
  onSectionChange,
}: {
  active: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
}) {
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            type="button"
            aria-current={active === section.id ? "true" : undefined}
            onClick={() => onSectionChange(section.id)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              active === section.id
                ? "bg-accent font-medium text-accent-foreground"
                : "text-foreground hover:bg-accent/60",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                active === section.id ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <span className="truncate">{section.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Settings panel. General holds the app theme, version entry point, and a
 * library summary; Viewer settings holds the persisted default appearance,
 * one tab per format, plus the highlight colors shared by every reader;
 * Watched folders lists each watched location with its counts; Application
 * Data shows the app-owned storage roots; Keyboard Shortcuts describes the
 * bindings; About shows the app version, creator credit, and contributor doc
 * links.
 *
 * Rendered inside the draggable Settings window, but the panel itself also
 * works standalone (tests render it directly), so closing is optional.
 */
export function SettingsShell({ onClose }: { onClose?: () => void } = {}) {
  const [active, setActive] = useState<SettingsSectionId>("general");
  const label = SECTIONS.find((section) => section.id === active)?.label;

  return (
    <div data-testid="settings-view" className="flex h-full min-h-0 w-full">
      <aside className="flex w-52 shrink-0 flex-col border-r bg-muted/30">
        <div
          data-settings-drag-handle
          className="flex h-14 shrink-0 cursor-grab touch-none items-center gap-2 px-4 select-none"
        >
          <Settings aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Settings</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <SettingsNavigation active={active} onSectionChange={setActive} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-settings-drag-handle
          className="flex h-14 shrink-0 cursor-grab touch-none items-center justify-between gap-3 border-b px-6 select-none"
        >
          <h2 className="text-base font-semibold">{label}</h2>
          {onClose ? (
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="settings-close"
              aria-label="Close settings"
              title="Close settings (Esc)"
              onClick={onClose}
            >
              <X />
            </Button>
          ) : null}
        </header>
        <ScrollArea className="min-h-0 flex-1">
          {/* Fills the pane; the panel's 1440px ceiling in SettingsWindow.tsx
              is what bounds this at ~1184px on wide windows. */}
          <div className="px-6 pt-5 pb-8">
            {active === "general" ? (
              <GeneralSection />
            ) : active === "viewer" ? (
              <ViewerSettingsSection />
            ) : active === "data" ? (
              <DataSettings />
            ) : active === "folders" ? (
              <FoldersSettings />
            ) : active === "sync" ? (
              <SyncSettings />
            ) : active === "about" ? (
              <AboutSection />
            ) : (
              <ShortcutReference />
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
