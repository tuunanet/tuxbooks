/** Byte counts as the fixed one-decimal MB figure the Settings tabs show. */
export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
