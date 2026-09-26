import { expect, test } from "@playwright/test";

import { CHANNEL_KEY } from "./helpers";
import { PROVIDER_ORIGIN } from "./mock-provider";

const CHAT_URL = `${PROVIDER_ORIGIN}/v1/chat/completions`;

/**
 * Configuring a model against the real metadata store and the real stand-in.
 *
 * What a component test cannot show is that a configuration written from the
 * dialog is still there after the page is thrown away.
 */
test("a model written from the form is stored and kept", async ({ page }) => {
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
  // A copy's identifier is a suggestion from the copy's own display name, the
  // way a plain new model's is, rather than a fixed "-copy" of the source's.
  await expect(dialog.getByLabel("Model identifier")).toHaveValue(
    /^typed_model_copy_[a-z0-9]{6}$/,
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

/**
 * The window keeps its place while its tabs are turned over.
 *
 * A dialog that grows to whatever the tab holds moves under the pointer with
 * every click, so the room a tab is read in is the dialog's own and never the
 * tab's: what a tab holds too much of scrolls inside its panel, and what it
 * holds too little of leaves the bottom of that panel blank.
 */
test("the settings dialog keeps one box across its tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  const boxOf = async () => {
    const box = await dialog.boundingBox();
    return [box!.x, box!.y, box!.width, box!.height].map(Math.round);
  };

  await dialog.getByRole("tab", { name: "System" }).click();
  const held = await boxOf();

  // Every face of both sections, the short ones and the one long enough to
  // need a scroll of its own.
  for (const [top, sub] of [
    ["Model", "Text"],
    ["Model", "Image"],
    ["Model", "Video"],
    ["Model", "Preferences"],
    ["System", null],
  ] as [string, string | null][]) {
    await dialog.getByRole("tab", { name: top }).click();
    if (sub) await dialog.getByRole("tab", { name: sub }).click();
    expect(await boxOf(), `${top}/${sub}`).toEqual(held);
  }

  // The preferences are longer than the panel, and are read by scrolling the
  // panel rather than by the dialog giving way to them.
  await dialog.getByRole("tab", { name: "Model" }).click();
  await dialog.getByRole("tab", { name: "Preferences" }).click();
  const overflow = await dialog
    .locator(".settings-body")
    .first()
    // The suite is compiled without the DOM's own types, so the measurements
    // are read off a shape rather than off an element.
    .evaluate((body) => {
      const sized = body as unknown as {
        scrollHeight: number;
        clientHeight: number;
      };
      return sized.scrollHeight > sized.clientHeight;
    });
  expect(overflow).toBe(true);
});

/**
 * The story room's own boundaries are stored with the rest of the preferences.
 *
 * How much of a telling one ask may carry is the reader's to set, since it is
 * the model answering that decides it, and it has to outlive the page: the room
 * reads it whenever it plans a batch. The values are put back afterwards, since
 * the suite shares one metadata store.
 */
test("the story room's boundaries are kept", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const openPreferences = async () => {
    await dialog.getByRole("tab", { name: "Preferences" }).click();
  };

  await openPreferences();
  await dialog.getByLabel("Manuscript part length").fill("9000");
  await dialog.getByLabel("Characters per reading").fill("4000");
  await dialog.getByRole("button", { name: "Save preferences" }).click();

  // What was written survives the page being thrown away.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await openPreferences();
  await expect(dialog.getByLabel("Manuscript part length")).toHaveValue("9000");
  await expect(dialog.getByLabel("Characters per reading")).toHaveValue("4000");

  await dialog.getByLabel("Manuscript part length").fill("12000");
  await dialog.getByLabel("Characters per reading").fill("8000");
  await dialog.getByRole("button", { name: "Save preferences" }).click();
});

test("a category offers only the protocols that serve it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Video" }).click();

  await dialog.getByRole("button", { name: "New video model" }).click();
  const protocol = dialog.getByLabel("Protocol");
  await expect(protocol).toHaveValue("openaiVideos");
  // A chat endpoint cannot serve a video model, so it is not on offer; the
  // shapes deployed under the video capability are, in the order their own
  // documents ask for.
  await expect(protocol.locator("option")).toHaveText([
    "OpenAI-compatible · Videos API",
    "Google Gemini · long-running (Veo)",
    "Alibaba Cloud · Bailian Video",
  ]);
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://api.openai.com/v1/videos",
  );
});

test("every shape a category offers comes from its converter's model.json", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Image" }).click();
  await dialog.getByRole("button", { name: "New image model" }).click();

  const protocol = dialog.getByLabel("Protocol");
  // Both image shapes are converter directories deployed on this machine, so
  // the form names and addresses them from what each one's model.json says —
  // this program holds no table of protocols of its own.
  await expect(protocol.locator("option")).toHaveText([
    "OpenAI-compatible · Images API",
    "Alibaba Cloud · Bailian Image (Wan)",
  ]);
  await protocol.selectOption("bailianImage");
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );

  // The text shape keeps its own address: the multimodal one is derived from
  // it at the moment a question carries a picture.
  await dialog.getByRole("tab", { name: "Text" }).click();
  await dialog.getByRole("button", { name: "New text model" }).click();
  await protocol.selectOption("bailianText");
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
  );
});

test("speech recognition offers the script that serves it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Speech recognition" }).click();

  await dialog
    .getByRole("button", { name: "New speech recognition model" })
    .click();
  const protocol = dialog.getByLabel("Protocol");
  // The deployed converter is the whole of what the category offers: a
  // recognition shape is a script and a document, and nothing else.
  await expect(protocol).toHaveValue("bailianAsr");
  await expect(protocol.locator("option")).toHaveText([
    "Alibaba Cloud · Bailian Speech Recognition (recording file)",
  ]);
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription",
  );
});
