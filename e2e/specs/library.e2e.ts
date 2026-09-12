import { expect, test } from "../fixtures/electron-app.js";

/**
 * Empty-library suite (docs/TESTING.md phase "empty"): the real desktop
 * window launches and shows the application shell, the empty-library state,
 * and Settings navigation. This is also the Playwright harness smoke: a
 * launch + BrowserWindow + React query proves the fixture end to end.
 */
test.describe("tuxbooks app shell", () => {
  // Test A — the real desktop window launches headlessly and shows the
  // application shell.
  test("launches the native window and shows the application shell", async ({ page }) => {
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });

    await expect(page.locator('[aria-label="Library sidebar"]')).toBeVisible();
    await expect(page.locator('[aria-label="Library navigation"]')).toBeVisible();
    const title = await page.title();
    expect(title).toBe("TuxBooks");
  });

  test("shows the empty library state when no books are imported", async ({ page }) => {
    await expect(page.getByTestId("empty-library")).toBeVisible();
    await expect(page.getByTestId("library-view")).toHaveCount(0);
  });

  test("navigates to settings and back to the library", async ({ page }) => {
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();

    await page.getByRole("button", { name: "All Books" }).click();
    await expect(page.getByTestId("empty-library")).toBeVisible();
  });
});
