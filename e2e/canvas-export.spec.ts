import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addNode, createProject, forgetProjects, projectHome } from "./helpers";

test("the canvas saves as a PNG of everything it holds", async ({ page }) => {
  await forgetProjects();
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("image-export"), "project"),
    "Image Export",
  );

  await addNode(page, "Text");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Export as image" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Canvas 1.png");

  const file = await download.path();
  const bytes = readFileSync(file!);
  // PNG signature, then the size the file declares: a picture of the diagram
  // rather than a blank canvas, and at twice the card's own pixels. A blank
  // canvas of the same size compresses to a fraction of this.
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(width).toBeGreaterThan(400);
  expect(height).toBeGreaterThan(200);
  expect(bytes.length).toBeGreaterThan(2000);
});
