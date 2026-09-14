import { join } from "node:path";
import { rmSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import {
  createProject,
  forgetProjects,
  projectHome,
  showAssets,
} from "./helpers";

// A tiny valid PNG (1x1 transparent pixel), imported three times under three
// names so the shelf has a few rows to be measured by.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** How tall something is on screen, in whole pixels. */
async function heightOf(what: Locator): Promise<number> {
  const box = await what.boundingBox();
  expect(box).not.toBeNull();
  return Math.round(box!.height);
}

/** Where something ends on screen, in whole pixels from the top. */
async function bottomOf(what: Locator): Promise<number> {
  const box = await what.boundingBox();
  expect(box).not.toBeNull();
  return Math.round(box!.y + box!.height);
}

/**
 * The shelf is as tall as what it holds, and no taller.
 *
 * The column hands its assets face all the room below the tabs, and a stack
 * left to itself shares leftover room out between its rows instead of leaving
 * it blank below the last of them — which read as a panel where the head, the
 * kind tabs, the search and every file were each padded out to twice their
 * height, with the padding growing the emptier the shelf was.
 */
test("the shelf leaves its leftover room blank below the last file", async ({
  page,
}) => {
  const home = projectHome("shelf");
  await forgetProjects();
  await page.goto("/");
  await page.setViewportSize({ width: 1280, height: 720 });
  await createProject(page, join(home, "project"), "Shelf Spacing");

  await showAssets(page);
  const shelf = page.locator(".side-resources");
  const input = page.getByLabel("Import files", { exact: true });
  for (const name of ["one.png", "two.png", "three.png"]) {
    await input.setInputFiles({
      name,
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    await expect(
      page.getByRole("button", { name: new RegExp(`^${name} `) }),
    ).toBeVisible({ timeout: 10_000 });
  }

  const rows = page.locator(".side-resource-list li");
  await expect(rows).toHaveCount(3);

  // Three small files are read without scrolling, and what the column has left
  // over stays at the bottom of it rather than being shared into the rows.
  const tall = await heightOf(shelf);
  const leftOver =
    (await bottomOf(shelf)) -
    (await bottomOf(page.locator(".side-resource-group").last()));
  expect(leftOver).toBeGreaterThan(tall * 0.2);

  // Each part of the panel keeps the height its own content asks for: the head
  // is one row of small buttons, the kinds are one row of tabs, and a file is a
  // thumbnail with two lines beside it. Stretched, these read 110, 112 and 76.
  expect(await heightOf(page.locator(".side-resources-head"))).toBeLessThan(40);
  expect(await heightOf(page.locator(".side-asset-kinds"))).toBeLessThan(40);
  for (const row of await rows.all()) {
    expect(await heightOf(row)).toBeLessThan(90);
  }

  rmSync(home, { recursive: true, force: true });
});
