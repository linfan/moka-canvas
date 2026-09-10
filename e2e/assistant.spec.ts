import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addNode,
  APP,
  configureTextChannel,
  createProject,
  openRecent,
  persistedNodeCount,
  projectHome,
} from "./helpers";
import {
  PROVIDER_ORIGIN,
  SENTENCE,
  STORYTELLER,
  type ProviderCall,
} from "./mock-provider";

interface ServedLine {
  role: string;
  text: string;
  references?: { nodeId: string; title: string; kind: string }[];
}

interface ServedSession {
  id: string;
  title: string;
  messages: ServedLine[];
}

/** The document as the server holds it, which is the only copy that counts. */
async function servedSessions(): Promise<ServedSession[]> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  const body = (await response.json()) as {
    moka?: { canvas?: { sessions?: ServedSession[] }[] };
  };
  return body.moka?.canvas?.[0]?.sessions ?? [];
}

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  data?: { content?: string };
}

/** The cards the server holds, on the first canvas of the document. */
async function servedNodes(): Promise<ServedNode[]> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  const body = (await response.json()) as {
    moka?: { canvas?: { nodes?: ServedNode[] }[] };
  };
  return body.moka?.canvas?.[0]?.nodes ?? [];
}

async function providerCalls(): Promise<ProviderCall[]> {
  const response = await fetch(`${PROVIDER_ORIGIN}/__calls`);
  if (!response.ok) throw new Error(`reading the stand-in: ${response.status}`);
  return ((await response.json()) as { calls: ProviderCall[] }).calls;
}

/**
 * Opens a project holding one text card that says something, and selects it.
 *
 * The words are written through the command endpoint rather than typed into the
 * card, so what is proved starts from a card that says something rather than
 * from the typing of one.
 */
async function openWithWords(
  page: Page,
  name: string,
  directory: string,
  words: string,
): Promise<void> {
  await page.goto("/");
  await createProject(page, directory, name);
  await addNode(page, "Text");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  const before = await (await fetch(`${APP}/api/v1/projects/current`)).json();
  const document = before as {
    moka: {
      metadata: { revision: number };
      canvas: { id: string; nodes: { id: string }[] }[];
    };
  };
  const canvas = document.moka.canvas[0];
  const response = await fetch(`${APP}/api/v1/projects/current/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: document.moka.metadata.revision,
      commands: [
        {
          type: "updateNode",
          canvasId: canvas.id,
          nodeId: canvas.nodes[0].id,
          patch: { title: "Brief", data: { content: words } },
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`giving the card words: ${response.status}`);
  }

  await page.reload();
  await openRecent(page, name);
  await expect(
    page.getByRole("banner").getByText(name, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // The canvas is a Leafer surface with nothing a locator can point at, and the
  // document holds exactly one card, so selecting everything selects it.
  await page.keyboard.press("Control+a");
}

function column(page: Page) {
  return page.getByTestId("assistant-panel");
}

test("the column beside the canvas comes up on either of its two faces", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("assistant-column"), "project"),
    "Two Faced Column",
  );

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toBeVisible();

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(column(page)).toBeVisible();
  // One column rather than two: a canvas with both beside it has very little of
  // itself left to look at.
  await expect(inspector).not.toBeVisible();

  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(inspector).toBeVisible();
  await expect(column(page)).not.toBeVisible();

  // Pressing the face already up folds the column away rather than leaving it.
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(inspector).not.toBeVisible();
});

test("a question asked over a card is answered and kept in the document", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextChannel(STORYTELLER);

  const name = "Asked Over The Canvas";
  await openWithWords(
    page,
    name,
    join(projectHome("assistant-ask"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(column(page)).toBeVisible();
  await expect(page.getByTestId("assistant-about")).toHaveText("About 1 text");

  const asked = "What does the brief say?";
  await page.getByLabel("Ask about this canvas").fill(asked);
  await page.getByRole("button", { name: "Send: Ask" }).click();

  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
    { timeout: 15_000 },
  );
  await expect(page.locator(".assistant-line.is-user")).toContainText(asked);
  // What the card says travelled under the card's name, not as an id.
  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain("[Brief]");
  expect(calls[0].prompt).toContain(
    "A lantern floats over a quiet lake at dusk.",
  );
  expect(calls[0].prompt).toContain(asked);
  expect(calls[0].credentialed).toBe(true);

  // One turn, however many pieces it was shown in: one conversation holding two
  // lines, named after what was first asked.
  await expect.poll(servedSessions, { timeout: 10_000 }).toHaveLength(1);
  const held = (await servedSessions())[0];
  expect(held.title).toBe(asked);
  expect(held.messages.map((line) => line.role)).toEqual(["user", "assistant"]);
  expect(held.messages[1].text).toBe(SENTENCE);
  expect(held.messages[0].references).toEqual([
    expect.objectContaining({ title: "Brief", kind: "text" }),
  ]);

  // Carried by the document rather than by the panel that showed it.
  await page.reload();
  await openRecent(page, name);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.locator(".assistant-line.is-user")).toContainText(asked);
  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
  );
});

test("an answer goes back onto the canvas, over a card or as one of its own", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextChannel(STORYTELLER);

  await openWithWords(
    page,
    "Answered Back On The Canvas",
    join(projectHome("assistant-file"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page
    .getByLabel("Ask about this canvas")
    .fill("What does the brief say?");
  await page.getByRole("button", { name: "Send: Ask" }).click();

  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
    { timeout: 15_000 },
  );

  // Named after the answer rather than after nothing, since a file called
  // "answer.txt" tells a reader nothing about which answer it holds.
  await expect(
    column(page).getByRole("link", { name: "Download" }),
  ).toHaveAttribute("download", `${SENTENCE}.txt`);

  // The card the question was about, chosen still, is the one offered to take
  // the words.
  await column(page).getByRole("button", { name: "Replace selection" }).click();
  await expect
    .poll(async () => (await servedNodes())[0]?.data?.content, {
      timeout: 10_000,
    })
    .toBe(SENTENCE);
  expect(await persistedNodeCount(page)).toBe(1);

  // And a card of its own, so the answer survives the card it was asked with.
  await column(page).getByRole("button", { name: "Insert on canvas" }).click();
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(2);
  const laid = (await servedNodes()).find((node) => node.title === SENTENCE);
  expect(laid?.kind).toBe("text");
  expect(laid?.data?.content).toBe(SENTENCE);
});

test("a canvas holds several conversations, and reads the one it was pointed at", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextChannel(STORYTELLER);

  const name = "Several Conversations";
  await openWithWords(
    page,
    name,
    join(projectHome("assistant-sessions"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  const first = "What does the brief say?";
  await page.getByLabel("Ask about this canvas").fill(first);
  await page.getByRole("button", { name: "Send: Ask" }).click();
  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
    { timeout: 15_000 },
  );

  // A conversation kept is something to go back to rather than only to carry on,
  // so another can be opened beside it over the same cards.
  const listing = page.getByLabel("Conversation", { exact: true });
  await listing.selectOption({ label: "New conversation" });
  await expect(
    column(page).getByText("A new conversation, nothing said in it yet."),
  ).toBeVisible();

  const second = "Is it dusk there?";
  await page.getByLabel("Ask about this canvas").fill(second);
  await page.getByRole("button", { name: "Send: Ask" }).click();
  await expect
    .poll(async () => (await servedSessions()).length, { timeout: 10_000 })
    .toBe(2);

  // Only the second is on show, which is what makes them two rather than one
  // run of asking.
  await expect(column(page).locator(".assistant-line.is-user")).toHaveCount(1);
  await expect(column(page).locator(".assistant-line.is-user")).toContainText(
    second,
  );

  const held = await servedSessions();
  const older = held.find((session) => session.title === first);
  if (!older) throw new Error(`The first conversation is not in ${held}`);

  // Read the first again, then name it something a list can be picked from.
  await listing.selectOption(older.id);
  await expect(column(page).locator(".assistant-line.is-user")).toContainText(
    first,
  );
  await column(page).getByRole("button", { name: "Rename" }).click();
  await page.getByTestId("assistant-session-rename").fill("The brief, asked");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await servedSessions()).find((session) => session.id === older.id)
          ?.title,
      { timeout: 10_000 },
    )
    .toBe("The brief, asked");

  // Carried by the document, and found again by when something was last said in
  // it: the reopened panel reads the second conversation, not the one left picked.
  const newest = (await servedSessions()).find(
    (session) => session.title === second,
  );
  if (!newest) throw new Error("The second conversation did not stay kept");

  await page.reload();
  await openRecent(page, name);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect
    .poll(() => listing.inputValue(), { timeout: 10_000 })
    .toBe(newest.id);
  await expect(column(page).locator(".assistant-line.is-user")).toContainText(
    second,
  );
  // Named by what was first asked, in the order they were last talked in, with
  // the one not written yet beside them.
  await expect(listing.locator("option")).toHaveText([
    `${second} · 2 lines`,
    "The brief, asked · 2 lines",
    "New conversation",
  ]);
});
