const REPO_BLOB_BASE = "https://github.com/tuunanet/tuxbooks/blob/main";

const DOC_LINKS = [
  {
    href: `${REPO_BLOB_BASE}/CONTRIBUTORS.md`,
    label: "Contributors",
    hint: "Full list of contributors",
  },
  {
    href: `${REPO_BLOB_BASE}/CONTRIBUTING.md`,
    label: "Contributing",
    hint: "How to contribute",
  },
] as const;

/**
 * The About tab: app name and version, creator credit, and links to the
 * contributor docs on the main branch. Links open in the system browser via
 * the Electron window-open handler.
 */
export function AboutSection() {
  return (
    <div data-testid="settings-rows" className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border p-4">
        <p className="text-sm font-medium">TuxBooks {__TUXBOOKS_VERSION__}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Created by Tuomo Tuunanen (2026–)</p>
        <div className="mt-4 flex flex-col gap-3">
          {DOC_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-md outline-none transition-colors hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="block text-sm font-medium">{link.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{link.hint}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
