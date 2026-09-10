import { expect, test } from "@playwright/test";

import { CHANNEL_KEY } from "./helpers";
import { PAINTER, PROVIDER_ADDRESS, STORYTELLER } from "./mock-provider";

/** The identifier derived from the stand-in's host, and a reference through it. */
const CHANNEL = "127-0-0-1";
const DIRECTOR = `${CHANNEL}::director`;

/**
 * Adding a provider against the real metadata store and the real stand-in.
 *
 * What a component test cannot show is that a channel written from the dialog is
 * still there after the page is thrown away. The stand-in answers `/v1/models`,
 * so this drives the path a real provider answers: an address and a key are
 * asked what they offer before anything is stored, what comes back is grouped by
 * what each model can make, one kind is corrected on its row, a kind no
 * identifier would have given away is added by hand, and the default for it is
 * offered rather than hunted for in another tab.
 *
 * The default asserted here is a video one. Earlier specs configure the text and
 * image defaults against the stand-in channel, and the suite shares one metadata
 * store, so those two are not this spec's to reason about.
 */
test("an address and a key reach a usable channel and default", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("button", { name: "Add a provider" }).click();
  await dialog.getByLabel("Provider address").fill(PROVIDER_ADDRESS);
  await dialog.getByLabel("API key").fill(CHANNEL_KEY);

  // Asking first: nothing is stored until the models and the default are
  // chosen, so a wrong address or key costs a message and not a channel.
  await dialog.getByRole("button", { name: "Ask what it offers" }).click();
  await expect(dialog.getByTestId("wizard-reached")).toContainText(
    "2 models offered",
  );
  await expect(dialog.getByTestId("wizard-replaces")).toBeHidden();

  await dialog.getByRole("button", { name: "Choose models" }).click();

  // Neither identifier hints at what it makes, so both arrive as text and the
  // group says the kind was guessed rather than known.
  const offered = dialog.getByRole("region", { name: "Text models offered" });
  await expect(offered).toContainText("guessing");
  await offered
    .getByRole("button", { name: "Add all text models offered" })
    .click();

  await expect(dialog.getByLabel("Model 1 identifier")).toHaveValue(PAINTER);
  await expect(dialog.getByLabel("Model 2 identifier")).toHaveValue(
    STORYTELLER,
  );
  // The guess is a starting point, and correcting it is one control on the row.
  await dialog.getByLabel("Model 1 capability").selectOption("image");

  // A kind no identifier would have given away is added by hand, and the row
  // starts on a kind this channel has nothing for yet.
  await dialog.getByRole("button", { name: "Add a model by hand" }).click();
  await expect(dialog.getByLabel("Model 3 capability")).toHaveValue("audio");
  await dialog.getByLabel("Model 3 identifier").fill("director");
  await dialog.getByLabel("Model 3 capability").selectOption("video");

  // What the channel will be able to do is stated, not left to be counted.
  await expect(dialog.locator(".coverage-chips")).toContainText("Image");
  await expect(dialog.locator(".coverage-chips")).toContainText("Video");

  await dialog.getByRole("button", { name: "Continue" }).click();

  // One video model and no video default is an unambiguous answer, so it is
  // offered instead of being left for the first run to fail over.
  await expect(dialog.getByLabel("Default Video model")).toHaveValue(DIRECTOR);
  await dialog.getByRole("button", { name: "Add the channel" }).click();

  await expect(dialog.getByText("127.0.0.1 added")).toBeVisible();
  await expect(dialog.locator(".coverage-chips")).toContainText("Video");
  await dialog.getByRole("button", { name: "Back to the channels" }).click();

  const row = dialog
    .locator(".channel")
    .filter({ has: page.locator("strong", { hasText: "127.0.0.1" }) });
  await expect(row.getByText(/3 models/)).toBeVisible();
  await expect(row.locator(".coverage-chips")).toContainText("Video");
  // The credential is disclosed as a masked form, and never whole.
  await expect(row.getByText(/^Key /)).toBeVisible();
  await expect(row).not.toContainText(CHANNEL_KEY);

  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  // What was written survives the page being thrown away.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    dialog
      .locator(".channel")
      .filter({ has: page.locator("strong", { hasText: "127.0.0.1" }) }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Defaults" }).click();
  await expect(dialog.getByLabel("Video")).toHaveValue(DIRECTOR);
});
