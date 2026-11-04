import { expect, test, type Page } from "../fixtures/electron-app.js";
import { readdirSync } from "node:fs";

import { SCALE_CORPUS_SIZE, scaleCorpusDir } from "../setup/environment.js";
import { ensureLibrary } from "./helpers.js";

/**
 * Bulk Forget at scale (PERF-18, tuxbooks bulk-forget nibble): Forget of a
 * whole Reading history rides several bounded forget_books invokes, each of
 * which runs for a while while emitting one library-changed event per book.
 * Two regressions bit real users here: a total-deadline sidecar timeout
 * abandoned healthy chunks mid-flight (partial nibbles + an error banner),
 * and one uncoalesced reload per event queued thousands of list queries
 * behind the sidecar's write loop. This spec drives the real UI flow at
 * corpus scale and demands both stay fixed: no banner, everything forgotten.
 *
 * Runs after z-library-scale (alphabetical), which imports the corpus into
 * the library; standalone runs import it themselves.
 *
 * The 300 s per-test bound sits inside the phase's 600 s wrapper (docs/
 * TESTING.md): the flow (import-if-needed, ~1,500 membership removals, two
 * bulk chunks) settles well inside it on CI hardware, and the assertion
 * windows below are 200 s and 30 s.
 */
function corpusReady(): boolean {
  try {
    return readdirSync(scaleCorpusDir).length >= SCALE_CORPUS_SIZE;
  } catch {
    return false;
  }
}

async function invoke<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ([name, args]) =>
      (
        window as unknown as {
          tuxbooks: { invoke(name: string, params: unknown): Promise<unknown> };
        }
      ).tuxbooks.invoke(name as string, args),
    [method, params] as [string, Record<string, unknown>],
  ) as Promise<T>;
}

interface Book {
  id: number;
  title: string;
}

test.describe("Reading history bulk Forget at scale", () => {
  test.skip(!corpusReady(), "scale corpus not generated (python3 missing or generation failed)");

  test("forgets the whole corpus without a partial failure", async ({ page }) => {
    await test.setTimeout(300_000);
    await ensureLibrary(page);

    // Bring the corpus into the library when this is a standalone run; when
    // z-library-scale ran first they are already there.
    let corpus = (await invoke<Book[]>(page, "list_books", {})).filter((book) =>
      /#\d{4}$/.test(book.title),
    );
    if (corpus.length < SCALE_CORPUS_SIZE) {
      await invoke(page, "import_paths", { paths: [scaleCorpusDir] });
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        corpus = (await invoke<Book[]>(page, "list_books", {})).filter((book) =>
          /#\d{4}$/.test(book.title),
        );
        if (corpus.length >= SCALE_CORPUS_SIZE) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    expect(corpus.length).toBeGreaterThanOrEqual(SCALE_CORPUS_SIZE);

    // End every corpus book's library membership: each becomes a durable
    // Reading history row, exactly the state a user's stale fixture folder
    // leaves behind.
    for (const book of corpus) {
      await invoke(page, "remove_book", { bookId: book.id });
    }

    await page.getByRole("button", { name: "Reading history" }).click();
    await expect(page.getByTestId("reading-history-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("reading-history-count")).toHaveText(
      `${SCALE_CORPUS_SIZE} books`,
      { timeout: 30_000 },
    );

    await page.getByTestId("reading-history-select-all").click();
    await page.getByTestId("reading-history-forget-selected").click();
    await page.getByTestId("forget-book-confirm").click();

    // The run may take minutes; the banner must never appear and the count
    // must reach zero, which only happens when every chunk completed.
    let banner = "";
    const deadline = Date.now() + 200_000;
    while (Date.now() < deadline) {
      const current = await page
        .getByTestId("reading-history-error")
        .innerText()
        .catch(() => "");
      if (current !== "") banner = current;
      const count = await page
        .getByTestId("reading-history-count")
        .innerText()
        .catch(() => "");
      if (count === "0 books" && banner === "") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(banner, "the error banner must never appear").toBe("");
    await expect(page.getByTestId("reading-history-count")).toHaveText("0 books", {
      timeout: 30_000,
    });
  });
});
