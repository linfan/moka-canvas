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

/**
 * The converter registry as the server reports it: protocols grouped by the
 * capability they serve, the way deploy writes meta.json.
 */
const REGISTRY = {
  text: {
    openaiChat: {
      script: "text/openai-chat.lua",
      displayName: "OpenAI-compatible · Chat Completions",
      urlExample: "https://api.openai.com/v1/chat/completions",
    },
    openaiResponses: {
      script: "text/openai-responses.lua",
      displayName: "OpenAI-compatible · Responses API",
      urlExample: "https://api.openai.com/v1/responses",
    },
    gemini: {
      script: "text/gemini.lua",
      displayName: "Google Gemini · generateContent",
      urlExample:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    },
  },
  image: {
    openaiImages: {
      script: "image/openai-images.lua",
      displayName: "OpenAI-compatible · Images API",
      urlExample: "https://api.openai.com/v1/images/generations",
    },
  },
  audio: {
    openaiSpeech: {
      script: "audio/openai-speech.lua",
      displayName: "OpenAI-compatible · Speech API",
      urlExample: "https://api.openai.com/v1/audio/speech",
    },
    bailianSpeech: {
      script: "audio/bailian-speech.lua",
      displayName: "Alibaba Cloud · Bailian Speech (CosyVoice TTS)",
      urlExample: "https://ws.cn-beijing.maas.aliyuncs.com/tts",
    },
  },
  video: {
    openaiVideos: {
      script: "video/openai-videos.lua",
      displayName: "OpenAI-compatible · Videos API",
      urlExample: "https://api.openai.com/v1/videos",
    },
    geminiVideo: {
      script: "video/gemini-video.lua",
      displayName: "Google Gemini · long-running (Veo)",
      urlExample:
        "https://generativelanguage.googleapis.com/v1beta/models/veo-3:predictLongRunning",
    },
    bailianVideo: {
      script: "video/bailian-video.lua",
      displayName: "Alibaba Cloud · Bailian Video",
      urlExample: "https://ws.cn-beijing.maas.aliyuncs.com/video-synthesis",
    },
  },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

let view: ModelsView;
let calls: Call[];
/** Lets a test make the next write fail the way the server would. */
let refuseNextWrite: { status: number; code: string; message: string } | null;

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
      ? { set: true, masked: MASKED, rotatedAt: "2025-01-02T03:04:05Z" }
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
        ratio: "16:9",
      },
      audio: {
        voice: "alloy",
        format: "mp3",
        speed: 1,
        instructions: "",
        sampleRate: 22050,
        volume: 50,
        rate: 1,
        pitch: 1,
      },
    },
    secretStorage: "file",
    secretStorageOptions: ["file", "keyring"],
    secretStoragePref: "file",
  };
}

function upsert(draft: ModelDraft) {
  const stored = view.models.find((entry) => entry.id === draft.id);
  // A creation may name a configuration to take the credential from; an
  // edit keeps whatever is stored, the way the server does.
  const copied =
    stored === undefined && draft.copyKeyFrom
      ? view.models.find((entry) => entry.id === draft.copyKeyFrom)?.apiKey
      : undefined;
  const key = draft.apiKey?.trim()
    ? { set: true, masked: MASKED }
    : (stored?.apiKey ?? copied ?? { set: false, masked: null });
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

  if (path === "/api/v1/converter/protocols" && method === "GET") {
    return json({ protocols: REGISTRY });
  }

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

  if (path === "/api/v1/system/secret-storage" && method === "PUT") {
    const { storage } = body as { storage: "file" | "keyring" };
    view = {
      ...view,
      revision: view.revision + 1,
      secretStorage: storage,
      secretStoragePref: storage,
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

  it("suggests an identifier from the display name", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );

    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "GPT-4o mini (OpenAI)" },
    });
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "gpt-4o-mini" },
    });

    // Readable, and nobody had to invent it.
    const id = screen.getByLabelText("Model identifier") as HTMLInputElement;
    const suggested = id.value;
    expect(suggested).toMatch(/^gpt-4o_mini_openai_[a-z0-9]{6}$/);

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("GPT-4o mini (OpenAI)");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({
      id: suggested,
      category: "text",
      displayName: "GPT-4o mini (OpenAI)",
    });
  });

  it("hands the identifier back to the suggestion when it is cleared", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );
    fireEvent.change(await screen.findByLabelText("Display name"), {
      target: { value: "Composer" },
    });
    const id = screen.getByLabelText("Model identifier") as HTMLInputElement;

    // Typing one takes over.
    fireEvent.change(id, { target: { value: "my-own" } });
    expect(id.value).toBe("my-own");

    // Clearing it does not leave the form with nothing to save.
    fireEvent.change(id, { target: { value: "" } });
    expect(id.value).toMatch(/^composer_[a-z0-9]{6}$/);

    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "composer-1" },
    });
    const suggested = id.value;
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Composer");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({ id: suggested });
  });

  it("says the category by the tab and the heading, not by a field of its own", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );

    // The tab is already on Text and the heading says so again; a disabled
    // input repeating it a third time is a field nobody can act on.
    expect(
      screen.getByRole("heading", { name: "New text model" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Category")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Edit" }),
    );
    expect(screen.queryByLabelText("Category")).toBeNull();
    // An editor names the category in its heading instead, so the form still
    // says which kind of model is being changed.
    expect(
      screen.getByRole("heading", { name: "Edit “Writer” · text" }),
    ).toBeTruthy();
    // What the category decides is still visible: only text protocols.
    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect(Array.from(protocol.options).map((option) => option.value)).toEqual([
      "openaiChat",
      "openaiResponses",
      "gemini",
    ]);
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
    // The registry's own scripts join the built-ins: a video the build has
    // never heard of is still one a reader can pick.
    await screen.findByRole("option", { name: /Bailian Video/ });
    expect([...protocol.options].map((option) => option.value)).toEqual([
      "openaiVideos",
      "geminiVideo",
      "bailianVideo",
    ]);

    // Picking the other shape offers its own complete address.
    fireEvent.change(protocol, { target: { value: "geminiVideo" } });
    const url = screen.getByLabelText("Endpoint URL") as HTMLInputElement;
    expect(url.value).toContain(":predictLongRunning");
    fireEvent.change(protocol, { target: { value: "bailianVideo" } });
    expect(url.value).toContain("video-synthesis");
  });

  it("lists a script the registry holds under its own capability only", async () => {
    await openSettings();
    // Gemini speaks generateContent, which the registry deploys under text
    // alone: the audio tab must not offer it, and must offer the script the
    // registry does hold there.
    fireEvent.click(await screen.findByRole("tab", { name: "Audio" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "New audio model" }),
    );

    await screen.findByRole("option", { name: /Bailian Speech/ });
    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect([...protocol.options].map((option) => option.value)).toEqual([
      "openaiSpeech",
      "bailianSpeech",
    ]);
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

  it("copies a model into a draft the save creates, key included", async () => {
    await openSettings();
    fireEvent.click(
      within(cardOf("Writer")).getByRole("button", { name: "Copy Writer" }),
    );

    // The editor opens on a draft of the copy: the fields worth repeating
    // are filled in, and nothing has been written yet.
    const display = (await screen.findByLabelText(
      "Display name",
    )) as HTMLInputElement;
    expect(display.value).toBe("Writer (copy)");
    expect(writesTo("/api/v1/models")).toHaveLength(0);

    // The credential comes along on the save: the field says so rather than
    // asking for a key nobody can read back.
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.placeholder).toContain("Writer");
    expect(key.value).toBe("");

    // The identifier is a suggestion from the name, the way a new model's
    // is — not a fixed "-copy" — and it is editable until the save.
    const id = screen.getByLabelText("Model identifier") as HTMLInputElement;
    expect(id.value).toMatch(/^writer_copy_[a-z0-9]{6}$/);
    fireEvent.change(id, { target: { value: "my-writer" } });

    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    await screen.findByText("Writer (copy)");

    const [write] = writesTo("/api/v1/models");
    expect(write.body).toMatchObject({
      id: "my-writer",
      displayName: "Writer (copy)",
      copyKeyFrom: "writer",
    });
    expect("apiKey" in (write.body as object)).toBe(false);
    // The credential came along with the copy.
    expect(
      within(cardOf("Writer (copy)")).getByText(`Key ${MASKED}`),
    ).toBeTruthy();
  });

  it("leaves the editor to its own Save and Cancel", async () => {
    await openSettings();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();

    fireEvent.click(
      await screen.findByRole("button", { name: "New text model" }),
    );
    // The form carries its own ways out; a Done beside them is a third door
    // that says nothing about the half-written form it leaves behind.
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("falls back to the first model as the default and records a hand-picked one", async () => {
    await openSettings();
    // Nothing was picked by hand, so the first model that can serve the
    // category is shown as the default a node falls back to.
    expect(screen.queryByTestId("text-gap")).toBeNull();
    expect(
      (
        screen.getByRole("radio", {
          name: "Use Writer as the default text model",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    fireEvent.click(
      await screen.findByRole("radio", {
        name: "Use Scribe as the default text model",
      }),
    );

    await waitFor(() =>
      expect(writesTo("/api/v1/models/defaults")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/defaults")[0].body).toEqual({
      text: "scribe",
      expectedRevision: 1,
    });
    // The hand-picked choice is the one shown as made.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("radio", {
            name: "Use Scribe as the default text model",
          }) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
  });

  it("shows the next model as the default when the stored one is gone", async () => {
    // The stored default points at a model the list no longer holds; the
    // first model that can serve is the default now, with no warning to act
    // on because there is nothing broken.
    view = {
      ...view,
      defaults: { ...view.defaults, text: "ghost" },
    };
    await openSettings();
    expect(screen.queryByTestId("text-gap")).toBeNull();
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

  it("moves the master key to another tier only when explicitly asked", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "System" }));

    const keyring = (await screen.findByRole("radio", {
      name: /Keyring/,
    })) as HTMLInputElement;
    expect(keyring.checked).toBe(false);
    fireEvent.click(keyring);

    await waitFor(() =>
      expect(writesTo("/api/v1/system/secret-storage")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/system/secret-storage")[0].body).toEqual({
      storage: "keyring",
    });
    await waitFor(() => expect(keyring.checked).toBe(true));
    confirm.mockRestore();
  });

  it("draws the interface in the language chosen on the system page", async () => {
    await openSettings("System");

    fireEvent.change(await screen.findByLabelText("Interface language"), {
      target: { value: "zh" },
    });

    // The dialog says its own name in the language that was chosen.
    expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
    expect(screen.getByLabelText("界面语言")).toBeTruthy();

    // And back, so the cases after this one start in English again.
    fireEvent.change(screen.getByLabelText("界面语言"), {
      target: { value: "en" },
    });
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
  });

  it("lists the stored keys masked, and deletes one on request", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "System" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage keys (2)" }),
    );

    // Both stored credentials are named, masked, and dated; the plaintext
    // a test typed elsewhere never appears.
    const writer = cardOf("Writer");
    expect(writer.textContent).toContain(MASKED);
    expect(writer.textContent).toContain("rotated 2025-01-02");
    expect(cardOf("Painter").textContent).toContain("image");
    expect(screen.queryByText(KEY)).toBeNull();

    fireEvent.click(within(writer).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(writesTo("/api/v1/models/writer/key")).toHaveLength(1),
    );
    expect(writesTo("/api/v1/models/writer/key")[0].body).toEqual({
      apiKey: null,
    });
    // The list follows the store: the cleared key is gone, the other stays.
    await waitFor(() => expect(screen.queryByText("Writer")).toBeNull());
    expect(screen.getByText("Painter")).toBeTruthy();
    confirm.mockRestore();
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

  it("closes on escape", async () => {
    await openSettings();
    await screen.findByText("Writer");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
