import { Fragment, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookCover } from "./BookCover";
import { BookBookmarksPanel } from "./BookBookmarksPanel";
import { BookFileLocations } from "./BookFileLocations";
import { BookReadingActions } from "./BookReadingActions";
import { ForgetBookDialog } from "./ForgetBookDialog";
import { BookHighlightsPanel } from "./BookHighlightsPanel";
import { LinkEditionDialog } from "./LinkEditionDialog";
import { MetadataPanel } from "./MetadataPanel";
import { ResetBookDialog } from "./ResetBookDialog";
import { useBookActions } from "@/hooks/useBookActions";
import { useBookFiles } from "@/hooks/useBookFiles";
import { useBookMetadata } from "@/hooks/useBookMetadata";
import { useLibrary } from "@/hooks/useLibrary";
import { sectionTitle } from "@/components/library/sections";
import { useAppDispatch, useAppState, type DetailTab } from "@/state/appState";
import { linkBookEdition, listBookEditions, listReadingHistory } from "@/lib/bridge";
import type { EditionBook } from "@/lib/bridge";
import { providerLinkLabel } from "@/lib/providers";

/** ISO dates render deterministically in UTC so tests and locales agree. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/**
 * Book detail view, rendered inside the library shell (sidebar stays).
 * Data comes from the shared `list_books` payload — there is no
 * `get_book` command yet (decision D1). Reading position comes from the
 * same payload's progress join (milestone 10). File locations come from
 * `list_book_files`, so one library entry can list every duplicate copy
 * (ADR 0014 D7). The Overview/Metadata rail makes metadata the primary,
 * transparent surface (issue #58); Highlights and Bookmarks review what the
 * reader captured and open the book at a row's position.
 */
export function BookDetail() {
  const { selectedBookId, section, detailTab = "overview" } = useAppState();
  const { books, collections, refresh } = useLibrary();
  const {
    locateBook,
    removeBookFromLibrary,
    removeBookFile: removeCopy,
    resetReadingData,
    forgetBookFromLibrary,
  } = useBookActions();
  const [resetOpen, setResetOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const dispatch = useAppDispatch();
  const book = books.find((candidate) => candidate.id === selectedBookId) ?? null;
  // One curation view is shared by the Overview subjects row and the
  // Metadata panel, so saves and resets refresh both.
  const curation = useBookMetadata(book ? book.id : null);
  const { files, refresh: refreshFiles } = useBookFiles(book ? book.id : null);
  const bookId = book ? book.id : null;
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
  const subjects = curation.metadata?.effective.subjects ?? [];
  const memberCollections =
    book === null ? [] : collections.filter((collection) => collection.bookIds.includes(book.id));

  useEffect(() => {
    if (bookId === null) return;
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

  if (!book) {
    return (
      <section data-testid="book-detail-missing" className="pt-16 text-center">
        <h2 className="text-xl font-semibold">This book is no longer in the library</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been re-imported with a different id, or removed on disk.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => dispatch({ type: "return-to-library" })}
        >
          <ArrowLeft data-icon="inline-start" />
          Back to {sectionTitle(section)}
        </Button>
      </section>
    );
  }

  const removeFile = async (fileId: number) => {
    if (await removeCopy(book.id, fileId)) await refreshFiles();
  };

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
          .filter((candidate) => candidate.id !== book.id && !alreadyLinked.has(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            bookUid: candidate.bookUid ?? "",
            title: candidate.title,
            author: candidate.author,
            inLibrary: true,
          })),
        ...history
          .filter((candidate) => candidate.id !== book.id && !alreadyLinked.has(candidate.id))
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
      setEditionError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditionBusy(false);
    }
  };

  const confirmEditionLink = async (source: EditionBook) => {
    setEditionBusy(true);
    setEditionError(null);
    try {
      await linkBookEdition(source.id, book.id);
      setEditionDialogOpen(false);
      setEditionsVersion((version) => version + 1);
      await refresh();
    } catch (err) {
      setEditionError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditionBusy(false);
    }
  };

  const facts: [string, string][] = [
    ["Format", book.format.toUpperCase()],
    ["Added", formatDate(book.addedAt)],
    ["Last opened", formatDate(book.lastOpenedAt)],
    [
      "Reading position",
      book.progressPercent === null ? "—" : `${Math.round(book.progressPercent)}%`,
    ],
    ["File", book.path],
  ];

  return (
    <section data-testid="book-detail" className="mx-auto max-w-3xl">
      <Button
        variant="ghost"
        size="sm"
        data-testid="detail-back"
        className="-ml-2"
        onClick={() => dispatch({ type: "return-to-library" })}
      >
        <ArrowLeft data-icon="inline-start" />
        Back to {sectionTitle(section)}
      </Button>

      <div className="mt-4 flex flex-wrap gap-6">
        <BookCover book={book} className="w-40 shrink-0 text-6xl" />
        <div className="min-w-0 flex-1">
          <h2 data-testid="detail-title" className="text-2xl font-semibold leading-tight">
            {book.title}
          </h2>
          <p className="mt-1 text-muted-foreground">{book.author ?? "Unknown author"}</p>
          {book.format === "pdf" && (
            <Badge variant="secondary" className="mt-2">
              PDF
            </Badge>
          )}

          <BookReadingActions
            book={book}
            onLocate={() => void locateBook(book.id)}
            onRemoveFromLibrary={() => void removeBookFromLibrary(book.id)}
            onContinue={() => dispatch({ type: "open-reader", bookId: book.id })}
          />
        </div>
      </div>

      <Tabs
        value={detailTab}
        onValueChange={(value) => dispatch({ type: "select-detail-tab", tab: value as DetailTab })}
        className="mt-8"
      >
        <TabsList data-testid="detail-tabs">
          <TabsTrigger value="overview" data-testid="detail-tab-overview">
            Overview
          </TabsTrigger>
          <TabsTrigger value="metadata" data-testid="detail-tab-metadata">
            Metadata
          </TabsTrigger>
          <TabsTrigger value="highlights" data-testid="detail-tab-highlights">
            Highlights
          </TabsTrigger>
          <TabsTrigger value="bookmarks" data-testid="detail-tab-bookmarks">
            Bookmarks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          {book.description && (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
              <p className="mt-2 text-sm leading-relaxed">{book.description}</p>
            </div>
          )}

          <div className="mt-8">
            <h3 className="text-sm font-medium text-muted-foreground">Subjects</h3>
            <div data-testid="detail-subjects" className="mt-2 flex flex-wrap gap-1.5">
              {subjects.length === 0 ? (
                <p className="text-sm text-muted-foreground">—</p>
              ) : (
                subjects.map((subject) => (
                  <Badge key={subject} variant="secondary">
                    {subject}
                  </Badge>
                ))
              )}
            </div>
          </div>

          <div className="mt-8">
            <h3 className="text-sm font-medium text-muted-foreground">Details</h3>
            <dl
              data-testid="detail-facts"
              className="mt-2 grid grid-cols-[8rem_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm"
            >
              {facts.map(([label, value]) => (
                <Fragment key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className={label === "File" ? "break-all" : undefined}>{value}</dd>
                </Fragment>
              ))}
            </dl>
          </div>

          <BookFileLocations
            book={book}
            files={files}
            onRemove={(fileId) => void removeFile(fileId)}
          />

          <div className="mt-8">
            <h3 className="text-sm font-medium text-muted-foreground">Collections</h3>
            <div data-testid="detail-collections" className="mt-2 flex flex-wrap gap-1.5">
              {memberCollections.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Not in any collection — add one from a book's right-click menu.
                </p>
              ) : (
                memberCollections.map((collection) => (
                  <Badge key={collection.id} variant="secondary">
                    {collection.name}
                  </Badge>
                ))
              )}
            </div>
          </div>

          <div className="mt-8">
            <h3 className="text-sm font-medium text-muted-foreground">Provider links</h3>
            <div data-testid="detail-providers" className="mt-2 flex flex-wrap gap-1.5">
              {(book.providerLinks ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Not linked to a reading service.</p>
              ) : (
                (book.providerLinks ?? []).map((link) => (
                  <Badge key={`${link.provider}:${link.remoteId}`} variant="secondary">
                    {providerLinkLabel(link)}
                  </Badge>
                ))
              )}
            </div>
          </div>

          <div className="mt-8">
            <h3 className="text-sm font-medium text-muted-foreground">Editions</h3>
            {editions.length === 0 ? (
              <p data-testid="detail-editions-empty" className="mt-2 text-sm text-muted-foreground">
                No other editions linked. If this is a different edition of a book you already read,
                link them so the progress percentage and provider link follow you.
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
                      <p className="truncate font-medium">
                        {edition.title?.trim() || "Unknown title"}
                      </p>
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
              Linked editions keep separate identities and annotations. A confirmed link copies
              progress as a percentage and moves the provider link and status to this edition.
            </p>
          </div>

          <div className="mt-8 rounded-md border p-4">
            <h3 className="text-sm font-medium">Reading data</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Reset clears progress, annotations, collections, metadata overrides, and provider
              links but keeps this book and its file. Forget moves them to the 30-day trash and
              rebinds the file to a fresh identity.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                data-testid="detail-reset"
                onClick={() => setResetOpen(true)}
              >
                Reset Reading Data…
              </Button>
              <Button
                size="sm"
                variant="destructive"
                data-testid="detail-forget"
                onClick={() => setForgetOpen(true)}
              >
                Forget Book…
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="metadata">
          <MetadataPanel book={book} curation={curation} />
        </TabsContent>

        <TabsContent value="highlights">
          <BookHighlightsPanel book={book} />
        </TabsContent>

        <TabsContent value="bookmarks">
          <BookBookmarksPanel book={book} />
        </TabsContent>
      </Tabs>

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
      <ResetBookDialog
        open={resetOpen}
        title={book.title}
        onConfirm={() => {
          setResetOpen(false);
          void resetReadingData(book.id);
        }}
        onCancel={() => setResetOpen(false)}
      />
      <ForgetBookDialog
        open={forgetOpen}
        count={1}
        keepsFile
        onConfirm={() => {
          setForgetOpen(false);
          void forgetBookFromLibrary(book.id);
          dispatch({ type: "return-to-library" });
        }}
        onCancel={() => setForgetOpen(false)}
      />
    </section>
  );
}
