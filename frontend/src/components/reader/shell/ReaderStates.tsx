import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The selected book disappeared from the library while the reader was open. */
export function ReaderUnavailable({ onBack }: { onBack: () => void }) {
  return (
    <>
      <h2 className="text-xl font-semibold">This book is no longer in the library</h2>
      <Button variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft data-icon="inline-start" />
        Back to Library
      </Button>
    </>
  );
}

/** Shown while the annotation list resolves the highlight to open at. */
export function ReaderOpeningHighlight() {
  return <>Opening highlight…</>;
}
