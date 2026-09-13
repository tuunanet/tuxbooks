import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { coverFileUrl, pickCoverImage } from "@/lib/bridge";
import type { BookMetadata } from "@/types/domain";

export interface CoverFieldProps {
  metadata: BookMetadata;
  onChangeCover: (imagePath: string) => Promise<void>;
  onRestoreCover: () => Promise<void>;
}

/** Library cover curation — never writes the book file's own cover. */
export function CoverField({ metadata, onChangeCover, onRestoreCover }: CoverFieldProps) {
  const [busy, setBusy] = useState(false);

  const onChange = async () => {
    setBusy(true);
    try {
      const path = await pickCoverImage();
      if (path) await onChangeCover(path);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {metadata.coverPath ? (
        <img
          data-testid="metadata-cover-thumb"
          src={coverFileUrl(metadata.coverPath)}
          alt=""
          className="h-16 w-11 rounded border object-cover"
        />
      ) : (
        <div
          data-testid="metadata-cover-placeholder"
          className="flex h-16 w-11 items-center justify-center rounded border text-xs text-muted-foreground"
        >
          None
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Cover</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="metadata-cover-change"
            title="Choose an image for the library; the book file's cover is unchanged"
            disabled={busy}
            onClick={() => void onChange()}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Change cover…
          </Button>
          {metadata.overridden.cover && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="metadata-cover-restore"
              title="Go back to the cover taken from the book file"
              onClick={() => void onRestoreCover()}
            >
              Restore extracted cover
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Shown in your library only; the book file keeps its own cover.
        </p>
      </div>
    </div>
  );
}
