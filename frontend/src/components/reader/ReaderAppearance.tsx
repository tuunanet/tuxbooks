import { RotateCcw, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  EPUB_DEFAULT_FONT_SIZE_PERCENT,
  EPUB_FONT_SIZE_SCALE_PERCENT,
  nearestEpubFontSize,
} from "@/lib/epub/appearance";
import {
  useReader,
  type ReaderFontFamily,
  type ReaderLayout,
  type ReaderTheme,
} from "@/state/readerState";

const THEME_OPTIONS: { value: ReaderTheme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "paper", label: "Paper" },
  { value: "dark", label: "Dark" },
];

const LAYOUT_OPTIONS: { value: ReaderLayout; label: string }[] = [
  { value: "paginated", label: "Paginated" },
  { value: "scrolling", label: "Scrolling" },
];

const FONT_FAMILY_OPTIONS: { value: ReaderFontFamily; label: string }[] = [
  { value: "serif", label: "Serif" },
  { value: "sans", label: "Sans" },
];

/**
 * Reading appearance: font size, line spacing, theme, layout. State lives in
 * the reader context so the whole reading surface responds; persistence is
 * a future backend concern and is not faked here.
 */
export function ReaderAppearance() {
  const { preferences, setPreferences } = useReader();

  // The font-size slider walks the supported Readium scale by index; the
  // state itself holds the scale percentage, snapped so an off-scale value
  // (e.g. a future stored preference) can never wedge the slider.
  const fontSize = nearestEpubFontSize(preferences.epubFontSize);
  const fontSizeIndex = EPUB_FONT_SIZE_SCALE_PERCENT.indexOf(fontSize);
  const atDefaultFontSize = fontSize === EPUB_DEFAULT_FONT_SIZE_PERCENT;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="appearance-trigger"
              aria-label="Reading appearance"
            >
              <Type />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Appearance (Aa)</TooltipContent>
      </Tooltip>
      <PopoverContent
        data-testid="appearance-content"
        align="end"
        className="w-64 gap-4"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>Font size</span>
            <span className="flex items-center gap-1">
              <span className="tabular-nums text-muted-foreground">{fontSize}%</span>
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="pref-font-size-reset"
                aria-label="Reset font size"
                disabled={atDefaultFontSize}
                onClick={() => setPreferences({ epubFontSize: EPUB_DEFAULT_FONT_SIZE_PERCENT })}
              >
                <RotateCcw />
              </Button>
            </span>
          </div>
          <Slider
            data-testid="pref-font-size"
            aria-label="Font size"
            min={0}
            max={EPUB_FONT_SIZE_SCALE_PERCENT.length - 1}
            step={1}
            value={[fontSizeIndex]}
            onValueChange={(values) => {
              const index = values[0];
              if (index !== undefined) {
                setPreferences({ epubFontSize: EPUB_FONT_SIZE_SCALE_PERCENT[index] });
              }
            }}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>Line spacing</span>
            <span className="tabular-nums text-muted-foreground">
              {preferences.lineHeight.toFixed(1)}
            </span>
          </div>
          <Slider
            data-testid="pref-line-height"
            aria-label="Line spacing"
            min={1.2}
            max={2}
            step={0.1}
            value={[preferences.lineHeight]}
            onValueChange={(values) => setPreferences({ lineHeight: values[0] })}
          />
        </div>

        <div>
          <p className="mb-2 text-sm">Font</p>
          <ToggleGroup
            data-testid="pref-font-family"
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={preferences.fontFamily ?? "default"}
            onValueChange={(value) =>
              setPreferences({
                fontFamily:
                  value === "serif" || value === "sans" ? (value as ReaderFontFamily) : null,
              })
            }
            aria-label="Font family"
          >
            {FONT_FAMILY_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="default">Default</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div>
          <p className="mb-2 text-sm">Theme</p>
          <ToggleGroup
            data-testid="pref-theme"
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={preferences.theme}
            onValueChange={(value) => value && setPreferences({ theme: value as ReaderTheme })}
            aria-label="Theme"
          >
            {THEME_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div>
          <p className="mb-2 text-sm">Layout</p>
          <ToggleGroup
            data-testid="pref-layout"
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={preferences.layout}
            onValueChange={(value) => value && setPreferences({ layout: value as ReaderLayout })}
            aria-label="Layout"
          >
            {LAYOUT_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
}
