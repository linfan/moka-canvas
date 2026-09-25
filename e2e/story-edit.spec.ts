import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  configureTheWholeStudio,
  createProject,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";

/**
 * The fifth step: a telling's clips laid end to end as one timeline.
 *
 * The whole telling is taken there — premise, chapters, cast, board, one filmed
 * act, and then the act's sound — and assembled: what the step is for is that
 * the shots a reader has agreed to one at a time come out as one cut, on a
 * timeline of its own that the cutting room can go on working on. The sound is
 * the part of the step that may be skipped (a telling with no score is still a
 * telling); it is walked here because a track nothing ever asks for is a track
 * nobody has seen work.
 */

/** The timeline the server has for the first story, as the document holds it. */
async function persistedTimeline(page: Page): Promise<{
  name: string;
  isTheStories: boolean;
  clips: Array<{ kind: string; startMs: number; durationMs: number }>;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: { edit?: { timelineId?: string } }[];
        timelines?: {
          id?: string;
          name?: string;
          clips?: { kind?: string; startMs?: number; durationMs?: number }[];
        }[];
      };
    };
    const wanted = body.moka?.stories?.[0]?.edit?.timelineId;
    const timeline = (body.moka?.timelines ?? []).find(
      (held) => held.id === wanted,
    );
    return {
      name: timeline?.name ?? "",
      isTheStories: timeline !== undefined,
      clips: (timeline?.clips ?? []).map((clip) => ({
        kind: clip.kind ?? "",
        startMs: clip.startMs ?? 0,
        durationMs: clip.durationMs ?? 0,
      })),
    };
  });
}

test("a telling is assembled into one timeline and handed to the cutting room", async ({
  page,
}) => {
  const home = projectHome("story-edit");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Edit");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // Steps one to four: a premise, chapters, a cast, a board, one shot filmed.
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

    await page.getByTestId("story-step-storyboard").click();
    await page.getByTestId("story-board-generate").click();
    const firstAct = page.getByTestId("story-act-0");
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });
    await firstAct.getByTestId("story-act-keys-0").click();
    await firstAct.getByTestId("story-act-draw-0").click();
    await expect(firstAct.getByTestId("story-kf-slot-0-confirm")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-kf-slot-0-confirm").click();
    await expect(firstAct.getByTestId("story-kf-slot-1-confirm")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-kf-slot-1-confirm").click();
    await firstAct.getByTestId("story-act-images-confirm-0").click();
    await firstAct.getByTestId("story-act-video-go-0").click();
    await expect(firstAct.getByTestId("story-act-video-0")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-act-video-confirm-0").click();

    // The sound of the act, asked for as two pieces of the whole act: the lines
    // read aloud, and the music and sound under them.
    await firstAct.getByTestId("story-act-voice-go-0").click();
    await expect(firstAct.getByTestId("story-act-voice-0")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-act-voice-confirm-0").click();
    await firstAct.getByTestId("story-act-music-go-0").click();
    await expect(firstAct.getByTestId("story-act-music-0")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-act-music-confirm-0").click();

    // Step five: the filmed act is laid down as a timeline of the telling's own.
    await page.getByTestId("story-step-edit").click();
    await expect(page.getByTestId("story-step-edit-body")).toBeVisible();
    await expect(page.getByTestId("story-assembly-summary")).toContainText("1");
    await expect(page.getByTestId("story-assembly-sound")).toBeVisible();
    await page.getByTestId("story-assemble").click();

    await expect
      .poll(async () => (await persistedTimeline(page)).name, {
        timeout: 30_000,
      })
      .toContain("Rain at Night");
    const timeline = await persistedTimeline(page);
    expect(timeline.isTheStories).toBe(true);
    // The clip of the act, the voice and the score under it, then the words
    // said in it — laid down from zero, the lengths coming from the material
    // the stand-in handed back.
    expect(timeline.clips.map((clip) => clip.kind)).toEqual([
      "video",
      "audio",
      "audio",
      "text",
    ]);
    expect(timeline.clips[0]?.startMs).toBe(0);
    expect(timeline.clips[0]?.durationMs).toBe(1_000);
    expect(timeline.clips[1]?.startMs).toBe(0);
    expect(timeline.clips[1]?.durationMs).toBe(1_000);
    expect(timeline.clips[2]?.startMs).toBe(0);
    expect(timeline.clips[3]?.startMs).toBe(0);

    // The e2e harness points MOKA_FFMPEG at a path that is never there, so
    // this is every machine at once: the film card reads once what the
    // machine can do and refuses the render with that reason rather than
    // failing when pressed. A real render belongs to whatever ffmpeg a host
    // has, and is not asserted here.
    await expect(page.getByTestId("story-film-capability")).toContainText(
      "ffmpeg was not found",
    );
    const render = page.getByTestId("story-film-export");
    await expect(render).toBeDisabled();
    await expect(render).toHaveAttribute("title", /ffmpeg was not found/);

    // And the cutting room opens on that same timeline.
    await page.getByTestId("story-film-open").click();
    await expect(page.getByTestId("clip-page")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page
        .getByRole("tablist", { name: "Timelines" })
        .getByRole("tab", { name: /Rain at Night/ }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
