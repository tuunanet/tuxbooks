import { useCallback, useState } from "react";
import { RotateCcw } from "lucide-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { AboutSection } from "@/components/settings/AboutSection";
import { ReaderAppearanceControls } from "@/components/reader/ReaderAppearance";
import { DataSettings } from "@/components/settings/DataSettings";
import { FoldersSettings } from "@/components/settings/FoldersSettings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { epubForegroundFitsTheme, epubSurfaceTheme, isEpubHexColor } from "@/lib/epub/appearance";
import {
  HIGHLIGHT_COLOR_KEYS,
  defaultHighlightHex,
  type HighlightColor,
  type HighlightOverrides,
  type HighlightThemeFamily,
} from "@/lib/highlightPalette";
import {
  clearReaderSettings,
  defaultReaderSettings,
  effectiveReaderPreferences,
  readReaderSettings,
  writeReaderSettings,
  type StoredReaderSettings,
} from "@/lib/readerSettings";
import {
  formatShortcutDisplay,
  isMacPlatform,
  READER_SHORTCUTS,
  type ShortcutGroup,
} from "@/lib/readerShortcuts";
import type { AppThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { autoReaderTheme, type ReaderPreferences } from "@/state/readerState";
import { useThemeState } from "@/state/themeState";

type SettingsSectionId = "general" | "reading" | "pdf" | "shortcuts" | "folders" | "data" | "about";

const SECTIONS: { id: SettingsSectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "reading", label: "EPUB" },
  { id: "pdf", label: "PDF" },
  { id: "shortcuts", label: "Keyboard Shortcuts" },
  { id: "folders", label: "Watched folders" },
  { id: "data", label: "Application Data" },
  { id: "about", label: "About" },
];

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
  const [stored, setStored] = useState<StoredReaderSettings>(readReaderSettings);

  const setPreferences = useCallback(
    (patch: Partial<ReaderPreferences>) => {
      setStored((current) => {
        const next: StoredReaderSettings = {
          preferences: { ...current.preferences, ...patch },
          themePinned: patch.theme !== undefined ? true : current.themePinned,
        };
        const currentEffectiveTheme = current.themePinned
          ? current.preferences.theme
          : autoReaderTheme(resolvedTheme);
        if (
          patch.theme !== undefined &&
          patch.theme !== currentEffectiveTheme &&
          !epubForegroundFitsTheme(
            next.preferences.foreground,
            epubSurfaceTheme(next.preferences.theme),
          )
        ) {
          next.preferences.foreground = null;
        }
        writeReaderSettings(next);
        return next;
      });
    },
    [resolvedTheme],
  );

  const reset = useCallback(() => {
    clearReaderSettings();
    setStored(defaultReaderSettings());
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
 * Highlight color defaults and overrides, shared by EPUB and PDF (the
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
        Applies to highlights in every book and PDF. Colors are tuned per theme family; picking a
        color overrides the default for that family.
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
          themes="Dark · Invert · High contrast · Blue contrast"
          overrides={overrides}
          onChange={onChange}
          onReset={onReset}
        />
      </div>
    </div>
  );
}

/** The interactive reader-appearance editor shared by EPUB and PDF. */
function ReaderSettingsSection({ format }: { format: "epub" | "pdf" }) {
  const { resolvedTheme } = useThemeState();
  const { stored, setPreferences, reset } = useStoredReaderSettings(resolvedTheme);
  const preferences = effectiveReaderPreferences(stored, resolvedTheme);

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
      <div className="rounded-lg border p-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">
              {format === "pdf" ? "Default PDF appearance" : "Default reading appearance"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {format === "pdf"
                ? "Applied to every PDF you open. PDFs are fixed-layout, so only the theme can be defaulted."
                : "Applied to every EPUB you open. You can still adjust these per session in the reader."}
            </p>
          </div>
          <Button variant="ghost" size="sm" data-testid="reader-settings-reset" onClick={reset}>
            <RotateCcw data-icon="inline-start" />
            Reset
          </Button>
        </div>
        <ReaderAppearanceControls
          preferences={preferences}
          setPreferences={setPreferences}
          format={format}
        />
      </div>
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
 * General holds the app theme. Library contents are managed in the Watched
 * folders tab; importing also runs from the header menu and by drag-and-drop.
 */
function GeneralSection() {
  return (
    <dl data-testid="settings-rows" className="mt-6 divide-y">
      <AppThemeRow />
    </dl>
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
    <nav
      aria-label="Settings sections"
      className="flex flex-row flex-wrap gap-1 lg:w-48 lg:shrink-0 lg:flex-col"
    >
      <div className="flex flex-row flex-wrap gap-1 lg:flex-col lg:gap-0.5">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={active === section.id ? "true" : undefined}
            onClick={() => onSectionChange(section.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              active === section.id
                ? "bg-accent font-medium text-accent-foreground"
                : "text-foreground hover:bg-accent/60",
            )}
          >
            {section.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

/**
 * Settings screen. General holds the app theme; EPUB and PDF hold real,
 * persisted default appearance controls (saved on device and applied whenever
 * a book opens); Watched folders lists each watched location with its counts;
 * Application Data shows the app-owned storage roots; Keyboard Shortcuts
 * describes the bindings; About shows the app version, creator credit, and
 * contributor doc links.
 */
export function SettingsShell() {
  const [active, setActive] = useState<SettingsSectionId>("general");

  return (
    <section data-testid="settings-view" className="flex flex-col gap-6 lg:flex-row lg:gap-10">
      <SettingsNavigation active={active} onSectionChange={setActive} />
      <div className="min-w-0 max-w-xl flex-1">
        <h2 className="text-2xl font-semibold">
          {SECTIONS.find((section) => section.id === active)?.label}
        </h2>
        {active === "general" ? (
          <GeneralSection />
        ) : active === "reading" || active === "pdf" ? (
          <ReaderSettingsSection format={active === "pdf" ? "pdf" : "epub"} />
        ) : active === "data" ? (
          <DataSettings />
        ) : active === "folders" ? (
          <FoldersSettings />
        ) : active === "about" ? (
          <AboutSection />
        ) : (
          <ShortcutReference />
        )}
      </div>
    </section>
  );
}
