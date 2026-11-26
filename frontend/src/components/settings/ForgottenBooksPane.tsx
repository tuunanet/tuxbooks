import { ForgottenBookRow } from "@/components/history/ReadingHistoryRows";
import { TabsContent } from "@/components/ui/tabs";
import type { BookTrashEntry } from "@/types/domain";

interface ForgottenBooksPaneProps {
  trash: BookTrashEntry[];
  busy: boolean;
  onRestore: (entry: BookTrashEntry) => void;
  onRestoreWithoutFile: (entry: BookTrashEntry) => void;
}

/**
 * The Forgotten books tab: restorable trash rows within their 30-day window.
 * Restoring puts the old record and its state back; a new-state book asks
 * first, and a picked file with different bytes offers only lossless choices.
 */
export function ForgottenBooksPane({
  trash,
  busy,
  onRestore,
  onRestoreWithoutFile,
}: ForgottenBooksPaneProps) {
  return (
    <TabsContent value="forgotten" forceMount className="mt-4">
      <section data-testid="recently-forgotten" className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Forgotten books stay restorable for 30 days. Restoring puts the old record and its state
          back; if the current book has new reading data, TuxBooks asks first.
        </p>
        {trash.length === 0 ? (
          <p data-testid="history-forgotten-empty" className="text-sm text-muted-foreground">
            Nothing is waiting to be restored. Forgotten books appear here and stay restorable for
            30 days.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {trash.map((entry) => (
              <ForgottenBookRow
                key={entry.id}
                entry={entry}
                busy={busy}
                onRestore={onRestore}
                onRestoreWithoutFile={onRestoreWithoutFile}
              />
            ))}
          </ul>
        )}
      </section>
    </TabsContent>
  );
}
