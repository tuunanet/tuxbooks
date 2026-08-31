/**
 * Shared helpers for the seeded-library spec files. WebKitGTK's WebDriver
 * getText walks the accessibility tree, which omits text inside
 * line-clamp/truncate boxes (book titles, reader title) — where those apply,
 * assert on DOM textContent (`textOf`) instead of toHaveText.
 */

export async function textOf(testId: string): Promise<string> {
  return browser.execute((id) => {
    const element = document.querySelector(`[data-testid=${JSON.stringify(id)}]`);
    return element ? (element.textContent ?? "") : "";
  }, testId);
}

export async function waitForLibraryView(): Promise<void> {
  // Re-query on every poll: a reference captured during startup can go
  // stale on WebKit when the library mounts, and isDisplayed would then
  // report false forever even though the view is on screen.
  await browser.waitUntil(
    async () => {
      const view = await $("[data-testid=library-view]");
      return (await view.isExisting()) && (await view.isDisplayed());
    },
    { timeout: 30000, timeoutMsg: "library view never became visible" },
  );
}

/**
 * Leave the reader if one is open, then wait for the library. Reader tests
 * are order-independent: a previous test may have left the reader open.
 */
export async function ensureLibrary(): Promise<void> {
  const reader = await $("[data-testid=reader-view]");
  if (await reader.isExisting()) {
    await $("[data-testid=reader-back]").click();
  }
  await waitForLibraryView();
}

/** Book cards expose `aria-label="{title} ({FORMAT})"` — open by name. */
export async function openBookDetail(ariaLabel: string): Promise<void> {
  await ensureLibrary();
  const card = await $(`[aria-label="${ariaLabel}"]`);
  await card.waitForDisplayed({ timeout: 30000 });
  await card.doubleClick();
  await $("[data-testid=book-detail]").waitForDisplayed({ timeout: 30000 });
}

/** Open a book's detail view and continue into the reader. */
export async function openInReader(ariaLabel: string): Promise<void> {
  await openBookDetail(ariaLabel);
  await $("[data-testid=detail-continue]").click();
  await $("[data-testid=reader-view]").waitForDisplayed({ timeout: 30000 });
}

/** Close the reader and wait for the library. */
export async function returnToLibrary(): Promise<void> {
  await $("[data-testid=reader-back]").click();
  await expect($("[data-testid=app-shell]")).toBeDisplayed();
  await waitForLibraryView();
}

/** DOM attributes of every PDF slot, in document order. */
export async function slotStates(): Promise<{ page: string; state: string }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-pdf-slot]")).map((slot) => ({
      page: slot.getAttribute("data-pdf-slot") ?? "",
      state: slot.getAttribute("data-render-state") ?? "",
    })),
  );
}

export async function renderedCount(): Promise<number> {
  return browser.execute(() => document.querySelectorAll('[data-render-state="rendered"]').length);
}

export async function waitForRendered(pageNumber: number, timeoutMs = 30000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(
        (page) =>
          document.querySelector(`[data-pdf-slot="${page}"]`)?.getAttribute("data-render-state"),
        pageNumber,
      );
      return state === "rendered";
    },
    { timeout: timeoutMs, timeoutMsg: `page ${pageNumber} never rendered` },
  );
}

/**
 * Scroll the reader's scroll container so slot `pageNumber` sits near the
 * top of the viewport. Offsets are derived from live element geometry, not
 * hard-coded pixels.
 */
export async function scrollToSlot(pageNumber: number): Promise<void> {
  await browser.execute((page) => {
    const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
    const slot = document.querySelector(`[data-pdf-slot="${page}"]`);
    if (!container || !slot) return;
    const target =
      slot.getBoundingClientRect().top +
      container.scrollTop -
      container.getBoundingClientRect().top -
      80;
    container.scrollTop = target;
  }, pageNumber);
}

/** Canvas-pixel probe shared by rendering assertions (mirrors books.e2e). */
export async function canvasIsNonBlank(pageNumber: number): Promise<boolean> {
  return browser.execute((page) => {
    const el = document.querySelector(`[data-testid=pdf-canvas][data-pdf-page="${page}"]`);
    if (!(el instanceof HTMLCanvasElement)) return false;
    const ctx = el.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return true;
    }
    return false;
  }, pageNumber);
}
