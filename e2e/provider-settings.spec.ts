import { expect, test } from "@playwright/test";

// The derived identifier for "api.example.com", and the reference a default
// uses to reach a model through it.
const CHANNEL = "api-example-com";
const PAINTER = `${CHANNEL}::painter`;

/**
 * Provider configuration against the real metadata store.
 *
 * What a component test cannot show is that a channel written from the dialog
 * is still there after the page is thrown away, and that the whole path works
 * with no credential involved — no master key exists in this environment, so a
 * stored secret is deliberately out of scope here.
 */
test("a channel and its default survive a reload", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  // A fresh install already offers one channel, with no credential attached.
  const starter = dialog
    .locator(".channel")
    .filter({ hasText: "api.openai.com" });
  await expect(starter.getByText("No key stored")).toBeVisible();

  // The shortcut takes an address and derives the rest of the channel from it.
  await dialog
    .getByLabel("Provider address")
    .fill("https://api.example.com/v1");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  const row = dialog.locator(".channel").filter({ hasText: "api.example.com" });
  await expect(row.getByText("No key stored")).toBeVisible();
  await expect(row.getByText("openai", { exact: true })).toBeVisible();

  // The new channel brought no models, so nothing here can point at it. The
  // stored default itself is whatever earlier specs left behind — the whole
  // suite shares one metadata store.
  await dialog.getByRole("tab", { name: "Defaults" }).click();
  await expect(
    dialog.getByLabel("Image").locator('option[value^="api-example-com::"]'),
  ).toHaveCount(0);

  await dialog.getByRole("tab", { name: "Channels" }).click();
  await row.getByRole("button", { name: "Edit" }).click();
  await dialog.getByRole("button", { name: "Add model" }).click();
  await dialog.getByLabel("Model 1 identifier").fill("painter");
  await dialog.getByLabel("Model 1 capability").selectOption("image");
  await dialog.getByRole("button", { name: "Save channel" }).click();
  await expect(row.getByText(/1 model/)).toBeVisible();

  await dialog.getByRole("tab", { name: "Defaults" }).click();
  await dialog.getByLabel("Image").selectOption(PAINTER);
  const save = dialog.getByRole("button", { name: "Save defaults" });
  await save.click();
  await expect(save).toBeDisabled();

  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    dialog.locator(".channel").filter({ hasText: "api.example.com" }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Defaults" }).click();
  await expect(dialog.getByLabel("Image")).toHaveValue(PAINTER);
});
