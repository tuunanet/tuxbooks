describe("tuxbooks app shell", () => {
  it("launches the native window and shows the application shell", async () => {
    const shell = await $("[data-testid=app-shell]");
    await shell.waitForDisplayed({ timeout: 30000 });

    await expect($("[data-testid=sidebar]")).toBeDisplayed();
    const title = await browser.getTitle();
    expect(title.toLowerCase()).toContain("tuxbooks");
  });

  it("shows the empty library state when no books are imported", async () => {
    await expect($("[data-testid=empty-library]")).toBeDisplayed();
    await expect($("[data-testid=library-view]")).not.toExist();
  });

  it("navigates to settings and back to the library", async () => {
    const settingsButton = await $("button=Settings");
    await settingsButton.click();
    await expect($("[data-testid=settings-view]")).toBeDisplayed();

    const allBooksButton = await $("button=All Books");
    await allBooksButton.click();
    await expect($("[data-testid=empty-library]")).toBeDisplayed();
  });
});
