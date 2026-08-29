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

  it("navigates between sidebar views", async () => {
    const collectionsButton = await $("button=Collections");
    await collectionsButton.click();
    await expect($("[data-testid=collections-view]")).toBeDisplayed();

    const libraryButton = await $("button=Library");
    await libraryButton.click();
    await expect($("[data-testid=empty-library]")).toBeDisplayed();
  });
});
