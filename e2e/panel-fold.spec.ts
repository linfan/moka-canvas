import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import {
  createProject,
  forgetProjects,
  openRecent,
  projectHome,
} from "./helpers";

/** The corner a mark stands in, rounded to whole pixels of the window. */
async function cornerOf(mark: Locator) {
  const box = await mark.boundingBox();
  expect(box).not.toBeNull();
  return {
    x: Math.round(box!.x),
    y: Math.round(box!.y),
    right: Math.round(box!.x + box!.width),
  };
}

async function widthOf(column: Locator): Promise<number> {
  const box = await column.boundingBox();
  return box ? Math.round(box.width) : 0;
}

test("both columns fold away from a corner and come back to it", async ({
  page,
}) => {
  const home = projectHome("panel-fold");

  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Panel Fold");

  const canvas = page.getByTestId("canvas-host");
  const left = page.locator(".editor-side");
  const right = page.locator(".editor-right");
  const foldLeft = page.getByTestId("panel-fold-left");
  const foldRight = page.getByTestId("panel-fold-right");

  // Each column carries its fold in the corner it stands in: the left one at
  // the left edge of the window, the right one at the right edge of its column.
  await expect(foldLeft).toBeVisible();
  await expect(foldRight).toBeVisible();
  expect((await cornerOf(foldLeft)).x).toBe(0);
  const leftPanel = await left.boundingBox();
  expect((await cornerOf(foldLeft)).y).toBe(Math.round(leftPanel!.y));
  const rightPanel = await right.boundingBox();
  expect((await cornerOf(foldRight)).right).toBe(
    Math.round(rightPanel!.x + rightPanel!.width),
  );

  // The fold stands clear of the tabs beside it, which still answer to a click.
  await page.getByTestId("left-tab-assets").click();
  await expect(page.getByTestId("left-tab-assets")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByTestId("left-tab-project").click();
  await expect(page.getByTestId("left-tab-project")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const canvasBefore = await widthOf(canvas);

  // Folding a column away hands its room to the canvas and leaves the corner
  // it stood in offering the way back — the edge it was dragged by goes too,
  // since there is no longer a column there to drag.
  await foldLeft.click();
  await expect(left).toHaveCount(0);
  await expect(page.getByTestId("panel-resizer-left")).toHaveCount(0);
  await expect(foldLeft).toHaveCount(0);
  const unfoldLeft = page.getByTestId("panel-unfold-left");
  await expect(unfoldLeft).toBeVisible();
  const corner = await cornerOf(unfoldLeft);
  expect(corner.x).toBe(0);
  expect(corner.y).toBe(Math.round(leftPanel!.y));
  expect(await widthOf(canvas)).toBe(
    canvasBefore + Math.round(leftPanel!.width),
  );
  // The column on the other side was not asked about, so it still stands.
  await expect(right).toBeVisible();

  // The corner brings the column back, and its dragged edge comes with it.
  await unfoldLeft.click();
  await expect(left).toBeVisible();
  await expect(page.getByTestId("panel-resizer-left")).toBeVisible();
  await expect(foldLeft).toBeVisible();
  await expect(unfoldLeft).toHaveCount(0);

  // The column on the other side folds the same way round, into its own corner.
  await foldRight.click();
  await expect(right).toHaveCount(0);
  await expect(page.getByTestId("panel-resizer-right")).toHaveCount(0);
  const unfoldRight = page.getByTestId("panel-unfold-right");
  await expect(unfoldRight).toBeVisible();
  const body = await page.locator(".editor-body").boundingBox();
  expect((await cornerOf(unfoldRight)).right).toBe(
    Math.round(body!.x + body!.width),
  );

  // With both columns away the canvas has the whole row to itself.
  await foldLeft.click();
  await expect(left).toHaveCount(0);
  expect(await widthOf(canvas)).toBe(Math.round(body!.width));

  // What was folded away is remembered on this machine, so the editor opens
  // the same way round rather than asking for the columns again.
  await page.reload();
  await openRecent(page, "Panel Fold");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  await expect(left).toHaveCount(0);
  await expect(right).toHaveCount(0);
  await expect(page.getByTestId("panel-unfold-left")).toBeVisible();
  await expect(page.getByTestId("panel-unfold-right")).toBeVisible();

  // And one click on a corner stands the column back up.
  await page.getByTestId("panel-unfold-left").click();
  await expect(left).toBeVisible();
  await expect(page.getByTestId("panel-fold-left")).toBeVisible();
});
