import { expect, test } from "@playwright/test";
import { forgetProjects, projectHome } from "./helpers";

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

  // A project made in Chinese carries Chinese words: the scaffold's first
  // canvas is named by the interface that made it.
  await page.getByRole("button", { name: "新建项目" }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("文件夹").fill(projectHome("i18n"));
  await dialog.getByLabel("项目名称").fill("中文项目");
  await dialog.getByRole("button", { name: "新建项目" }).click();
  await expect(page.getByTestId("canvas-tab-画布 1")).toBeVisible({
    timeout: 10_000,
  });

  // Back through the launcher to put the language back: a language picked
  // outright is not a trap.
  await page.getByTestId("home-menu-button").click();
  await page.getByRole("menuitem", { name: "主页" }).click();
  await expect(page.getByRole("heading", { name: "摩卡画布" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("launcher-settings").click();
  await settings.locator("#settings-toptab-system").click();
  await settings.getByLabel("界面语言").selectOption("en");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Moka Canvas" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Moka Canvas");
});
