/**
 * Join summary bits for prose: one item stands alone, two join with "and",
 * three or more take commas. The dialogs' count-and-join summaries share it.
 */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
