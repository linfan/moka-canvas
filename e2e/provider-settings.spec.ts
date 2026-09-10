import { expect, test } from "@playwright/test";

import { CHANNEL_KEY } from "./helpers";
import { PAINTER, PROVIDER_ADDRESS, STORYTELLER } from "./mock-provider";

/** The identifier derived from the stand-in's host, and a reference through it. */
const CHANNEL = "127-0-0-1";
const DIRECTOR = `${CHANNEL}::director`;

/**
 * Provider configuration against the real metadata store.
 *
 * What a component test cannot show is that a channel written from the dialog is
 * still there after the page is thrown away. The stand-in answers `/v1/models`,
 * so this drives the path a real provider answers: an address and a key go in,
 * what the provider offers comes back grouped by what each model can make, the
 * guess is corrected on the row, and a kind the provider's names gave no hint of
 * is added by hand.
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

  // The shortcut takes an address and a key, and derives the rest.
  await dialog.getByLabel("Provider address").fill(PROVIDER_ADDRESS);
  await dialog.getByLabel("API key").fill(CHANNEL_KEY);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  // Adding lands on the part that is still missing rather than on a list to
  // search: the editor for the new channel, already asking what it offers.
  await expect(
    dialog.getByRole("heading", { name: "Edit 127.0.0.1" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "Models", exact: true }),
  ).toBeVisible();

  // Neither identifier hints at what it makes, so both arrive as text and the
  // group says the kind was guessed rather than known.
  const offered = dialog.getByRole("region", { name: "Text models offered" });
  await expect(offered).toContainText("guessing");
  await offered
    .getByRole("button", { name: `Add ${PAINTER} to the text models` })
    .click();
  await offered
    .getByRole("button", { name: `Add ${STORYTELLER} to the text models` })
    .click();

  // The guess is a starting point, and correcting it is one control on the row.
  await expect(dialog.getByLabel("Model 1 identifier")).toHaveValue(PAINTER);
  await dialog.getByLabel("Model 1 capability").selectOption("image");

  // A kind the provider's names gave no hint of is added by hand, and the row
  // starts on a kind this channel has nothing for yet.
  await dialog.getByRole("button", { name: "Add model" }).click();
  await expect(dialog.getByLabel("Model 3 capability")).toHaveValue("audio");
  await dialog.getByLabel("Model 3 identifier").fill("director");
  await dialog.getByLabel("Model 3 capability").selectOption("video");

  // What the channel can now do is stated rather than left to be counted.
  await expect(dialog.locator(".coverage-chips")).toContainText("Image");
  await expect(dialog.locator(".coverage-chips")).toContainText("Video");

  await dialog.getByRole("button", { name: "Save channel" }).click();

  // By name, not by address: the stand-in channel earlier specs configure is
  // served from the same host, and its row carries that address too.
  const row = dialog
    .locator(".channel")
    .filter({ has: page.locator("strong", { hasText: "127.0.0.1" }) });
  await expect(row.getByText(/3 models/)).toBeVisible();
  await expect(row.locator(".coverage-chips")).toContainText("Video");
  // The credential is disclosed as a masked form, and never whole.
  await expect(row.getByText(/^Key /)).toBeVisible();
  await expect(row).not.toContainText(CHANNEL_KEY);

  // A capability with one model and no default is answered with that model,
  // rather than left as a gap for the first run to fall into.
  await dialog.getByRole("tab", { name: "Defaults" }).click();
  const gap = dialog.getByTestId("video-gap");
  await expect(gap).toContainText("1 video model available");
  await gap.getByRole("button", { name: /^Use / }).click();
  await expect(dialog.getByLabel("Video")).toHaveValue(DIRECTOR);

  await dialog.getByRole("button", { name: "Save defaults" }).click();
  await expect(
    dialog.getByRole("button", { name: "Save defaults" }),
  ).toBeDisabled();

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
