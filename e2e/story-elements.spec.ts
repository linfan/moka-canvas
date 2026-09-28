import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  backToLauncher,
  configureWordsAndPictures,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openRecent,
  openStoryRoom,
  projectHome,
} from "./helpers";

/**
 * The third step: who and what the telling is made of.
 *
 * The chapters are read once for the cast they hold; each of them is drawn and
 * agreed to, and the board behind them — step four — is not a door until every
 * one of them has a picture the reader has settled on.
 */

/** The elements the server has written into the first story. */
async function persistedElements(
  page: Page,
): Promise<Array<{ name: string; described: boolean; drawn: boolean }>> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          elements?: {
            name?: string;
            descriptionConfirmed?: boolean;
            main?: { takes?: unknown[] };
          }[];
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.elements ?? []).map((element) => ({
      name: element.name ?? "",
      described: element.descriptionConfirmed === true,
      drawn: (element.main?.takes ?? []).length > 0,
    }));
  });
}

/** The card of one element, which is where its own pictures live. */
function card(page: Page, kind: string, name: string): Locator {
  return page.getByTestId(`story-element-${kind}-${name}`);
}

test("the chapters are read for their cast, drawn, and agreed to", async ({
  page,
}) => {
  const home = projectHome("story-elements");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Elements");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // A premise, and the chapters it is told in.
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

    // Step three: the cast is read out of the chapters, by the model the room
    // is set to — the deployment's default until a reader picks another.
    await page.getByTestId("story-step-elements").click();
    await expect(page.getByTestId("story-step-body-elements")).toBeVisible();
    await expect(page.getByTestId("story-elements-empty")).toBeVisible();
    await expect(page.getByTestId("story-model-text")).toBeVisible();
    await expect(
      page.getByTestId("story-model-text").getByRole("combobox"),
    ).toHaveValue("");
    await page.getByTestId("story-elements-recognise").click();

    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-description-Keeper",
      ),
    ).toHaveValue(/grey coat/);
    // Nobody has a picture yet, so nothing can be agreed to in bulk.
    await expect(page.getByTestId("story-elements-draw-all")).toHaveText(
      "Draw every missing picture (4)",
    );
    await expect(page.getByTestId("story-elements-confirm-all")).toBeDisabled();

    // Drawing them all is four asks of the painter, said out loud.
    await page.getByTestId("story-elements-draw-all").click();
    await expect(card(page, "character", "Keeper").locator("img")).toBeVisible({
      timeout: 60_000,
    });

    // A character is drawn with the four views as well, and only the two
    // characters need them.
    await expect(page.getByTestId("story-elements-views-all")).toHaveText(
      "Four views for every character (2)",
    );
    await page.getByTestId("story-elements-views-all").click();
    await expect(
      card(page, "character", "Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });

    await expect(page.getByTestId("story-elements-confirm-all")).toBeEnabled();
    await page.getByTestId("story-elements-confirm-all").click();
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-state-Keeper",
      ),
    ).toHaveText("Description agreed to");

    // Every element described and drawn: the board is now a door.
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled();

    await expect
      .poll(async () => persistedElements(page))
      .toEqual([
        { name: "Keeper", described: true, drawn: true },
        { name: "Traveller", described: true, drawn: true },
        { name: "Last carriage", described: true, drawn: true },
        { name: "Old ticket", described: true, drawn: true },
      ]);
  } finally {
    forgetHome(home);
  }
});

test("the cast a reading left, and what the reader said since, outlast the room", async ({
  page,
}) => {
  const home = projectHome("story-elements-again");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Elements Again");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");
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

    // The cast, and a picture drawn for one of them.
    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-empty-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await card(page, "character", "Keeper")
      .getByTestId("story-slot-main-generate")
      .click();
    await expect(card(page, "character", "Keeper").locator("img")).toBeVisible({
      timeout: 60_000,
    });

    // What the reader says to the cast by hand: one added, one taken out, and
    // a description of their own over the words the reading brought.
    await page.getByTestId("story-elements-add").click();
    await page.getByTestId("add-element-kind").selectOption("scene");
    await page.getByTestId("add-element-name").fill("Waiting room");
    await page
      .getByTestId("add-element-description")
      .fill("Nobody on the benches.");
    await page.getByTestId("add-element-confirm").click();
    await card(page, "prop", "Old ticket")
      .getByTestId("story-element-remove-Old ticket")
      .click();
    await page.getByTestId("remove-element-confirm").click();
    await card(page, "character", "Keeper")
      .getByTestId("story-element-description-Keeper")
      .fill("A woman in a long grey coat, slow to speak.");
    // The click that leaves the field is the write: what is agreed to after it
    // is the reader's words and not the reading's.
    await page.getByTestId("story-elements-group-all").click();
    await card(page, "character", "Keeper")
      .getByTestId("story-element-confirm-Keeper")
      .click();
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-state-Keeper",
      ),
    ).toHaveText("Description agreed to");

    // Home and back in, which reads the same batches into the story a second
    // time: every one of them says its answer is already in, so none of it is
    // written over what the reader has said since.
    await backToLauncher(page);
    await openRecent(page, "Story Elements Again");
    await openStoryRoom(page);
    await page.getByTestId("story-step-elements").click();
    await expect(page.getByTestId("story-step-body-elements")).toBeVisible();

    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await expect(
      card(page, "scene", "Waiting room").getByTestId(
        "story-element-description-Waiting room",
      ),
    ).toHaveValue("Nobody on the benches.");
    await expect(card(page, "prop", "Old ticket")).toHaveCount(0);
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-description-Keeper",
      ),
    ).toHaveValue("A woman in a long grey coat, slow to speak.");
    await expect(
      card(page, "character", "Keeper").locator("img"),
    ).toBeVisible();

    // And the server holds the same cast: the pictures that were drawn are
    // still the element's, and the one that was taken out is gone.
    await expect
      .poll(async () => persistedElements(page))
      .toEqual([
        { name: "Keeper", described: true, drawn: true },
        { name: "Traveller", described: false, drawn: false },
        { name: "Last carriage", described: false, drawn: false },
        { name: "Waiting room", described: false, drawn: false },
      ]);
  } finally {
    forgetHome(home);
  }
});
