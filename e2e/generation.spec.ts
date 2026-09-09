import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addNode,
  APP,
  createProject,
  openRecent,
  persistedNodeCount,
  projectHome,
} from "./helpers";
import {
  PAINTER,
  PROVIDER_ADDRESS,
  PROVIDER_ORIGIN,
  SENTENCE,
  STORYTELLER,
  type ProviderCall,
} from "./mock-provider";

const CHANNEL = "stand-in";
/** Stored, sent, and never looked for again: only that one travelled is checked. */
const CHANNEL_KEY = "e2e-stand-in-credential";

interface ServedAsset {
  id: string;
  name: string;
  path: string;
  provenance?: {
    runId?: string;
    operationNodeId?: string;
    inputAssetIds?: string[];
    parameterSnapshot?: Record<string, unknown>;
  };
}

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  data: Record<string, unknown>;
}

interface Served {
  root: string;
  moka: {
    metadata: { revision: number };
    canvas: { id: string; nodes: ServedNode[] }[];
    resources: Record<string, ServedAsset[]>;
  };
}

/** Fails with what the server said, which is the only way to see a refusal. */
async function settled(response: Response, what: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${what}: ${response.status} ${await response.text()}`);
  }
}

async function json(
  url: string,
  what: string,
  init?: { method: string; body: unknown },
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  await settled(response, what);
  return response;
}

/** The document as the server holds it, which is the only copy that counts. */
async function served(): Promise<Served> {
  const response = await json(
    `${APP}/api/v1/projects/current`,
    "reading the project",
  );
  return (await response.json()) as Served;
}

/**
 * Points one channel at the stand-in and makes it the default for both
 * capabilities the suite drives.
 *
 * An upsert replaces rather than appends, so the second test's call is a rewrite
 * of the same channel and the two never race over a revision.
 */
async function configureChannel(): Promise<void> {
  await json(`${APP}/api/v1/providers/channels`, "configuring the channel", {
    method: "PUT",
    body: {
      id: CHANNEL,
      name: "Stand-in",
      baseUrl: PROVIDER_ADDRESS,
      protocol: "openai",
      enabled: true,
      models: [
        { id: PAINTER, capability: "image", alias: "Painter", enabled: true },
        {
          id: STORYTELLER,
          capability: "text",
          alias: "Storyteller",
          enabled: true,
        },
      ],
      apiKey: CHANNEL_KEY,
    },
  });
  await json(`${APP}/api/v1/providers/defaults`, "setting the defaults", {
    method: "PATCH",
    body: {
      image: `${CHANNEL}::${PAINTER}`,
      text: `${CHANNEL}::${STORYTELLER}`,
    },
  });
}

async function providerCalls(): Promise<ProviderCall[]> {
  const response = await json(
    `${PROVIDER_ORIGIN}/__calls`,
    "reading what the stand-in was asked",
  );
  return ((await response.json()) as { calls: ProviderCall[] }).calls;
}

/**
 * Writes a spec onto the project's only node.
 *
 * Through the command endpoint rather than through the page: a node arrives from
 * the quick-add menu with nothing to ask for, and authoring a spec is a later
 * plan's interface. What this proves starts from a spec that exists.
 */
async function giveTheNodeASpec(
  spec: Record<string, unknown>,
): Promise<string> {
  const before = await served();
  const canvas = before.moka.canvas[0];
  const node = canvas.nodes[0];
  await json(`${APP}/api/v1/projects/current/commands`, "writing the spec", {
    method: "POST",
    body: {
      expectedRevision: before.moka.metadata.revision,
      commands: [
        {
          type: "updateNode",
          canvasId: canvas.id,
          nodeId: node.id,
          // A data patch replaces the whole object, so whatever the node holds
          // already travels with the spec being added to it.
          patch: {
            data: {
              ...node.data,
              generation: { ...spec, updatedAt: new Date().toISOString() },
            },
          },
        },
      ],
    },
  });
  return node.id;
}

/**
 * Opens a project holding one node that asks for something, and selects it.
 *
 * The reload is not ceremony: the spec was written behind the page's back, so
 * the page is holding a revision that has moved on, and reopening is what a user
 * would do to see a document somebody else changed.
 */
async function openWithASpec(
  page: Page,
  name: string,
  directory: string,
  kind: "Image" | "Text",
  spec: Record<string, unknown>,
): Promise<string> {
  await page.goto("/");
  await createProject(page, directory, name);
  await addNode(page, kind);
  await page.keyboard.press("Escape");
  // Autosave is debounced, and a spec written against a revision the node has
  // not reached yet is refused.
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  const nodeId = await giveTheNodeASpec(spec);

  await page.reload();
  await openRecent(page, name);
  await expect(
    page.getByRole("banner").getByText(name, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // The canvas is a Leafer surface with nothing a locator can point at, and the
  // document holds exactly one node, so selecting everything selects it.
  await page.keyboard.press("Control+a");
  await expect(
    page.getByRole("heading", { name: "Generation", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  return nodeId;
}

/** The value beside a label in the inspector, which is how a user reads it. */
async function inspected(page: Page, label: string): Promise<string> {
  const row = page
    .locator(".inspector-row")
    .filter({ has: page.locator("span", { hasText: label }) })
    .first();
  return ((await row.locator("span").nth(1).textContent()) ?? "").trim();
}

/**
 * The words shown under one of the inspector's headings.
 *
 * A node that both says something and asks for something shows two excerpts, so
 * which is being read has to be said rather than left to the order they render.
 */
function excerptUnder(page: Page, heading: string) {
  return page
    .locator(".inspector-section")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) })
    .locator(".inspector-text-excerpt");
}

test("an image node asks the provider and files the answer as its own asset", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureChannel();

  const prompt = "A lantern drifting over a quiet lake.";
  const nodeId = await openWithASpec(
    page,
    "Generated Image",
    join(projectHome("generation-image"), "project"),
    "Image",
    {
      capability: "image",
      mode: "generate",
      model: `${CHANNEL}::${PAINTER}`,
      prompt,
      inputMode: "manual",
      params: { size: "1024x1024", count: 1 },
      referenceNodeIds: [],
    },
  );

  // What it would ask for is readable before anything is asked.
  await expect(await inspected(page, "Capability")).toBe("Image");
  await expect(await inspected(page, "Model")).toBe(`${CHANNEL}::${PAINTER}`);
  await expect(excerptUnder(page, "Prompt")).toHaveText(prompt);

  await page
    .getByRole("button", { name: "Run this node", exact: false })
    .click();
  await expect(page.getByText("Run finished")).toBeVisible({ timeout: 20_000 });

  // The answer is a resource of the project, and the panel says which node made
  // it — the link back that makes a generated asset navigable.
  const origin = page.getByRole("button", { name: /which made/ });
  await expect(origin).toBeVisible({ timeout: 10_000 });

  const after = await served();
  const images = after.moka.resources.images;
  expect(images).toHaveLength(1);
  const asset = images[0];
  expect(asset.path).toMatch(/^assets\/images\//);

  const node = after.moka.canvas[0].nodes.find((one) => one.id === nodeId);
  expect(node?.data.assetId, "the node holds what it made").toBe(asset.id);
  expect(asset.provenance?.operationNodeId).toBe(nodeId);
  expect(asset.provenance?.runId, "the run that made it is named").toBeTruthy();
  // A snapshot travels inside an exported package, so it is the one place a
  // credential would leave the machine if it were ever recorded.
  expect(JSON.stringify(asset.provenance?.parameterSnapshot)).not.toContain(
    CHANNEL_KEY,
  );
  expect(JSON.stringify(asset.provenance?.parameterSnapshot)).not.toContain(
    PROVIDER_ADDRESS,
  );

  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/v1/images/generations");
  expect(calls[0].model).toBe(PAINTER);
  expect(calls[0].prompt).toBe(prompt);
  expect(calls[0].count).toBe(1);
  expect(calls[0].credentialed, "a credential travelled").toBe(true);

  // Asking again is a second generation of its own, not a replay of the first:
  // the stand-in is called once more and the project ends up holding both.
  await page
    .getByRole("button", {
      name: "Run again with the parameters of the last generation",
    })
    .click();
  await expect
    .poll(async () => (await providerCalls()).length, { timeout: 20_000 })
    .toBe(2);
  await expect
    .poll(async () => (await served()).moka.resources.images.length, {
      timeout: 10_000,
    })
    .toBe(2);
});

test("a text node keeps what the provider said, word for word", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureChannel();

  const nodeId = await openWithASpec(
    page,
    "Generated Text",
    join(projectHome("generation-text"), "project"),
    "Text",
    {
      capability: "text",
      mode: "generate",
      model: `${CHANNEL}::${STORYTELLER}`,
      prompt: "Say one sentence about a lantern on a lake.",
      inputMode: "manual",
      params: { temperature: 0.4 },
      referenceNodeIds: [],
    },
  );

  await page
    .getByRole("button", { name: "Run this node", exact: false })
    .click();
  await expect(page.getByText("Run finished")).toBeVisible({ timeout: 20_000 });
  await expect(excerptUnder(page, "Content")).toContainText(SENTENCE, {
    timeout: 10_000,
  });

  const after = await served();
  const node = after.moka.canvas[0].nodes.find((one) => one.id === nodeId);
  expect(node?.data.content, "the node says what was said").toBe(SENTENCE);

  // The words are a file in the project like any other asset, and it holds
  // exactly them: nothing wraps, escapes, or truncates an answer on the way in.
  const texts = after.moka.resources.texts;
  expect(texts).toHaveLength(1);
  const written = readFileSync(join(after.root, texts[0].path), "utf8");
  expect(written).toBe(SENTENCE);
  // A text node's own asset field is for media it shows; the words it says are
  // filed too, and named by the slot holding the answer.
  const slots = node?.data.resultSlots as { assetId?: string }[] | undefined;
  expect(slots?.[0]?.assetId).toBe(texts[0].id);

  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe(STORYTELLER);
  expect(calls[0].credentialed).toBe(true);
});
