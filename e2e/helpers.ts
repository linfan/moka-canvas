import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect, type Locator, type Page } from "@playwright/test";
import { PROVIDER_ADDRESS } from "./mock-provider";

/** The server under test, for the calls a test makes beside the browser's. */
export const APP = `http://127.0.0.1:${process.env.MOKA_E2E_PORT ?? 8971}`;

export function projectHome(name: string) {
  return mkdtempSync(join(tmpdir(), `moka-e2e-${name}-`));
}

/** Open the launcher's create dialog and scaffold a new project. */
export async function createProject(
  page: Page,
  directory: string,
  name: string,
) {
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Folder").fill(directory);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "New project" }).click();
  await expect(
    page.getByRole("banner").getByText(name, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
}

/** Double-click empty canvas and add a node of the given kind. */
export async function addNode(page: Page, kind: string) {
  const surface = page.getByTestId("canvas-surface");
  const menu = page.getByRole("menu", { name: "Add node" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.dblclick(
      box!.x + box!.width * (0.55 + attempt * 0.08),
      box!.y + box!.height * 0.5,
    );
    if (await menu.isVisible({ timeout: 1500 }).catch(() => false)) {
      await menu.getByRole("menuitem", { name: kind, exact: true }).click();
      return;
    }
  }
  throw new Error(`quick-add menu did not open for ${kind}`);
}

/** Node count of the first canvas as persisted server-side. */
export async function persistedNodeCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { canvas?: { nodes?: unknown[] }[] };
    };
    return (body.moka?.canvas?.[0]?.nodes ?? []).length;
  });
}

/** Open a recent project from the launcher by its card label. */
export async function openRecent(page: Page, name: string) {
  await page
    .locator("button.launcher-recent")
    .filter({ hasText: name })
    .click();
}

/** Open the question an export asks about what the package should carry. */
export async function askToExport(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const asked = page.getByRole("dialog", { name: "Export package" });
  await expect(asked).toBeVisible({ timeout: 10_000 });
  return asked;
}

/**
 * Answer it with both choices left off: the work, and nothing about the
 * machine that made it.
 */
export async function exportWorkPackage(page: Page) {
  const asked = await askToExport(page);
  await asked.getByRole("button", { name: "Export package" }).click();
}

/**
 * Leave the editor for the launcher. If a pending autosave raced the click,
 * the unsaved-work guard appears — resolve it by saving, like a user would.
 */
export async function backToLauncher(page: Page) {
  await page.getByRole("button", { name: "Back to launcher" }).click();
  const guard = page.getByRole("alertdialog", { name: "Unsaved changes" });
  const guarded = await guard
    .waitFor({ state: "visible", timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (guarded) {
    await guard.getByRole("button", { name: "Save and close" }).click();
  }
  await expect(page.getByRole("heading", { name: "Moka Canvas" })).toBeVisible({
    timeout: 10_000,
  });
}

/** The channel the stand-in is reached through, and the credential it is sent. */
export const CHANNEL = "stand-in";
export const CHANNEL_KEY = "e2e-stand-in-credential";

/**
 * Points one channel at the stand-in and makes a written answer the default.
 *
 * Only the text side, since a conversation asks for words: a test that also
 * needs a picture configures both itself. An upsert replaces rather than
 * appends, so two specs pointing the same channel never race over a revision.
 */
export async function configureTextChannel(model: string): Promise<void> {
  const put = await fetch(`${APP}/api/v1/providers/channels`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: CHANNEL,
      name: "Stand-in",
      baseUrl: PROVIDER_ADDRESS,
      protocol: "openai",
      enabled: true,
      models: [
        { id: model, capability: "text", alias: "Storyteller", enabled: true },
      ],
      apiKey: CHANNEL_KEY,
    }),
  });
  if (!put.ok) {
    throw new Error(
      `configuring the channel: ${put.status} ${await put.text()}`,
    );
  }
  const defaults = await fetch(`${APP}/api/v1/providers/defaults`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `${CHANNEL}::${model}` }),
  });
  if (!defaults.ok) {
    throw new Error(
      `setting the default: ${defaults.status} ${await defaults.text()}`,
    );
  }
}
