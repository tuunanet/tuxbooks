import { expect, test } from "../fixtures/electron-app.js";

/**
 * Settings > Application Data: the storage-root "Copy path" action routes
 * through the main process and Electron's clipboard. The renderer's own
 * `navigator.clipboard` write is denied by the permission policy (X-4), so
 * the real proof is that Electron's clipboard holds the resolved path.
 */
test.describe("settings data tab", () => {
  test("copies a storage root path through the main process clipboard", async ({
    page,
    electronApp,
  }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await page.getByRole("button", { name: "Application Data" }).click();

    const root = page.getByTestId("storage-root-app-data");
    await expect(root).toBeVisible();
    const expected = ((await page.getByTestId("storage-path-app-data").textContent()) ?? "").trim();
    expect(expected.length).toBeGreaterThan(0);

    await root.hover();
    await root.getByRole("button", { name: "Copy path" }).click();
    await expect(root.getByRole("button", { name: "Copied" })).toBeVisible();

    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(expected);
  });

  test("copies diagnostics to the clipboard", async ({ page, electronApp }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await page.getByRole("button", { name: "Application Data" }).click();
    await expect(page.getByTestId("storage-diagnostics")).toBeVisible();

    await page.getByTestId("copy-diagnostics").click();
    await expect(page.getByTestId("copy-diagnostics-result")).toHaveText("Copied");

    const raw = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    const copied = JSON.parse(raw || "null") as Record<string, unknown>;
    // The whole support snapshot, in the pretty-printed form the button sends.
    expect(Object.keys(copied)).toEqual(
      expect.arrayContaining([
        "generatedAt",
        "sync",
        "hashFailed",
        "openConflicts",
        "recentMerges",
        "versions",
      ]),
    );
    expect(raw).toContain("\n  ");
    expect(copied.sync).toHaveProperty("enabled");
    expect(copied.versions).toHaveProperty("dbMigration");
  });
});
