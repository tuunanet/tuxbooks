import { RotateCcw } from "lucide-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isEpubHexColor } from "@/lib/epub/appearance";
import {
  HIGHLIGHT_COLOR_KEYS,
  defaultHighlightHex,
  type HighlightColor,
  type HighlightOverrides,
  type HighlightThemeFamily,
} from "@/lib/highlightPalette";
import { cn } from "@/lib/utils";

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
export function HighlightsSettingsCard({
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
