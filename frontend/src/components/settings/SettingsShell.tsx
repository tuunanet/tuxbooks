import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AppThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useThemeState } from "@/state/themeState";

type SettingsSectionId = "general" | "reading" | "pdf" | "shortcuts" | "advanced";

const SECTIONS: { id: SettingsSectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "reading", label: "Reading" },
  { id: "pdf", label: "PDF" },
  { id: "shortcuts", label: "Keyboard Shortcuts" },
  { id: "advanced", label: "Advanced" },
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
      hint: "Use the Import menu or drag a folder of books onto the window.",
    },
    {
      label: "Collections",
      value: "Not connected yet",
      hint: "Creating collections needs a backend command that does not exist yet.",
    },
  ],
  reading: [
    {
      label: "Font size",
      value: "100% default (75–400%)",
      hint: "Adjustable per session in the reader; persisting reader preferences needs backend support.",
    },
    {
      label: "Theme",
      value: "Light · Paper · Dark",
      hint: "Session-only for now, selected in the reader toolbar.",
    },
    {
      label: "Layout",
      value: "Paginated · Scrolling",
      hint: "Session-only for now, selected in the reader toolbar.",
    },
  ],
  pdf: [
    {
      label: "Rendering",
      value: "Arrives with the PDF engine",
      hint: "PDFs import with metadata only; page rendering is a future reader stage.",
    },
    {
      label: "Outlines",
      value: "Not available yet",
      hint: "The navigation drawer shows an honest placeholder for PDF outlines.",
    },
  ],
  shortcuts: [
    { label: "Global search", value: "Ctrl/Cmd + K" },
    { label: "Open selected book", value: "Enter" },
    { label: "Close overlay", value: "Esc" },
    { label: "Reader: next / previous page", value: "→ / ← / Space" },
    { label: "Reader: start / end", value: "Home / End" },
    { label: "Reader: bookmark", value: "Ctrl/Cmd + B" },
  ],
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
};

const APP_THEME_OPTIONS: { value: AppThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * The first persisted control in Settings: stored in localStorage via
 * ThemeStateProvider and applied app-wide; the reader surface keeps its own
 * session-scoped themes.
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
 * Settings screen: rows that describe current behavior, plus the first real
 * persisted control — the app theme in General (localStorage via
 * ThemeStateProvider). Every other row stays presentational: no switches or
 * inputs that pretend to persist.
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
        <dl data-testid="settings-rows" className="mt-6 divide-y">
          {active === "general" && <AppThemeRow />}
          {SECTION_ROWS[active].map((row) => (
            <div key={row.label} className="grid grid-cols-[10rem_1fr] gap-4 py-3">
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0">
                <p className="text-sm">{row.value}</p>
                {row.hint && <p className="mt-1 text-xs text-muted-foreground">{row.hint}</p>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
