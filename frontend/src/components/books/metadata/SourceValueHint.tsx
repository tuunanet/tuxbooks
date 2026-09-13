import type { MetadataFieldSource } from "@/types/domain";

/**
 * Per-field authority control for an overridden field: shows the file's own
 * value and lets the user choose which layer is effective. The library
 * override is kept either way, so switching back is lossless.
 */
export function SourceValueHint({
  source,
  fileValue,
  onSetSource,
}: {
  source: MetadataFieldSource | null;
  fileValue: string;
  onSetSource: (source: MetadataFieldSource | null) => void;
}) {
  if (source === "file") {
    return (
      <p data-testid="metadata-source-file" className="text-xs text-muted-foreground">
        Using the file value (your library value is kept).{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => onSetSource("library")}
        >
          Use library value
        </button>
      </p>
    );
  }
  return (
    <p data-testid="metadata-source-library" className="text-xs text-muted-foreground">
      File:{" "}
      {fileValue.trim() === "" ? (
        <span className="italic">none</span>
      ) : (
        <span className="line-clamp-2 break-words">{fileValue}</span>
      )}{" "}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={() => onSetSource("file")}
      >
        Use file value
      </button>
    </p>
  );
}
