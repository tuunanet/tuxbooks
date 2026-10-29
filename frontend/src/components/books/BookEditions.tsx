import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LinkEditionDialog } from "./LinkEditionDialog";
import { useLibrary } from "@/hooks/useLibrary";
import {
  linkBookEdition,
  listBookEditions,
  listReadingHistory,
  type Book,
  type EditionBook,
} from "@/lib/bridge";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Linked editions of one durable book (ADR 0014 D9). The section also owns
 * the confirmation flow: pick another existing book, then link it as a
 * different edition without merging identities or moving annotations.
 */
export function BookEditions({ book }: { book: Book }) {
  const { books, refresh } = useLibrary();
  const bookId = book.id;
  const [loadedEditions, setLoadedEditions] = useState<{
    bookId: number;
    editions: EditionBook[];
  } | null>(null);
  const [editionsVersion, setEditionsVersion] = useState(0);
  const [editionCandidates, setEditionCandidates] = useState<EditionBook[]>([]);
  const [editionDialogOpen, setEditionDialogOpen] = useState(false);
  const [editionBusy, setEditionBusy] = useState(false);
  const [editionError, setEditionError] = useState<string | null>(null);
  const editions =
    loadedEditions !== null && loadedEditions.bookId === bookId ? loadedEditions.editions : [];

  useEffect(() => {
    let cancelled = false;
    void listBookEditions(bookId)
      .then((found) => {
        if (!cancelled) setLoadedEditions({ bookId, editions: found });
      })
      .catch((err) => console.error("list_book_editions failed:", err));
    return () => {
      cancelled = true;
    };
  }, [bookId, editionsVersion]);

  const openEditionLink = async () => {
    setEditionError(null);
    setEditionCandidates([]);
    setEditionDialogOpen(true);
    setEditionBusy(true);
    try {
      const history = await listReadingHistory();
      const alreadyLinked = new Set(editions.map((edition) => edition.id));
      const candidates: EditionBook[] = [
        ...books
          .filter((candidate) => candidate.id !== bookId && !alreadyLinked.has(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            bookUid: candidate.bookUid ?? "",
            title: candidate.title,
            author: candidate.author,
            inLibrary: true,
          })),
        ...history
          .filter((candidate) => candidate.id !== bookId && !alreadyLinked.has(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            bookUid: candidate.bookUid,
            title: candidate.title,
            author: candidate.author,
            inLibrary: false,
          })),
      ];
      setEditionCandidates(candidates);
    } catch (err) {
      setEditionError(toMessage(err));
    } finally {
      setEditionBusy(false);
    }
  };

  const confirmEditionLink = async (source: EditionBook) => {
    setEditionBusy(true);
    setEditionError(null);
    try {
      await linkBookEdition(source.id, bookId);
      setEditionDialogOpen(false);
      setEditionsVersion((version) => version + 1);
      await refresh();
    } catch (err) {
      setEditionError(toMessage(err));
    } finally {
      setEditionBusy(false);
    }
  };

  return (
    <div className="mt-8">
      <h3 className="text-sm font-medium text-muted-foreground">Editions</h3>
      {editions.length === 0 ? (
        <p data-testid="detail-editions-empty" className="mt-2 text-sm text-muted-foreground">
          No other editions linked. If this is a different edition of a book you already read, link
          them so the progress percentage and provider link follow you.
        </p>
      ) : (
        <ul data-testid="detail-editions" className="mt-2 flex flex-col gap-2 text-sm">
          {editions.map((edition) => (
            <li
              key={edition.id}
              data-testid={`detail-edition-${edition.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{edition.title?.trim() || "Unknown title"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {edition.author?.trim() || "Unknown author"}
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px]">
                {edition.inLibrary ? "Library" : "Reading history"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Button
        data-testid="detail-link-edition"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={editionBusy}
        onClick={() => void openEditionLink()}
      >
        Link another edition…
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">
        Linked editions keep separate identities and annotations. A confirmed link copies progress
        as a percentage and moves the provider link and status to this edition.
      </p>

      <LinkEditionDialog
        key={editionDialogOpen ? "open" : "closed"}
        open={editionDialogOpen}
        currentTitle={book.title}
        candidates={editionCandidates}
        busy={editionBusy}
        error={editionError}
        onConfirm={(source) => void confirmEditionLink(source)}
        onCancel={() => {
          setEditionDialogOpen(false);
          setEditionError(null);
        }}
      />
    </div>
  );
}
