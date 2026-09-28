import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  configureTheWholeStudio,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";

/**
 * The fourth step: one episode's board, its frames and its clip.
 *
 * A whole telling is taken as far as the board the last step needs: the premise
 * becomes chapters, the chapters become a cast, the cast is drawn and agreed
 * to, and then one episode is boarded, framed, and filmed.
 */

/** What the server holds of the first story's first act. */
async function persistedBoard(page: Page): Promise<{
  acts: number;
  frames: number;
  drawn: number;
  clips: number;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            acts?: {
              keyframes?: { art?: { takes?: unknown[] } }[];
              video?: { takes?: unknown[] };
            }[];
          }[];
        }[];
      };
    };
    const acts = (body.moka?.stories?.[0]?.chapters ?? []).flatMap(
      (chapter) => chapter.acts ?? [],
    );
    return {
      acts: acts.length,
      frames: acts.flatMap((act) => act.keyframes ?? []).length,
      drawn: acts
        .flatMap((act) => act.keyframes ?? [])
        .filter((keyframe) => (keyframe.art?.takes ?? []).length > 0).length,
      clips: acts.filter((act) => (act.video?.takes ?? []).length > 0).length,
    };
  });
}

test("an episode is boarded, framed, and filmed", async ({ page }) => {
  const home = projectHome("story-storyboard");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Board");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // A premise, the chapters it is told in, and the cast they hold.
    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-idea-next").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.getByTestId("story-outline-confirm-all").click();

    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await page.getByTestId("story-elements-draw-all").click();
    await expect(page.getByTestId("story-elements-views-all")).toBeEnabled({
      timeout: 60_000,
    });
    await page.getByTestId("story-elements-views-all").click();
    // The four views have to be back before anything is agreed to: an element
    // agreed to while its sheet is still being drawn is one whose sheet is not
    // part of the answer, and the board would stay shut.
    await expect(
      page
        .getByTestId("story-element-character-Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("story-elements-confirm-all")).toBeEnabled();
    await page.getByTestId("story-elements-confirm-all").click();
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled({
      timeout: 30_000,
    });

    // Step four: the episode the room opens on is boarded.
    await page.getByTestId("story-step-storyboard").click();
    await expect(page.getByTestId("story-step-body-storyboard")).toBeVisible();
    await expect(page.getByTestId("story-board-empty")).toBeVisible();
    await page.getByTestId("story-board-generate").click();

    // Every act of the board stands on the page at once, and a row's name is
    // its place within its own act — so each card is looked at on its own.
    const firstAct = page.getByTestId("story-act-0");
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("story-act-1")).toBeVisible();
    await expect(firstAct.getByTestId("story-kf-0")).toBeVisible();

    // The cell shows the ask as it will be sent: the name the words mention
    // stands as a chip, and the picture it calls in stands under them.
    await expect(
      firstAct.getByTestId("story-kf-content-0").locator("[data-mention-name]"),
    ).toHaveText("Keeper");
    await expect(firstAct.getByTestId("story-kf-ref-0-0")).toBeVisible();

    // Nothing is drawn until the table has been agreed to, and the button that
    // agrees to it stands with the pictures' own asks, under the table: a board
    // nobody agreed to has no way on from it.
    await expect(firstAct.getByTestId("story-act-draw-0")).toBeDisabled();
    await expect(firstAct.getByTestId("story-act-draw-0")).toHaveAttribute(
      "title",
      "Agree to the table first",
    );
    await firstAct.getByTestId("story-act-keys-0").click();
    await expect(firstAct.getByTestId("story-act-draw-0")).toBeEnabled();
    await expect(firstAct.getByTestId("story-act-keys-on-0")).toHaveText(
      "Table agreed to ✓",
    );

    // Taking it back is the reader's own step, and taking it back is said in
    // plain words rather than by a button called "change it": the words of the
    // table are the reader's again until it is agreed to once more.
    await expect(firstAct.getByTestId("story-act-unlock-0")).toHaveText(
      "Unconfirm",
    );
    await firstAct.getByTestId("story-act-unlock-0").click();
    await expect(firstAct.getByTestId("story-kf-size-0")).toBeEnabled();
    await expect(firstAct.getByTestId("story-act-draw-0")).toBeDisabled();
    await firstAct.getByTestId("story-act-keys-0").click();
    await expect(firstAct.getByTestId("story-kf-size-0")).toBeDisabled();

    /** How wide a cell of the framing row stands, in whole pixels. */
    const widthOf = async (testId: string) => {
      const box = await firstAct.getByTestId(testId).boundingBox();
      return Math.round(box?.width ?? -1);
    };

    // One frame of the act, drawn from the cast step three settled on, while
    // its own ask is the only thing that waits on it.
    await firstAct.getByTestId("story-kf-slot-0-generate").click();
    await expect(firstAct.getByTestId("story-kf-slot-0-confirm")).toBeVisible({
      timeout: 60_000,
    });

    // A drawn frame's own size must not push the framing columns aside: with
    // the picture in place the selects still hold their words whole, and the
    // frame itself stays a peek rather than widening the row.
    expect(await widthOf("story-kf-size-0")).toBeGreaterThan(80);
    expect(await widthOf("story-kf-move-0")).toBeGreaterThan(80);
    expect(await widthOf("story-kf-angle-0")).toBeGreaterThan(80);
    expect(await widthOf("story-kf-slot-0")).toBeLessThanOrEqual(160);
    await expect(
      firstAct.getByTestId("story-kf-slot-1-generate"),
    ).toBeEnabled();
    await firstAct.getByTestId("story-kf-slot-0-confirm").click();

    // The rest of the act at once, and then the act's own button: one press
    // agrees to every frame of the act, with the second frame never agreed to
    // by hand — the pictures have to be there, not their agreements.
    await firstAct.getByTestId("story-act-draw-0").click();
    await expect(firstAct.getByTestId("story-kf-slot-1-confirm")).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      firstAct.getByTestId("story-act-images-confirm-0"),
    ).toBeEnabled();
    await firstAct.getByTestId("story-act-images-confirm-0").click();
    await expect(
      firstAct.getByTestId("story-act-images-unconfirm-0"),
    ).toBeVisible();

    // And the clip itself, which the stand-in's job hands back at once.
    await expect(firstAct.getByTestId("story-act-video-go-0")).toBeEnabled();
    await firstAct.getByTestId("story-act-video-go-0").click();
    await expect(firstAct.getByTestId("story-act-video-0")).toBeVisible({
      timeout: 60_000,
    });

    // The fifth step's door waits on that clip being agreed to.
    await firstAct.getByTestId("story-act-video-confirm-0").click();
    await expect(page.getByTestId("story-step-edit")).toBeEnabled();

    // A clip is not the last word: the ask that made it stands beside the
    // take, and asking again plays a fresh one in its place.
    const played = firstAct.getByTestId("story-act-video-0").locator("video");
    const wasPlaying = await played.getAttribute("src");
    await expect(firstAct.getByTestId("story-act-video-again-0")).toHaveText(
      "Ask for another",
    );
    await firstAct.getByTestId("story-act-video-again-0").click();
    await expect.poll(() => played.getAttribute("src")).not.toBe(wasPlaying);
    await expect(firstAct.getByTestId("story-act-video-again-0")).toBeEnabled();

    // The document is read back off the server, which is a flush behind the
    // window: what is asserted is what the server ends up holding.
    await expect.poll(async () => (await persistedBoard(page)).clips).toBe(1);
    const board = await persistedBoard(page);
    expect(board.acts).toBe(2);
    expect(board.frames).toBe(3);
    expect(board.drawn).toBe(2);
  } finally {
    forgetHome(home);
  }
});
