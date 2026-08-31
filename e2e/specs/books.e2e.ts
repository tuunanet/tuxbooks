describe("tuxbooks library import", () => {
  // WebKitGTK's WebDriver getText walks the accessibility tree, which omits
  // text inside line-clamp/truncate boxes (book titles, reader title). Where
  // those classes apply, assert on DOM textContent instead of toHaveText.

  async function textOf(testId: string): Promise<string> {
    return browser.execute((id) => {
      const element = document.querySelector(`[data-testid=${JSON.stringify(id)}]`);
      return element ? (element.textContent ?? "") : "";
    }, testId);
  }

  it("imports the test library on startup and displays the book", async () => {
    // Re-query on every poll: a reference captured during startup can go
    // stale on WebKit when the library mounts, and isDisplayed would then
    // report false forever even though the card is on screen.
    await browser.waitUntil(
      async () => {
        const card = await $("[data-testid=book-card]");
        return (await card.isExisting()) && (await card.isDisplayed());
      },
      { timeout: 30000, timeoutMsg: "book card never became visible" },
    );

    const cardText = await textOf("book-card");
    await expect(cardText).toContain("A Minimal Book");
    await expect(cardText).toContain("Ada Lovelace");
  });

  it("shows the library stats reported by the backend", async () => {
    const stats = await $("[data-testid=library-stats]");
    await stats.waitForDisplayed({ timeout: 30000 });
    await expect(stats).toHaveText(expect.stringContaining("1 book"));
  });

  it("opens the book detail from the library and returns", async () => {
    const card = await $("[data-testid=book-card]");
    await card.waitForDisplayed({ timeout: 30000 });

    await card.doubleClick();
    const detail = await $("[data-testid=book-detail]");
    await detail.waitForDisplayed({ timeout: 30000 });
    await expect(detail).toHaveText(expect.stringContaining("A Minimal Book"));

    await $("[data-testid=detail-back]").click();
    await expect($("[data-testid=library-view]")).toBeDisplayed();
  });

  it("enters the reader from the detail view with the sidebar hidden", async () => {
    const card = await $("[data-testid=book-card]");
    await card.waitForDisplayed({ timeout: 30000 });

    await card.doubleClick();
    await $("[data-testid=book-detail]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=detail-continue]").click();

    const reader = await $("[data-testid=reader-view]");
    await reader.waitForDisplayed({ timeout: 30000 });
    await expect(await textOf("reader-title")).toContain("A Minimal Book");
    await expect($("[data-testid=sidebar]")).not.toExist();

    await $("[data-testid=reader-back]").click();
    await expect($("[data-testid=app-shell]")).toBeDisplayed();
    await expect($("[data-testid=sidebar]")).toBeDisplayed();
  });
});
