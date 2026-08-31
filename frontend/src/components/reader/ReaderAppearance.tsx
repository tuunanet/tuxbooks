import { Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReader, type ReaderLayout, type ReaderTheme } from "@/state/readerState";

const THEME_OPTIONS: { value: ReaderTheme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "paper", label: "Paper" },
  { value: "dark", label: "Dark" },
];

const LAYOUT_OPTIONS: { value: ReaderLayout; label: string }[] = [
  { value: "paginated", label: "Paginated" },
  { value: "scrolling", label: "Scrolling" },
];

/**
 * Reading appearance: font size, line spacing, theme, layout. State lives in
 * the reader context so the whole reading surface responds; persistence is
 * a future backend concern and is not faked here.
 */
export function ReaderAppearance() {
  const { preferences, setPreferences } = useReader();

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
            <span className="tabular-nums text-muted-foreground">{preferences.fontSize}px</span>
          </div>
          <Slider
            data-testid="pref-font-size"
            aria-label="Font size"
            min={14}
            max={22}
            step={1}
            value={[preferences.fontSize]}
            onValueChange={(values) => setPreferences({ fontSize: values[0] })}
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
