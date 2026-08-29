describe("tuxbooks library import", () => {
  it("imports the test library on startup and displays the book", async () => {
    const card = await $("[data-testid=book-card]");
    await card.waitForDisplayed({ timeout: 30000 });

    await expect(card).toHaveText(expect.stringContaining("A Minimal Book"));
    await expect(card).toHaveText(expect.stringContaining("Ada Lovelace"));
  });

  it("shows the library stats reported by the backend", async () => {
    const stats = await $("[data-testid=library-stats]");
    await stats.waitForDisplayed({ timeout: 30000 });
    await expect(stats).toHaveText(expect.stringContaining("1 book"));
  });
});
