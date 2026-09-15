import { expect, test } from "@playwright/test";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createProject, projectHome } from "./helpers";

/** The viewport of the first canvas as persisted server-side. */
async function persistedViewport(
  page: Page,
): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        canvas?: { viewport?: { x: number; y: number; zoom: number } }[];
      };
    };
    return body.moka?.canvas?.[0]?.viewport ?? { x: 0, y: 0, zoom: 1 };
  });
}

test("a Ctrl-held click moves the canvas and does not ask for the menu", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("temporary-tool"), "pan"),
    "Ctrl Pan",
  );

  const surface = page.getByTestId("canvas-surface");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const middle = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  };

  const before = await persistedViewport(page);

  // Ctrl down borrows the pan tool, and the click that follows is a hand on
  // the canvas rather than a question for it: no menu comes up, and the drag
  // moves the canvas.
  await page.keyboard.down("Control");
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 100, middle.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole("menu", { name: "Context menu" })).toBeHidden();
  await page.keyboard.up("Control");

  await expect
    .poll(
      async () => Math.round(before.x - (await persistedViewport(page)).x),
      { timeout: 10_000 },
    )
    .toBe(100);

  // A real right button still asks for the menu, Ctrl or no Ctrl.
  await page.mouse.click(middle.x, middle.y, { button: "right" });
  await expect(page.getByRole("menu", { name: "Context menu" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Context menu" })).toBeHidden();
});
