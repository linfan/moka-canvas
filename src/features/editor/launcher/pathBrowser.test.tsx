// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PathBrowserDialog } from "./PathBrowserDialog";

const fetchMock = vi.fn<typeof fetch>();

/** The two kinds of thing a listing can hold. */
type Kind = "directory" | "file";

/**
 * A filesystem small enough to hold in one test, and shaped like the answer the
 * server gives: folders all the way down, files only of a kind that was asked
 * for, and a way up from everywhere but the top.
 */
const TREE: Record<string, { parent: string | null; holds: [string, Kind][] }> =
  {
    "/": { parent: null, holds: [["home", "directory"]] },
    "/home": { parent: "/", holds: [["you", "directory"]] },
    "/home/you": {
      parent: "/home",
      holds: [
        ["Movies", "directory"],
        ["launch.moka", "file"],
        ["notes.txt", "file"],
      ],
    },
    "/home/you/Movies": {
      parent: "/home/you",
      holds: [
        ["Teaser", "directory"],
        ["teaser.moka", "file"],
      ],
    },
    "/home/you/Movies/Teaser": { parent: "/home/you/Movies", holds: [] },
  };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answers a listing the way the server does, out of the tree above. */
function listing(input: RequestInfo | URL): Response {
  const asked = new URL(String(input), "http://localhost");
  if (asked.pathname !== "/api/v1/filesystem") {
    return json(
      { code: "NOT_FOUND", message: "no such route", status: 404 },
      404,
    );
  }
  const where = asked.searchParams.get("path") ?? "";
  const kinds = (asked.searchParams.get("extensions") ?? "")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  const known = TREE[where];
  if (!known) {
    return json(
      { code: "NOT_FOUND", message: `${where}: not there`, status: 404 },
      404,
    );
  }
  // A file is offered only when its kind was asked for, which is the rule the
  // listing is asked under and the reason a folder picker carries no files.
  const entries = known.holds
    .filter(([name, kind]) => {
      if (kind === "directory") return true;
      const extension = name.split(".").pop() ?? "";
      return kinds.includes(extension);
    })
    .map(([name, kind]) => ({
      name,
      kind,
      path: `${where === "/" ? "" : where}/${name}`,
    }));
  return json({
    path: where,
    parent: known.parent,
    entries,
    truncated: false,
  });
}

/** Opens the dialog over a folder of the tree, and waits for the listing. */
async function open(
  props: Partial<ComponentProps<typeof PathBrowserDialog>> = {},
) {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(
    <PathBrowserDialog
      chooseLabel="Choose"
      onClose={onClose}
      onChoose={onChoose}
      title="Open a project"
      {...props}
    />,
  );
  await waitFor(() =>
    expect(screen.queryByTestId("path-browser-busy")).toBeNull(),
  );
  return { onChoose, onClose };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((input) => Promise.resolve(listing(input)));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What the path bar reads. */
function typed(): string {
  return (screen.getByTestId("path-browser-typed") as HTMLInputElement).value;
}

/** What the button is about to act on. */
function chosen(): string {
  return screen.getByTestId("path-browser-choice").textContent ?? "";
}

/** The way up out of the folder being listed. */
function up(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Up one folder",
  }) as HTMLButtonElement;
}

describe("the file dialog a browser has to draw itself", () => {
  it("opens at the folder the field held, listing what can be chosen there", async () => {
    await open({ start: "/home/you", extensions: ["moka"] });

    // The folders, and the file of the kind asked for — not the one that was
    // not, which is the difference between a picker and a directory dump.
    expect(screen.getByTestId("path-browser-row-Movies")).toBeTruthy();
    expect(screen.getByTestId("path-browser-row-launch.moka")).toBeTruthy();
    expect(screen.queryByTestId("path-browser-row-notes.txt")).toBeNull();
    // Where the listing is, said in the bar rather than left to be inferred
    // from what happens to be on screen.
    expect(typed()).toBe("/home/you");
  });

  it("asks for no kind of file at all when it is choosing a folder", async () => {
    await open({ start: "/home/you" });

    expect(screen.getByTestId("path-browser-row-Movies")).toBeTruthy();
    expect(screen.queryByTestId("path-browser-row-launch.moka")).toBeNull();
    expect(screen.queryByTestId("path-browser-row-notes.txt")).toBeNull();
  });

  it("walks into a folder and back out of it", async () => {
    await open({ start: "/home/you", extensions: ["moka"] });

    fireEvent.click(screen.getByTestId("path-browser-row-Movies"));
    await waitFor(() =>
      expect(screen.getByTestId("path-browser-row-teaser.moka")).toBeTruthy(),
    );
    expect(typed()).toBe("/home/you/Movies");

    fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
    await waitFor(() => expect(typed()).toBe("/home/you"));
  });

  it("has nowhere up to go at the top of a filesystem", async () => {
    await open({ start: "/" });

    expect(up().disabled).toBe(true);
  });

  it("takes the file that was picked, and the folder being looked at when none was", async () => {
    const { onChoose } = await open({
      start: "/home/you",
      extensions: ["moka"],
    });

    // Nothing picked yet, so the folder on screen is what the button acts on —
    // which is what makes one dialog serve a project that is a folder as well
    // as one that is a file.
    expect(chosen()).toContain("/home/you");
    fireEvent.click(screen.getByTestId("path-browser-choose"));
    expect(onChoose).toHaveBeenCalledWith("/home/you");

    fireEvent.click(screen.getByTestId("path-browser-row-launch.moka"));
    expect(chosen()).toContain("/home/you/launch.moka");
    fireEvent.click(screen.getByTestId("path-browser-choose"));
    expect(onChoose).toHaveBeenLastCalledWith("/home/you/launch.moka");
  });

  it("takes a file double-clicked, the gesture the system's own dialog answers", async () => {
    const { onChoose } = await open({
      start: "/home/you",
      extensions: ["moka"],
    });

    fireEvent.doubleClick(screen.getByTestId("path-browser-row-launch.moka"));
    expect(onChoose).toHaveBeenCalledWith("/home/you/launch.moka");
  });

  it("still lists a path that was typed, for a reader who knows where they mean", async () => {
    await open({ start: "/home/you", extensions: ["moka"] });

    fireEvent.change(screen.getByTestId("path-browser-typed"), {
      target: { value: "/home/you/Movies/Teaser" },
    });
    fireEvent.submit(screen.getByTestId("path-browser-typed").closest("form")!);
    await waitFor(() =>
      expect(screen.getByTestId("path-browser-none")).toBeTruthy(),
    );
    expect(typed()).toBe("/home/you/Movies/Teaser");
  });

  it("says when a folder would not be listed, and keeps the last one that was", async () => {
    await open({ start: "/home/you", extensions: ["moka"] });

    fireEvent.change(screen.getByTestId("path-browser-typed"), {
      target: { value: "/home/nowhere" },
    });
    fireEvent.submit(screen.getByTestId("path-browser-typed").closest("form")!);

    await waitFor(() =>
      expect(screen.getByTestId("path-browser-error").textContent).toContain(
        "/home/nowhere: not there",
      ),
    );
    // The listing that worked is still on screen, because a folder that would
    // not open is a reason to go up rather than a reason to see nothing — and
    // what the button would take is still a real place.
    expect(screen.getByTestId("path-browser-row-Movies")).toBeTruthy();
    expect(chosen()).toContain("/home/you");
  });

  it("keeps what was typed when a listing arrives after it was typed", async () => {
    // The first answer is held back until the reader has typed somewhere else,
    // which is what happens on a slow disk or a slow network: a dialog that
    // overwrote the bar then would be one that fights the reader for the field.
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementationOnce(() => held);
    render(
      <PathBrowserDialog
        chooseLabel="Choose"
        extensions={["moka"]}
        onClose={vi.fn()}
        onChoose={vi.fn()}
        start="/"
        title="Open a project"
      />,
    );

    fireEvent.change(screen.getByTestId("path-browser-typed"), {
      target: { value: "/home/you/Movies" },
    });
    release(listing("/api/v1/filesystem?path=/"));
    await waitFor(() =>
      expect(screen.queryByTestId("path-browser-busy")).toBeNull(),
    );

    // What was typed stays, and what is listed is still the folder that was
    // asked for before it was typed — the answer to the question that was asked.
    expect(typed()).toBe("/home/you/Movies");
    expect(screen.getByTestId("path-browser-row-home")).toBeTruthy();
  });

  it("closes on Escape and on Cancel, having chosen nothing", async () => {
    const { onClose, onChoose } = await open({ start: "/home/you" });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onChoose).not.toHaveBeenCalled();
  });
});

/** What the name field reads. */
function named(): string {
  return (screen.getByTestId("path-browser-name") as HTMLInputElement).value;
}

describe("the same dialog asked to save", () => {
  it("offers the name it was given, and takes that name in the folder looked at", async () => {
    const { onChoose } = await open({
      start: "/home/you",
      saveAs: "launch.moka",
      extensions: ["moka"],
    });

    expect(named()).toBe("launch.moka");
    expect(chosen()).toContain("/home/you/launch.moka");
    fireEvent.click(screen.getByTestId("path-browser-choose"));
    expect(onChoose).toHaveBeenCalledWith("/home/you/launch.moka");

    // A save means the folder being looked at, so walking is what changes
    // where the file lands — the clicked file's name is taken, not its path.
    fireEvent.click(screen.getByTestId("path-browser-row-Movies"));
    await waitFor(() => expect(typed()).toBe("/home/you/Movies"));
    expect(chosen()).toContain("/home/you/Movies/launch.moka");
  });

  it("completes a name that has no extension with the dialog's own", async () => {
    const { onChoose } = await open({
      start: "/home/you",
      saveAs: "launch.moka",
      extensions: ["moka"],
    });

    fireEvent.change(screen.getByTestId("path-browser-name"), {
      target: { value: "teaser" },
    });
    expect(chosen()).toContain("/home/you/teaser.moka");
    fireEvent.click(screen.getByTestId("path-browser-choose"));
    expect(onChoose).toHaveBeenCalledWith("/home/you/teaser.moka");

    // A name that carries an extension of its own is left as it stands.
    fireEvent.change(screen.getByTestId("path-browser-name"), {
      target: { value: "teaser.mp4" },
    });
    expect(chosen()).toContain("/home/you/teaser.mp4");
  });

  it("takes the name of a file that was clicked, rather than opening it", async () => {
    const { onChoose } = await open({
      start: "/home/you",
      saveAs: "movie.moka",
      extensions: ["moka"],
    });

    fireEvent.click(screen.getByTestId("path-browser-row-launch.moka"));
    expect(named()).toBe("launch.moka");
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("says so before a name already in the folder is replaced", async () => {
    const { onChoose } = await open({
      start: "/home/you",
      saveAs: "launch.moka",
      extensions: ["moka"],
    });

    expect(screen.getByTestId("path-browser-overwrite").textContent).toContain(
      "launch.moka",
    );
    expect(screen.getByTestId("path-browser-choose").textContent).toBe(
      "Replace",
    );

    fireEvent.click(screen.getByTestId("path-browser-choose"));
    expect(onChoose).toHaveBeenCalledWith("/home/you/launch.moka");
  });

  it("has nothing to warn about while the name is new", async () => {
    await open({
      start: "/home/you",
      saveAs: "brand-new.moka",
      extensions: ["moka"],
    });

    expect(screen.queryByTestId("path-browser-overwrite")).toBeNull();
    expect(screen.getByTestId("path-browser-choose").textContent).toBe(
      "Choose",
    );
  });
});
