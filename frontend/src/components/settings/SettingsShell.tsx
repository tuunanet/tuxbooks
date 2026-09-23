import { useCallback, useState } from "react";
import { RotateCcw } from "lucide-react";
import { ReaderAppearanceControls } from "@/components/reader/ReaderAppearance";
import { DataSettings } from "@/components/settings/DataSettings";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { epubForegroundFitsTheme, epubSurfaceTheme } from "@/lib/epub/appearance";
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

type SettingsSectionId = "general" | "reading" | "pdf" | "shortcuts" | "advanced" | "data";

const SECTIONS: { id: SettingsSectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "reading", label: "Reading" },
  { id: "pdf", label: "PDF" },
  { id: "shortcuts", label: "Keyboard Shortcuts" },
  { id: "advanced", label: "Advanced" },
  { id: "data", label: "Data" },
];

interface SettingsRow {
  label: string;
  value: string;
  hint?: string;
}

const SECTION_ROWS: Record<SettingsSectionId, SettingsRow[]> = {
  general: [
    {
      label: "Library folder",
      value: "Chosen per import",
      hint: "Books are scanned from the folder you pick; the database and covers live in the app data directory.",
    },
    {
      label: "Importing",
      value: "Header → Import",
      hint: "Use the Import menu, or drag a folder or files onto the window.",
    },
    {
      label: "Collections",
      value: "Managed from the sidebar",
      hint: "Create collections there and add books from any context menu; a book can belong to many.",
    },
  ],
  reading: [
    {
      label: "How defaults are saved",
      value: "On this device",
      hint: "Reader appearance is kept locally; it applies to every EPUB you open and can still be adjusted per session in the toolbar.",
    },
  ],
  pdf: [
    {
      label: "Rendering",
      value: "Continuous, on demand",
      hint: "Pages rasterize as you scroll with PDFium; covers are extracted at import by the sidecar.",
    },
    {
      label: "Outlines and thumbnails",
      value: "Built in",
      hint: "The navigation drawer shows the PDF outline and a virtualized thumbnail grid.",
    },
  ],
  shortcuts: [],
  advanced: [
    {
      label: "Storage",
      value: "Local only",
      hint: "The library database and extracted covers live in the OS app-data directory. Nothing leaves your machine.",
    },
    {
      label: "Full-text search",
      value: "SQLite FTS5",
      hint: "Kept in sync automatically when books are imported or updated.",
    },
  ],
  data: [],
};

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

/** The interactive reader-appearance editor shared by Reading and PDF. */
function ReaderSettingsSection({ format }: { format: "epub" | "pdf" }) {
  const { resolvedTheme } = useThemeState();
  const { stored, setPreferences, reset } = useStoredReaderSettings(resolvedTheme);
  const preferences = effectiveReaderPreferences(stored, resolvedTheme);
  const section: SettingsSectionId = format === "pdf" ? "pdf" : "reading";

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
      <dl className="divide-y">
        {SECTION_ROWS[section].map((row) => (
          <InfoRow key={row.label} row={row} />
        ))}
      </dl>
    </div>
  );
}

function InfoRow({ row }: { row: SettingsRow }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-4 py-3">
      <dt className="text-sm text-muted-foreground">{row.label}</dt>
      <dd className="min-w-0">
        <p className="text-sm">{row.value}</p>
        {row.hint && <p className="mt-1 text-xs text-muted-foreground">{row.hint}</p>}
      </dd>
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
 * Settings screen. General holds the app theme plus library information;
 * Reading and PDF hold real, persisted default appearance controls (saved on
 * device and applied whenever a book opens); Data shows the app-owned storage
 * roots; the remaining sections describe shortcuts and local storage.
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
        {active === "reading" || active === "pdf" ? (
          <ReaderSettingsSection format={active === "pdf" ? "pdf" : "epub"} />
        ) : active === "data" ? (
          <DataSettings />
        ) : active === "shortcuts" ? (
          <ShortcutReference />
        ) : (
          <dl data-testid="settings-rows" className="mt-6 divide-y">
            {active === "general" && <AppThemeRow />}
            {SECTION_ROWS[active].map((row) => (
              <InfoRow key={row.label} row={row} />
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
