import type { ProviderLink, ProviderReadingStatus } from "@/types/domain";

const STATUS_LABELS: Record<ProviderReadingStatus, string> = {
  want_to_read: "Want to read",
  reading: "Reading",
  paused: "Paused",
  finished: "Finished",
  dropped: "Dropped",
};

/** A provider name as a display label; unknown adapters stay recognizable. */
export function providerLabel(provider: string): string {
  const trimmed = provider.trim();
  if (trimmed === "") return "Provider";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** One line for a link: `Hardcover · Reading`, or just the provider. */
export function providerLinkLabel(link: ProviderLink): string {
  const provider = providerLabel(link.provider);
  return link.status === null ? provider : `${provider} · ${STATUS_LABELS[link.status]}`;
}
