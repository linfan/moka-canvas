import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  forgetProjects,
  newTimeline,
  openClipRoom,
  openRecent,
  persistedTimelineNames,
  projectHome,
} from "./helpers";

/**
 * The cutting room stands on its own feet.
 *
 * A project with no timeline opens onto the first-run question, timelines are
 * added, switched, renamed and taken away through the strip, and the corner
 * menu walks between the two working pages without putting the project down:
 * what the room holds is in the document, and what it remembers is on the
 * machine, and both survive a reload in their own way.
 */

async function clippedProject(page: Page) {
  const home = projectHome("clip-room");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Cutting Room");
  await openClipRoom(page);
  return home;
}

/** The strip of timelines, apart from the rail of faces beside the stage. */
function strip(page: Page) {
  return page.getByRole("tablist", { name: "Timelines" });
}

test("a project without timelines opens onto the first-run question", async ({
  page,
}) => {
  const home = await clippedProject(page);

  await expect(page.getByText("No timelines yet")).toBeVisible();
  await expect(
    page.getByText("Create a timeline to start cutting."),
  ).toBeVisible();
  await expect(strip(page).getByRole("tab")).toHaveCount(0);

  await newTimeline(page, "Timeline 1");

  // The tab that arrives is the one being looked at, and the first-run
  // question has given way to the empty cut it stood in for.
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No timelines yet")).toHaveCount(0);
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  // The preview stands on the empty cut: the frame the playhead will be read
  // against, and the timecode at the head it has not moved off yet.
  await expect(page.locator("canvas.clip-preview-canvas")).toBeVisible();
  await expect(page.getByTestId("preview-timecode")).toHaveText("00:00:00:00");

  rmSync(home, { recursive: true, force: true });
});

test("a second timeline joins the strip, and the machine remembers the one being read", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");
  await newTimeline(page, "Timeline 2");

  await expect(strip(page).getByRole("tab")).toHaveCount(2);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 2" }),
  ).toHaveAttribute("aria-selected", "true");

  // Switching turns the strip over without touching the document.
  await strip(page).getByRole("tab", { name: "Timeline 1" }).click();
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 2" }),
  ).toHaveAttribute("aria-selected", "false");

  // A double-click renames the tab in place, and Enter takes the words.
  await strip(page).getByRole("tab", { name: "Timeline 2" }).dblclick();
  const field = page.getByRole("textbox", { name: "Rename Timeline 2" });
  await field.fill("Second cut");
  await field.press("Enter");
  await expect(
    strip(page).getByRole("tab", { name: "Second cut" }),
  ).toHaveAttribute("aria-selected", "true");

  // The rename is the timeline being looked at, and it is written down before
  // the page is read again.
  await expect
    .poll(async () => persistedTimelineNames(page))
    .toContain("Second cut");

  await page.reload();
  await openRecent(page, "Cutting Room");
  await openClipRoom(page);

  // The project opens onto the timeline this machine was left on.
  await expect(
    strip(page).getByRole("tab", { name: "Second cut" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "false");

  rmSync(home, { recursive: true, force: true });
});

test("a timeline is taken off the strip, and the room asks again when none is left", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");
  await newTimeline(page, "Timeline 2");

  // An empty timeline is a tab and nothing else: one click takes it away, and
  // the timeline beside it takes the view.
  await page.getByRole("button", { name: "Delete Timeline 2" }).click();
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 2" }),
  ).toHaveCount(0);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Delete Timeline 1" }).click();
  await expect(strip(page).getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No timelines yet")).toBeVisible();

  rmSync(home, { recursive: true, force: true });
});

test("the corner menu marks the cutting room, and the board is one step beside it", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");

  await page.getByRole("button", { name: "Home menu" }).click();
  const menu = page.getByTestId("home-menu");
  await expect(menu.getByRole("menuitem", { name: "Clip" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    menu.getByRole("menuitem", { name: "Canvas" }),
  ).not.toHaveAttribute("aria-current", "page");

  await menu.getByRole("menuitem", { name: "Canvas" }).click();
  await expect(page.getByTestId("canvas-host")).toBeVisible({
    timeout: 10_000,
  });

  // Back through the same menu: the project was never put down, and the cut
  // that was made here is still in it.
  await openClipRoom(page);
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toBeVisible();
  await expect(
    strip(page).getByRole("tab", { name: "Timeline 1" }),
  ).toHaveAttribute("aria-selected", "true");

  rmSync(home, { recursive: true, force: true });
});

test("a new timeline reaches the project on its own, and the badge says so", async ({
  page,
}) => {
  const home = await clippedProject(page);
  await newTimeline(page, "Timeline 1");

  // The autosave debounce carries the command to the server without a Save
  // button being anywhere, and the badge settles on the word for it.
  await expect
    .poll(async () => persistedTimelineNames(page))
    .toEqual(["Timeline 1"]);
  await expect(page.locator(".save-status")).toHaveText("Saved", {
    timeout: 10_000,
  });

  rmSync(home, { recursive: true, force: true });
});
