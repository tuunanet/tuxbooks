import { Fragment, useState } from "react";
import { ArrowLeft, BookOpen, FileWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookCover } from "./BookCover";
import { BookBookmarksPanel } from "./BookBookmarksPanel";
import { ForgetBookDialog } from "./ForgetBookDialog";
import { BookHighlightsPanel } from "./BookHighlightsPanel";
import { MetadataPanel } from "./MetadataPanel";
import { ResetBookDialog } from "./ResetBookDialog";
import { useBookActions } from "@/hooks/useBookActions";
import { useBookFiles } from "@/hooks/useBookFiles";
import { useBookMetadata } from "@/hooks/useBookMetadata";
import { useLibrary } from "@/hooks/useLibrary";
import { sectionTitle } from "@/components/library/sections";
import { useAppDispatch, useAppState, type DetailTab } from "@/state/appState";
import type { BookFile } from "@/lib/bridge";
import { formatMb } from "@/lib/format";
import { providerLinkLabel } from "@/lib/providers";

/** ISO dates render deterministically in UTC so tests and locales agree. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** Exact-enough sizes; a small EPUB must not read as "0.0 MB". */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return formatMb(bytes);
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
  const { books, collections } = useLibrary();
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
  const subjects = curation.metadata?.effective.subjects ?? [];
  const memberCollections =
    book === null ? [] : collections.filter((collection) => collection.bookIds.includes(book.id));

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

  // Before the locations query resolves, the active file from `list_books`
  // is the one fact the details already know. The fallback keeps the path
  // visible without pretending a second copy exists.
  const locations: BookFile[] =
    files.length > 0
      ? files
      : [
          {
            id: -1,
            path: book.path,
            available: book.available,
            fileSize: book.fileSize,
            fileMtime: book.fileMtime,
            addedAt: book.addedAt,
            active: true,
          },
        ];
  const removeFile = async (fileId: number) => {
    if (await removeCopy(book.id, fileId)) await refreshFiles();
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

          <div className="mt-4 flex flex-wrap gap-2">
            {!book.available ? (
              // Missing file: recovery replaces the reading entry point. The
              // row survives on the backend, so reconnecting keeps progress.
              <div
                data-testid="detail-missing"
                className="w-full rounded-md border border-destructive/50 bg-destructive/10 p-3"
              >
                <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <FileWarning data-icon="inline-start" className="size-4" />
                  File unavailable
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  The source file is missing at its recorded location. Locate it to keep this book's
                  reading progress, or remove it from the library.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    data-testid="detail-locate"
                    onClick={() => void locateBook(book.id)}
                  >
                    Locate File…
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="detail-remove"
                    onClick={() => void removeBookFromLibrary(book.id)}
                  >
                    Remove from Library
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                data-testid="detail-continue"
                onClick={() => dispatch({ type: "open-reader", bookId: book.id })}
              >
                <BookOpen data-icon="inline-start" />
                Continue Reading
              </Button>
            )}
          </div>
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

          <div className="mt-8">
            <h3 className="text-sm font-medium text-muted-foreground">File locations</h3>
            <ul
              data-testid="detail-file-locations"
              className="mt-2 divide-y rounded-lg border text-sm"
            >
              {locations.map((file) => (
                <li
                  key={file.id}
                  data-testid={`detail-file-${file.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <code className="block break-all text-xs text-muted-foreground">
                      {file.path}
                    </code>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {file.active && (
                        <Badge
                          variant="secondary"
                          data-testid={`detail-file-active-${file.id}`}
                          className="text-[10px]"
                        >
                          Reading from
                        </Badge>
                      )}
                      {file.available ? (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatFileSize(file.fileSize)}
                        </span>
                      ) : (
                        <Badge variant="destructive" className="text-[10px]">
                          Missing
                        </Badge>
                      )}
                    </div>
                  </div>
                  {locations.length > 1 && file.id > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid={`detail-file-remove-${file.id}`}
                      onClick={() => void removeFile(file.id)}
                    >
                      Remove copy
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {locations.length > 1 && (
              <p className="mt-2 text-xs text-muted-foreground">
                These copies share progress, annotations, and collections. Removing one keeps the
                book and your reading data; the file on disk is never touched.
              </p>
            )}
          </div>

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
