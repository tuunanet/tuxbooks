import { expect, test } from "../fixtures/electron-app.js";

/**
 * Settings > Sync: an unconfigured profile shows the connect affordance and
 * does not touch the network or a sync folder until the user picks one.
 */
test.describe("settings sync tab", () => {
  test("shows the disconnected state", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await page.getByRole("button", { name: "Sync" }).click();

    await expect(page.getByTestId("sync-settings")).toBeVisible();
    await expect(page.getByTestId("sync-connect")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sync folder" })).toBeVisible();
    await expect(page.getByText("Syncs between machines")).toBeVisible();
    await expect(page.getByText("Book files themselves")).toBeVisible();
    await expect(
      page.getByText(/Saving metadata into a book file rewrites that file/i),
    ).toBeVisible();
  });

  test("explains that a watched folder can live on a network path or in a cloud folder", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Watched folders" }).click();

    const hint = page.getByTestId("folders-cloud-hint");
    await expect(hint).toContainText("local, on a network path, or one your cloud client keeps in");
    await expect(hint).toContainText("Settings > Sync");
  });
});
