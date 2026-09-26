/**
 * The selected state paints the blue library token. Hover keeps the neutral
 * accent on unselected books, so the two never read the same.
 */
export function bookSelectionClass(selected: boolean): string {
  return selected ? "bg-library-selection/20 ring-2 ring-library-selection" : "hover:bg-accent/40";
}
