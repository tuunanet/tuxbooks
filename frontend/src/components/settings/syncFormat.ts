export function formatSyncTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** Hybrid-clock wall times are milliseconds, not ISO strings. */
export function formatSyncWall(wall: number): string {
  if (!Number.isFinite(wall) || wall <= 0) return "Unknown time";
  return new Date(wall).toLocaleString();
}
