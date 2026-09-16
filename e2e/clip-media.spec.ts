import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  forgetProjects,
  openClipRoom,
  projectHome,
} from "./helpers";

// A tiny valid PNG (1x1 transparent pixel), as the assets shelf spec uses.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The browser's drag data, as much of it as these tests use.
 *
 * `DataTransfer` is the browser's own and the node-side types this suite is
 * checked against do not carry it, so the constructor is named through a local
 * shape inside each dispatched drag rather than taken from a global type that
 * is not there.
 */
interface DragData {
  items: { add(file: File): void };
  effectAllowed: string;
  getData(type: string): string;
}

/** A fresh project already standing in the cutting room. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-media");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/** The row of a file, found by the name the row leads with. */
function rowFor(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped} `) });
}

/** Imports one file through the shelf's own input, and waits for its row. */
async function importFile(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  await page
    .getByLabel("Import files", { exact: true })
    .setInputFiles({ name, mimeType, buffer });
  await expect(rowFor(page, name)).toBeVisible({ timeout: 10_000 });
}

/** The id the document filed a file under, read from the server. */
async function filedId(page: Page, name: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { resources?: Record<string, { id: string; name: string }[]> };
    };
    const books = Object.values(body.moka?.resources ?? {});
    for (const entries of books) {
      const found = entries.find((entry) => entry.name === wanted);
      if (found) return found.id;
    }
    return "";
  }, name);
}

test("the two faces read one shelf, each asking its own question", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Faces");

  await importFile(page, "one.png", "image/png", TINY_PNG);

  // The file was brought in, so the local face holds it...
  await expect(rowFor(page, "one.png")).toBeVisible();
  // ...and the source faces are the origin question themselves: the shelf does
  // not ask where a file came from on top of a face that has just answered it.
  await expect(page.getByTestId("shelf-where")).toHaveCount(0);

  // The same shelf is read by the project face, open on every origin.
  await page.getByTestId("clip-face-project").click();
  await expect(
    page.getByRole("heading", { name: "Project media" }),
  ).toBeVisible();
  await expect(rowFor(page, "one.png")).toBeVisible();
  await expect(page.getByTestId("shelf-where")).toHaveCount(0);

  rmSync(home, { recursive: true, force: true });
});

test("the search narrows the face and says so when nothing says it", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Search");
  await importFile(page, "one.png", "image/png", TINY_PNG);

  const asked = page.getByTestId("shelf-asked");
  await asked.fill("one");
  await expect(rowFor(page, "one.png")).toBeVisible();

  await asked.fill("zzz");
  await expect(page.getByTestId("shelf-no-match")).toBeVisible();
  await expect(
    page.getByText("Nothing on this shelf says that."),
  ).toBeVisible();

  await asked.fill("");
  await expect(rowFor(page, "one.png")).toBeVisible();

  // The keeper mark narrows the shelf too, and Clear lets the rest back in.
  await page.getByRole("button", { name: "Keep one.png to hand" }).click();
  await page.getByTestId("shelf-keepers").check();
  await expect(page.getByTestId("shelf-clear")).toBeVisible();
  await expect(rowFor(page, "one.png")).toBeVisible();
  await page.getByTestId("shelf-clear").click();
  await expect(rowFor(page, "one.png")).toBeVisible();

  rmSync(home, { recursive: true, force: true });
});

test("a row carries the drag-out contract the timeline will take", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Drag");
  await importFile(page, "one.png", "image/png", TINY_PNG);

  const listed = await filedId(page, "one.png");
  expect(listed).not.toBe("");
  const row = page.locator(".resource-row").filter({ hasText: "one.png" });
  await expect(row).toHaveAttribute("draggable", "true");
  await expect(row).toHaveAttribute("data-asset-id", listed);

  // What a drag carries: the id, under the shelf's own type. (The copy
  // effect is set on the same handler; a drag that never happened is not a
  // drag the platform lets say so.)
  const carried = await page.evaluateHandle(() => {
    const Browser = (
      globalThis as unknown as { DataTransfer: new () => DragData }
    ).DataTransfer;
    return new Browser();
  });
  await row.dispatchEvent("dragstart", { dataTransfer: carried });
  expect(
    await carried.evaluate((data) => data.getData("application/x-moka-asset")),
  ).toBe(listed);

  rmSync(home, { recursive: true, force: true });
});

test("files dropped over the column are imported, and the column turns to Local", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Drop");
  // Turned away from Local first: the drop is what should bring it back.
  await page.getByTestId("clip-face-project").click();
  await expect(
    page.getByRole("heading", { name: "Project media" }),
  ).toBeVisible();

  const carried = await page.evaluateHandle((base64) => {
    const Browser = (
      globalThis as unknown as { DataTransfer: new () => DragData }
    ).DataTransfer;
    const bytes = Uint8Array.from(atob(base64), (letter) =>
      letter.charCodeAt(0),
    );
    const data = new Browser();
    data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    return data;
  }, TINY_PNG.toString("base64"));

  await page.dispatchEvent(".clip-column", "dragover", {
    dataTransfer: carried,
  });
  await expect(page.locator(".clip-media-drop")).toHaveText("Drop to import");
  await page.dispatchEvent(".clip-column", "drop", { dataTransfer: carried });

  await expect(page.getByTestId("clip-face-local")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rowFor(page, "dropped.png")).toBeVisible({ timeout: 10_000 });

  rmSync(home, { recursive: true, force: true });
});
