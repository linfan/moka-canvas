import { expect, test } from "@playwright/test";

import { CHANNEL_KEY } from "./helpers";
import { PROVIDER_ORIGIN } from "./mock-provider";

const CHAT_URL = `${PROVIDER_ORIGIN}/v1/chat/completions`;

/**
 * Configuring a model against the real metadata store and the real stand-in.
 *
 * What a component test cannot show is that a configuration written from the
 * dialog is still there after the page is thrown away. The stand-in answers
 * `/v1/models`, so the test button drives the path a real provider answers.
 */
test("a model written from the form is stored, tested, and kept", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  // The text tab is where a written-answer model belongs, and the form starts
  // from the protocol's own complete address.
  await dialog.getByRole("button", { name: "New text model" }).click();
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://api.openai.com/v1/chat/completions",
  );

  // An identifier of its own: the suite shares one metadata store, and the
  // other specs already configured the stand-in's own model ids. What the form
  // suggests from the display name is checked before it is replaced.
  await dialog.getByLabel("Display name").fill("Typed Model");
  await expect(dialog.getByLabel("Model identifier")).toHaveValue(
    /^typed_model_[a-z0-9]{6}$/,
  );
  await dialog.getByLabel("Model identifier").fill("typed-model");
  await dialog.getByLabel("Endpoint URL").fill(CHAT_URL);
  await dialog.getByLabel("Model name").fill("typed-model-1");
  await dialog.getByLabel("API key").fill(CHANNEL_KEY);
  await dialog.getByRole("button", { name: "Save model" }).click();

  const named = page.locator("strong", { hasText: /^Typed Model$/ });
  const card = dialog.locator("li.model-card").filter({ has: named });
  await expect(card).toBeVisible();
  // The credential is disclosed as a masked form, and never whole.
  await expect(card.getByText(/^Key /)).toBeVisible();
  await expect(card).not.toContainText(CHANNEL_KEY);

  // The test button reaches the stand-in's model list through the address the
  // configuration itself derives it from.
  await card
    .getByRole("button", { name: "Test the connection to Typed Model" })
    .click();
  await expect(card.getByText(/Reached in \d+ ms/)).toBeVisible();

  // The default is chosen on the card, in the category's own tab. The radio
  // is controlled by the stored view, so it becomes checked once the write
  // it caused comes back — which the assertion waits out.
  await card
    .getByRole("radio", { name: "Use Typed Model as the default text model" })
    .click();
  await expect(
    card.getByRole("radio", {
      name: "Use Typed Model as the default text model",
    }),
  ).toBeChecked();

  // A copy carries the fields and the key, and opens ready to be changed.
  await card.getByRole("button", { name: "Copy Typed Model" }).click();
  await expect(dialog.getByLabel("Display name")).toHaveValue(
    "Typed Model (copy)",
  );
  await expect(dialog.getByLabel("Model identifier")).toHaveValue(
    "typed-model-copy",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  // What was written survives the page being thrown away.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  // The copy from earlier is stored too, so the card is found by its exact
  // name rather than by a substring both cards carry.
  const kept = dialog.locator("li.model-card").filter({ has: named });
  await expect(kept).toBeVisible();
  await expect(
    kept.getByRole("radio", {
      name: "Use Typed Model as the default text model",
    }),
  ).toBeChecked();
});

test("a category offers only the protocols that serve it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Video" }).click();

  await dialog.getByRole("button", { name: "New video model" }).click();
  const protocol = dialog.getByLabel("Protocol");
  await expect(protocol).toHaveValue("openaiVideos");
  // A chat endpoint cannot serve a video model, so it is not on offer.
  await expect(protocol.locator("option")).toHaveText([
    "OpenAI-compatible · Videos API",
    "Google Gemini · long-running (Veo)",
  ]);
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://api.openai.com/v1/videos",
  );
});
