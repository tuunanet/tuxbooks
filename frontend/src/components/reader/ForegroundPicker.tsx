import { HexColorInput, HexColorPicker } from "react-colorful";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isEpubHexColor } from "@/lib/epub/appearance";
import { cn } from "@/lib/utils";

interface ForegroundPickerProps {
  /** Current color shown on the trigger and in the picker (hex). */
  value: string;
  /** Called with a complete #rrggbb color; partial/invalid input is ignored. */
  onChange: (hex: string) => void;
}

/**
 * Free-form foreground color picker (issue #55). A native
 * `<input type="color">` popup is positioned by Chromium itself and bleeds
 * off the window edge when the appearance popover sits at the screen's
 * right (UAT feedback) — this picker renders as a regular popover instead,
 * so the Radix collision handling flips it left when the window edge is
 * near. Invalid/partial hex input is never committed.
 */
export function ForegroundPicker({ value, onChange }: ForegroundPickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="pref-foreground-input"
          aria-label="Custom foreground color"
          title="Custom foreground color"
          className="h-6 w-8 cursor-pointer rounded-sm border border-border"
          style={{ backgroundColor: value }}
        />
      </PopoverTrigger>
      <PopoverContent
        data-testid="pref-foreground-picker"
        align="end"
        collisionPadding={8}
        className="w-[232px] gap-2 p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <HexColorPicker
          color={value}
          onChange={(hex) => {
            if (isEpubHexColor(hex)) {
              onChange(hex);
            }
          }}
          className={cn("[&_.react-colorful\\_\\_saturation]:rounded-sm")}
        />
        <div data-testid="pref-foreground-hex">
          <HexColorInput
            color={value}
            onChange={(hex) => {
              if (isEpubHexColor(hex)) {
                onChange(hex);
              }
            }}
            prefixed
            className="w-full rounded-sm border border-input bg-transparent px-2 py-1 text-sm tabular-nums"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
