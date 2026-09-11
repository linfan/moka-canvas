// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "../../App";
import type { ModelDraft, ModelsView, ModelView } from "../../api";
import { useModelStore } from "./modelStore";

const CONFIG = {
  productName: "Moka Canvas",
  maxUploadBytes: 104857600,
  allowedMediaTypes: ["image/png"],
  limits: {
    maxNodesPerCanvas: 500,
    maxEdgesPerCanvas: 800,
    maxCanvasesPerProject: 12,
    maxPackageBytes: 536870912,
    maxPackageEntries: 20000,
  },
  capabilities: { mode: "web", executors: ["noop"], assetCategories: [] },
};

const KEY = "sk-test-1234567890abcd";
const MASKED = "sk-…abcd";

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

let view: ModelsView;
let calls: Call[];
/** Lets a test make the next write fail the way the server would. */
let refuseNextWrite: { status: number; code: string; message: string } | null;
/** Lets a test make the next probe fail the way a provider would. */
let probeRefusal: string | null;

function model(
  id: string,
  category: ModelView["category"],
  protocol: ModelView["protocol"],
  displayName: string,
  keyed: boolean,
): ModelView {
  const urls: Record<string, string> = {
    openaiChat: "https://api.example.com/v1/chat/completions",
    openaiImages: "https://api.example.com/v1/images/generations",
  };
  return {
    id,
    category,
    protocol,
    url: urls[protocol] ?? "https://api.example.com/v1",
    model: `${id}-1`,
    displayName,
    enabled: true,
    apiKey: keyed
      ? { set: true, masked: MASKED }
      : { set: false, masked: null },
  };
}

function fixture(): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [
      model("writer", "text", "openaiChat", "Writer", true),
      model("scribe", "text", "openaiChat", "Scribe", false),
      model("painter", "image", "openaiImages", "Painter", true),
    ],
    defaults: { text: null, image: null, audio: null, video: null },
    preferences: {
      systemPrompt: "",
      reasoningEffort: "auto",
      image: { size: "1:1", quality: "auto", background: "", count: 1 },
      video: {
        seconds: 6,
        resolution: "720",
        generateAudio: true,
        watermark: false,
        mode: "auto",
      },
      audio: { voice: "alloy", format: "mp3", speed: 1, instructions: "" },
    },
    secretStorage: "file",
  };
}

function upsert(draft: ModelDraft) {
  const stored = view.models.find((entry) => entry.id === draft.id);
  const key = draft.apiKey?.trim()
    ? { set: true, masked: MASKED }
    : (stored?.apiKey ?? { set: false, masked: null });
  const record: ModelView = {
    id: draft.id,
    category: draft.category,
    protocol: draft.protocol,
    url: draft.url,
    model: draft.model,
    displayName: draft.displayName,
    enabled: draft.enabled,
    apiKey: key,
  };
  view = {
    ...view,
    revision: view.revision + 1,
    models: stored
      ? view.models.map((entry) => (entry.id === draft.id ? record : entry))
      : [...view.models, record],
  };
}

/** The server-side copy: a new identifier and the credential along with it. */
function duplicate(id: string) {
  const source = view.models.find((entry) => entry.id === id);
  if (!source) return;
  let candidate = `${id}-copy`;
  let counter = 2;
  while (view.models.some((entry) => entry.id === candidate)) {
    candidate = `${id}-copy-${counter}`;
    counter += 1;
  }
  view = {
    ...view,
    revision: view.revision + 1,
    models: [
      ...view.models,
      {
        ...source,
        id: candidate,
        displayName: `${source.displayName} (copy)`.slice(0, 120),
      },
    ],
  };
}

function route(url: string, method: string, body: unknown): Response {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const problem = (status: number, code: string, message: string) =>
    json({ code, message, status }, status);

  calls.push({ method, url, body });
  const path = url.split("?")[0];

  if (url === "/api/v1/config") return json(CONFIG);
  if (url === "/api/health") return json({ status: "ok" });
  if (url === "/api/v1/recent-projects") return json([]);

  if (path === "/api/v1/models" && method === "GET") return json(view);

  if (path === "/api/v1/models" && method === "PUT") {
    if (refuseNextWrite) {
      const refusal = refuseNextWrite;
      refuseNextWrite = null;
      return problem(refusal.status, refusal.code, refusal.message);
    }
    upsert(body as ModelDraft);
    return json(view);
  }

  if (path === "/api/v1/models/defaults" && method === "PATCH") {
    const patch: Record<string, unknown> = {
      ...(body as Partial<ModelsView["defaults"]>),
    };
    delete patch.expectedRevision;
    view = {
      ...view,
      revision: view.revision + 1,
      defaults: {
        ...view.defaults,
        ...(patch as Partial<ModelsView["defaults"]>),
      },
    };
    return json(view);
  }

  if (path === "/api/v1/models/preferences" && method === "PATCH") {
    const patch = body as Partial<ModelsView["preferences"]>;
    view = {
      ...view,
      revision: view.revision + 1,
      preferences: { ...view.preferences, ...patch },
    };
    return json(view);
  }

  const named = path.match(/^\/api\/v1\/models\/([^/]+)(\/.*)?$/);
  if (named) {
    const id = decodeURIComponent(named[1]);
    const suffix = named[2] ?? "";
    const index = view.models.findIndex((entry) => entry.id === id);
    if (index === -1) return problem(404, "NOT_FOUND", `no model ${id}`);

    if (suffix === "" && method === "DELETE") {
      view = {
        ...view,
        revision: view.revision + 1,
        models: view.models.filter((entry) => entry.id !== id),
      };
      return json(view);
    }
    if (suffix === "/key" && method === "POST") {
      const { apiKey } = body as { apiKey: string | null };
      view = {
        ...view,
        revision: view.revision + 1,
        models: view.models.map((entry, at) =>
          at === index
            ? {
                ...entry,
                apiKey: apiKey?.trim()
                  ? { set: true, masked: MASKED }
                  : { set: false, masked: null },
              }
            : entry,
        ),
      };
      return json(view);
    }
    if (suffix === "/duplicate" && method === "POST") {
      duplicate(id);
      return json(view);
    }
    if (suffix === "/probe" && method === "POST") {
      return probeRefusal === null
        ? json({ ok: true, latencyMs: 42 })
        : json({
            ok: false,
            latencyMs: 8,
            error: { code: "PROVIDER_AUTH", message: probeRefusal },
          });
    }
  }

  return problem(404, "NOT_FOUND", url);
}

function writesTo(path: string): Call[] {
  return calls.filter(
    (call) => call.method !== "GET" && call.url.split("?")[0] === path,
  );
}

function readsOf(path: string): number {
  return calls.filter((call) => call.method === "GET" && call.url === path)
    .length;
}

/** The card one model is listed in. */
function cardOf(displayName: string): HTMLElement {
  const card = screen.getByText(displayName).closest("li");
  if (!card) throw new Error(`no card for ${displayName}`);
  return card;
}

async function openSettings(tab?: string) {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await screen.findByText("Writer");
  if (tab) fireEvent.click(screen.getByRole("tab", { name: tab }));
  return dialog;
}

beforeEach(() => {
  view = fixture();
  calls = [];
  refuseNextWrite = null;
  probeRefusal = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        route(
          String(input),
          init?.method ?? "GET",
          init?.body ? JSON.parse(String(init.body)) : undefined,
        ),
      ),
    ),
  );
  useModelStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("model settings", () => {
  it("lists each category's models on its own tab", async () => {
    await openSettings();

    // The text tab carries the text models and nothing else.
    expect(screen.getByText("Writer")).toBeTruthy();
    expect(screen.getByText("Scribe")).toBeTruthy();
    expect(screen.queryByText("Painter")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Image" }));
    expect(await screen.findByText("Painter")).toBeTruthy();
    expect(screen.queryByText("Writer")).toBeNull();
  });

  it("shows what may be disclosed about a credential and nothing more", async () => {
    await openSettings();
    await screen.findByText("Writer");

    expect(screen.getByText(`Key ${MASKED}`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("creates a model from the form", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Composer" },
    });
    fireEvent.change(screen.getByLabelText("Model identifier"), {
      target: { value: "composer" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "composer-1" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: KEY },
    });
    // The URL starts from the protocol's own example, which is a complete
    // endpoint rather than a base to extend.
    const url = screen.getByLabelText("Endpoint URL") as HTMLInputElement;
    expect(url.value).toBe("https://api.openai.com/v1/chat/completions");

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Composer");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toEqual({
      id: "composer",
      category: "text",
      protocol: "openaiChat",
      url: "https://api.openai.com/v1/chat/completions",
      model: "composer-1",
      displayName: "Composer",
      enabled: true,
      apiKey: KEY,
      expectedRevision: 1,
    });
  });

  it("offers each category only the protocols that serve it", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Video" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New video model" }),
    );

    const protocol = (await screen.findByLabelText(
      "Protocol",
    )) as HTMLSelectElement;
    expect([...protocol.options].map((option) => option.value)).toEqual([
      "openaiVideos",
      "geminiVideo",
    ]);

    // Picking the other shape offers its own complete address.
    fireEvent.change(protocol, { target: { value: "geminiVideo" } });
    const url = screen.getByLabelText("Endpoint URL") as HTMLInputElement;
    expect(url.value).toContain(":predictLongRunning");
  });

  it("keeps a stored credential when an edit does not mention it", async () => {
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Renamed" },
    });
    // The stored key is announced, and the field stays blank.
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.placeholder).toContain(MASKED);
    expect(key.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Renamed");

    const [write] = writesTo("/api/v1/models");
    const body = write.body as Record<string, unknown>;
    expect(body.displayName).toBe("Renamed");
    expect("apiKey" in body).toBe(false);
    expect(screen.getByText(`Key ${MASKED}`)).toBeTruthy();
  });

  it("clears a stored key only when asked to", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear the stored key" }),
    );

    await waitFor(() =>
      expect(writesTo("/api/v1/models/writer/key")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/writer/key")[0].body).toEqual({
      apiKey: null,
    });
    // Scoped to the cleared model: another text model also stores no key.
    expect(within(cardOf("Writer")).getByText("No key stored")).toBeTruthy();
    confirm.mockRestore();
  });

  it("copies a model, key included, and opens the copy", async () => {
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Copy Writer" }),
    );

    await waitFor(() =>
      expect(writesTo("/api/v1/models/writer/duplicate")).toHaveLength(1),
    );
    // The editor opens on the copy, which is what "quick create" means: the
    // fields worth repeating are filled in and the key came along.
    const display = (await screen.findByLabelText(
      "Display name",
    )) as HTMLInputElement;
    expect(display.value).toBe("Writer (copy)");
    // The credential came along: the field offers to keep it rather than
    // asking for it again.
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.placeholder).toContain(MASKED);
    expect(key.value).toBe("");

    const id = screen.getByLabelText("Model identifier") as HTMLInputElement;
    expect(id.value).toBe("writer-copy");
  });

  it("sets a category's default from its own tab", async () => {
    await openSettings();
    // The gap the default closes is named before one is chosen.
    expect(screen.getByTestId("text-gap").textContent).toContain(
      "No default text model",
    );

    fireEvent.click(
      await screen.findByRole("radio", {
        name: "Use Writer as the default text model",
      }),
    );

    await waitFor(() =>
      expect(writesTo("/api/v1/models/defaults")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/defaults")[0].body).toEqual({
      text: "writer",
      expectedRevision: 1,
    });
    // The gap is gone and the choice is shown as made.
    await waitFor(() => expect(screen.queryByTestId("text-gap")).toBeNull());
    expect(
      (
        screen.getByRole("radio", {
          name: "Use Writer as the default text model",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("deletes a model and its key when asked", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(
      within(cardOf("Scribe")).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() =>
      expect(calls.some((call) => call.method === "DELETE")).toBe(true),
    );
    expect(screen.queryByText("Scribe")).toBeNull();
    expect(screen.getByText("Writer")).toBeTruthy();
    confirm.mockRestore();
  });

  it("sends only the preference group that moved", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Preferences" }));

    fireEvent.change(await screen.findByLabelText("Images per run"), {
      target: { value: "3" },
    });
    const save = screen.getByRole("button", { name: "Save preferences" });
    fireEvent.click(save);
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(true),
    );

    const [write] = writesTo("/api/v1/models/preferences");
    expect(write.body).toEqual({
      image: { size: "1:1", quality: "auto", background: "", count: 3 },
      expectedRevision: 1,
    });
  });

  it("reports a refused write and shows the state that refused it", async () => {
    refuseNextWrite = {
      status: 409,
      code: "METADATA_CONFLICT",
      message: "the configuration changed underneath this edit",
    };
    await openSettings();
    const readsBefore = readsOf("/api/v1/models");

    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    expect(
      await screen.findByText("the configuration changed underneath this edit"),
    ).toBeTruthy();
    // The view was re-read, so the form is not left holding a stale revision.
    expect(readsOf("/api/v1/models")).toBeGreaterThan(readsBefore);
  });

  it("says how strongly the stored keys are protected", async () => {
    await openSettings();
    await screen.findByText("Writer");

    // The file tier is the weaker one, so the warning belongs where a key is
    // typed, not only in the deployment docs.
    const note = screen.getByTestId("secret-storage-note");
    expect(note.textContent).toContain("master.key");
    expect(note.textContent).toContain("MOKA_METADATA_KEY");
  });

  it("explains a missing master key instead of only reporting it", async () => {
    refuseNextWrite = {
      status: 503,
      code: "CONFIG_METADATA_KEY_MISSING",
      message: "no master key protects stored credentials",
    };
    await openSettings();
    fireEvent.click(
      within(cardOf("Scribe")).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(await screen.findByLabelText("API key"), {
      target: { value: KEY },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    expect(
      await screen.findByText("no master key protects stored credentials"),
    ).toBeTruthy();
    const guidance = await screen.findByTestId("error-guidance");
    expect(guidance.textContent).toContain("--generate-key");
    expect(guidance.textContent).toContain("MOKA_METADATA_KEY");
  });

  it("reports a model that refuses the probe inside the dialog", async () => {
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", {
        name: "Test the connection to Writer",
      }),
    );
    expect(await screen.findByText("Reached in 42 ms")).toBeTruthy();
  });

  it("reports a probe a provider refused beside the model it is about", async () => {
    probeRefusal = "the provider rejected the stored credential";
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", {
        name: "Test the connection to Writer",
      }),
    );
    const report = await screen.findByRole("status");
    expect(report.textContent).toContain("PROVIDER_AUTH");
    expect(report.textContent).toContain("the provider rejected");
  });

  it("closes on escape", async () => {
    await openSettings();
    await screen.findByText("Writer");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
