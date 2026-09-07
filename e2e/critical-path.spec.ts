import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// A tiny valid PNG (1x1 transparent pixel) used for asset import.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function projectHome(name: string) {
  return mkdtempSync(join(tmpdir(), `moka-e2e-${name}-`));
}

/** Open the launcher's create dialog and scaffold a new project. */
async function createProject(page: Page, directory: string, name: string) {
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Folder").fill(directory);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "New project" }).click();
  await expect(
    page.getByRole("banner").getByText(name, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
}

/** Double-click empty canvas and add a node of the given kind. */
async function addNode(page: Page, kind: string) {
  const surface = page.getByTestId("canvas-surface");
  const menu = page.getByRole("menu", { name: "Add node" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.dblclick(
      box!.x + box!.width * (0.55 + attempt * 0.08),
      box!.y + box!.height * 0.5,
    );
    if (await menu.isVisible({ timeout: 1500 }).catch(() => false)) {
      await menu.getByRole("menuitem", { name: kind, exact: true }).click();
      return;
    }
  }
  throw new Error(`quick-add menu did not open for ${kind}`);
}

/** Node count of the first canvas as persisted server-side. */
async function persistedNodeCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { canvas?: { nodes?: unknown[] }[] };
    };
    return (body.moka?.canvas?.[0]?.nodes ?? []).length;
  });
}

/** Open a recent project from the launcher by its card label. */
async function openRecent(page: Page, name: string) {
  await page
    .locator("button.launcher-recent")
    .filter({ hasText: name })
    .click();
}

/**
 * Leave the editor for the launcher. If a pending autosave raced the click,
 * the unsaved-work guard appears — resolve it by saving, like a user would.
 */
async function backToLauncher(page: Page) {
  await page.getByRole("button", { name: "Back to launcher" }).click();
  const guard = page.getByRole("alertdialog", { name: "Unsaved changes" });
  const guarded = await guard
    .waitFor({ state: "visible", timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (guarded) {
    await guard.getByRole("button", { name: "Save and close" }).click();
  }
  await expect(page.getByRole("heading", { name: "Moka Canvas" })).toBeVisible({
    timeout: 10_000,
  });
}

test("launcher boots, project persists across reload, and export/import roundtrips", async ({
  page,
}) => {
  const home = projectHome("flow");
  const root = join(home, "project");
  const importedRoot = join(home, "imported");

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Moka Canvas" }),
  ).toBeVisible();
  await expect(page.getByText("No projects yet")).toBeVisible();

  // Create a project and land in the editor.
  await createProject(page, root, "E2E Flow");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Add a text node via the quick-add menu.
  await addNode(page, "Text");
  const canvasList = page.getByRole("complementary").getByRole("list").first();
  await expect(canvasList.getByText("1 nodes · 0 edges")).toBeVisible();
  await expect(page.getByText("Added Text")).toBeVisible();
  await page.keyboard.press("Escape");
  // Autosave is debounced; wait for the server to hold the node before
  // reloading, otherwise the reload can beat the flush.
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  // Reload: the recent list offers the project, and reopening keeps the node.
  await page.reload();
  await openRecent(page, "E2E Flow");
  await expect(
    page.getByRole("banner").getByText("E2E Flow", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(canvasList.getByText("1 nodes · 0 edges")).toBeVisible();

  // Import an image asset through the resource panel.
  const importInput = page.getByLabel("Import files");
  await importInput.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(
    page.getByRole("button", { name: /^tiny\.png 70 B/ }),
  ).toBeVisible({ timeout: 10_000 });

  // Export a package.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const toast = page.getByText(/Exported \d+ files to /);
  await expect(toast).toBeVisible({ timeout: 10_000 });
  const destination = ((await toast.textContent()) ?? "").replace(
    /^.* to /,
    "",
  );
  expect(destination).toMatch(/\.mokapkg\.zip$/);

  // Back to the launcher, then import the package into a fresh directory.
  await backToLauncher(page);
  await page.getByRole("button", { name: "Import package" }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Folder").fill(importedRoot);
  await dialog.locator("input[type=file]").setInputFiles(destination as string);
  await dialog.getByRole("button", { name: "Import project package" }).click();
  await expect(
    page.getByRole("banner").getByText("E2E Flow", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(canvasList.getByText("1 nodes · 0 edges")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^tiny\.png 70 B/ }),
  ).toBeVisible();
});

test("missing asset surfaces the self-check dialog and blocks export", async ({
  page,
}) => {
  const home = projectHome("missing");
  // The server scaffolds the project under a slugified name subdirectory.
  const root = join(home, "project", "missing-asset");

  await page.goto("/");
  await createProject(page, join(home, "project"), "Missing Asset");

  const importInput = page.getByLabel("Import files");
  await importInput.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(
    page.getByRole("button", { name: /^tiny\.png 70 B/ }),
  ).toBeVisible({ timeout: 10_000 });

  // Export now to learn the asset's stored path, then leave to the launcher.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText(/Exported \d+ files to /)).toBeVisible({
    timeout: 10_000,
  });
  await backToLauncher(page);

  // Break the asset on disk, reopen: the self-check dialog must name it.
  const assetsDir = join(root, "assets", "images");
  for (const entry of readdirSync(assetsDir)) {
    rmSync(join(assetsDir, entry));
  }

  await openRecent(page, "Missing Asset");
  const dialog = page.locator(".dialog");
  await expect(
    dialog.getByRole("heading", { name: "Missing or changed assets" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    dialog.locator("li").filter({ hasText: "tiny.png" }).first(),
  ).toContainText("Missing · assets/images/");

  // Open anyway; export is blocked and offers the incomplete route.
  await dialog
    .getByRole("button", { name: "Open with missing assets" })
    .click();
  await expect(
    page.getByRole("banner").getByText("Missing Asset", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const blocked = page.locator(".dialog");
  await expect(
    blocked.getByRole("heading", { name: "Assets are missing" }),
  ).toBeVisible();
  await blocked.getByRole("button", { name: "Export anyway" }).click();
  await expect(page.getByText("flagged incomplete")).toBeVisible({
    timeout: 10_000,
  });
});
