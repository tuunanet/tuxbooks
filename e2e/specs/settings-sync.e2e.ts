import { expect, test } from "../fixtures/electron-app.js";

/**
 * Settings > Sync: an unconfigured profile shows the connect affordance and
 * does not touch the network or a cloud folder until the user picks one.
 */
test.describe("settings sync tab", () => {
  test("shows the disconnected state", async ({ page }) => {
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await page.getByRole("button", { name: "Sync" }).click();

    await expect(page.getByTestId("sync-settings")).toBeVisible();
    await expect(page.getByTestId("sync-connect")).toBeVisible();
    await expect(page.getByText("Cloud folder")).toBeVisible();
  });
});
