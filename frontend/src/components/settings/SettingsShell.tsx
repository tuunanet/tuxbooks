import { useState } from "react";
import { cn } from "@/lib/utils";

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
      value: "17px default",
      hint: "Adjustable per session in the reader; saving preferences needs backend support.",
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
 * Settings screen: sections with presentational rows only. No switches or
 * inputs that pretend to persist — values describe current behavior and
 * where the real controls will live.
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
