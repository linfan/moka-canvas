import { expect, test } from "@playwright/test";
import { forgetProjects } from "./helpers";

// The browser is asked for English in playwright.config.ts, so the machine
// language resolves to English and the interface starts in it.
test("the interface follows the language chosen in settings", async ({
  page,
}) => {
  await forgetProjects();
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Moka Canvas" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Moka Canvas");

  // Pick Chinese in the interface's own settings screen.
  await page.getByTestId("launcher-settings").click();
  const settings = page.getByRole("dialog");
  await settings.locator("#settings-toptab-system").click();
  await settings.getByLabel("Interface language").selectOption("zh");

  // The tab's title and the page's name change with the language.
  await expect(page).toHaveTitle("摩卡画布");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "摩卡画布" })).toBeVisible();

  // And back: a language picked outright is not a trap.
  await page.getByTestId("launcher-settings").click();
  await settings.locator("#settings-toptab-system").click();
  await settings.getByLabel("界面语言").selectOption("en");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Moka Canvas" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Moka Canvas");
});
