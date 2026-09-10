// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "../../App";
import type { ChannelDraft, ChannelView, ProvidersView } from "../../api";
import { useProviderStore } from "./providerStore";

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

let view: ProvidersView;
let calls: Call[];
/** Lets a test make the next write fail the way the server would. */
let refuseNextWrite: { status: number; code: string; message: string } | null;

function fixture(): ProvidersView {
  return {
    version: 1,
    revision: 1,
    channels: [
      {
        id: "main",
        name: "Example Inc",
        baseUrl: "https://api.example.com/v1",
        protocol: "openai",
        enabled: true,
        models: [
          { id: "writer", capability: "text", alias: "", enabled: true },
          { id: "painter", capability: "image", alias: "", enabled: true },
        ],
        apiKey: { set: true, masked: MASKED },
      },
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

function upsert(draft: ChannelDraft) {
  const stored = view.channels.find((entry) => entry.id === draft.id);
  const key = draft.apiKey?.trim()
    ? { set: true, masked: MASKED }
    : (stored?.apiKey ?? { set: false, masked: null });
  const record: ChannelView = {
    id: draft.id,
    name: draft.name,
    baseUrl: draft.baseUrl,
    protocol: draft.protocol,
    enabled: draft.enabled,
    models: draft.models,
    apiKey: key,
  };
  view = {
    ...view,
    revision: view.revision + 1,
    channels: stored
      ? view.channels.map((entry) => (entry.id === draft.id ? record : entry))
      : [...view.channels, record],
  };
}

/** The identifier and protocol come from the address, as they do server-side. */
function imported(baseUrl: string, apiKey: string | null | undefined) {
  const host = baseUrl.replace(/^https?:\/\//, "").split("/")[0];
  const id = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  upsert({
    id,
    name: host,
    baseUrl,
    protocol: host.includes("googleapis") ? "gemini" : "openai",
    enabled: true,
    models: [],
    apiKey: apiKey ?? null,
  });
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

  if (path === "/api/v1/providers" && method === "GET") return json(view);

  if (path === "/api/v1/providers/channels" && method === "PUT") {
    if (refuseNextWrite) {
      const refusal = refuseNextWrite;
      refuseNextWrite = null;
      return problem(refusal.status, refusal.code, refusal.message);
    }
    upsert(body as ChannelDraft);
    return json(view);
  }

  if (path === "/api/v1/providers/defaults" && method === "PATCH") {
    const patch = body as Partial<ProvidersView["defaults"]>;
    view = {
      ...view,
      revision: view.revision + 1,
      defaults: { ...view.defaults, ...patch },
    };
    return json(view);
  }

  if (path === "/api/v1/providers/preferences" && method === "PATCH") {
    const patch = body as Partial<ProvidersView["preferences"]>;
    view = {
      ...view,
      revision: view.revision + 1,
      preferences: { ...view.preferences, ...patch },
    };
    return json(view);
  }

  if (path === "/api/v1/providers/import" && method === "POST") {
    const request = body as { baseUrl: string; apiKey?: string | null };
    imported(request.baseUrl, request.apiKey);
    return json(view);
  }

  const channel = path.match(
    /^\/api\/v1\/providers\/channels\/([^/]+)(\/.*)?$/,
  );
  if (channel) {
    const id = decodeURIComponent(channel[1]);
    const suffix = channel[2] ?? "";
    const index = view.channels.findIndex((entry) => entry.id === id);
    if (index === -1) return problem(404, "NOT_FOUND", `no channel ${id}`);

    if (suffix === "" && method === "DELETE") {
      view = {
        ...view,
        revision: view.revision + 1,
        channels: view.channels.filter((entry) => entry.id !== id),
      };
      return json(view);
    }
    if (suffix === "/key" && method === "POST") {
      const { apiKey } = body as { apiKey: string | null };
      view = {
        ...view,
        revision: view.revision + 1,
        channels: view.channels.map((entry, at) =>
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
    if (suffix === "/models" && method === "GET") {
      return json({
        models: [
          { id: "scribe-2", capability: null },
          { id: "illustrator-2", capability: "image" },
          { id: "choir-1", capability: "audio" },
        ],
      });
    }
    if (suffix === "/probe" && method === "POST") {
      return json({ ok: true, latencyMs: 42 });
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

/** A row puts the credential and the model count in one paragraph. */
function storedKeyLine() {
  return screen.getByText(new RegExp(`Key ${MASKED}`));
}

async function openSettings() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  return screen.findByRole("dialog", { name: "Settings" });
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
  useProviderStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("provider settings", () => {
  it("shows what may be disclosed about a credential and nothing more", async () => {
    await openSettings();
    await screen.findByText("Example Inc");

    expect(storedKeyLine()).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const field = await screen.findByLabelText("API key");
    // The form offers a placeholder, never the value it would overwrite.
    expect((field as HTMLInputElement).value).toBe("");
    expect(field.getAttribute("placeholder")).toContain(MASKED);
  });

  it("keeps a stored credential when an edit does not mention it", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save channel" }));

    await screen.findByText("Renamed");
    const [write] = writesTo("/api/v1/providers/channels");
    expect(write.body).toMatchObject({
      id: "main",
      name: "Renamed",
      apiKey: null,
      expectedRevision: 1,
    });
    // Two models went out, so the edit replaced the channel rather than
    // quietly dropping the half of it the form does not show.
    expect((write.body as ChannelDraft).models).toHaveLength(2);
    expect(storedKeyLine()).toBeTruthy();
  });

  it("creates a channel from the form", async () => {
    view.channels = [];
    await openSettings();
    await screen.findByText(/No channels yet/);

    fireEvent.click(screen.getByRole("button", { name: "New channel" }));
    fireEvent.change(await screen.findByLabelText("Identifier"), {
      target: { value: "example" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Example" },
    });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.change(screen.getByLabelText("Model 1 identifier"), {
      target: { value: "chat" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: KEY },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save channel" }));

    await screen.findByText("Example");
    const [write] = writesTo("/api/v1/providers/channels");
    expect(write.body).toMatchObject({
      id: "example",
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      protocol: "openai",
      enabled: true,
      apiKey: KEY,
      models: [{ id: "chat", capability: "text", alias: "", enabled: true }],
    });
    expect(storedKeyLine()).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("adds a channel from an address alone", async () => {
    await openSettings();
    fireEvent.change(await screen.findByLabelText("Provider address"), {
      target: { value: "https://generativelanguage.googleapis.com/v1beta/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await screen.findByText("generativelanguage.googleapis.com");
    const [write] = writesTo("/api/v1/providers/import");
    expect(write.body).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
      apiKey: null,
      expectedRevision: 1,
    });
    expect(screen.getByText("gemini")).toBeTruthy();
  });

  it("offers each capability only the models that can serve it", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Defaults" }));

    const image = await screen.findByLabelText("Image");
    fireEvent.change(image, { target: { value: "main::painter" } });
    expect(screen.getByLabelText("Text")).toBeTruthy();
    expect(
      [...image.querySelectorAll("option")].map((option) => option.value),
    ).toEqual(["", "main::painter"]);

    const save = screen.getByRole("button", { name: "Save defaults" });
    fireEvent.click(save);
    // Disabled again only once the answered view has been adopted, so the form
    // and the configuration agree.
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(true),
    );

    const [write] = writesTo("/api/v1/providers/defaults");
    // Only the capability that moved, so a text default set elsewhere survives.
    expect(write.body).toEqual({ image: "main::painter", expectedRevision: 1 });
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

    const [write] = writesTo("/api/v1/providers/preferences");
    expect(write.body).toEqual({
      image: { size: "1:1", quality: "auto", background: "", count: 3 },
      expectedRevision: 1,
    });
  });

  it("offers what a provider lists grouped by what each model can make", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Ask Example Inc which models it offers",
      }),
    );

    // The decision is "which of these can make a picture", so the offer arrives
    // grouped that way rather than as one long list of names.
    const image = await screen.findByRole("region", {
      name: "Image models offered",
    });
    expect(image.textContent).toContain("illustrator-2");
    expect(
      screen.getByRole("region", { name: "Audio models offered" }).textContent,
    ).toContain("choir-1");
    // A name the guess could not place is text, and the group says it guessed.
    const text = screen.getByRole("region", { name: "Text models offered" });
    expect(text.textContent).toContain("scribe-2");
    expect(text.textContent).toContain("guessing");
    // A listing reads, so nothing has been stored by it.
    expect(writesTo("/api/v1/providers/channels")).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add illustrator-2 to the image models",
      }),
    );
    expect(
      (screen.getByLabelText("Model 3 identifier") as HTMLInputElement).value,
    ).toBe("illustrator-2");
    // The capability came from the grouping, and is still the user's to change.
    expect(
      (screen.getByLabelText("Model 3 capability") as HTMLSelectElement).value,
    ).toBe("image");
    // Adopted into the form, not into the configuration.
    expect(writesTo("/api/v1/providers/channels")).toHaveLength(0);
    // And it is now visibly taken, so it cannot be added twice.
    expect(
      (
        screen.getByRole("button", {
          name: "Add all image models offered",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("takes a whole capability at once and narrows the offer by name", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Ask Example Inc which models it offers",
      }),
    );
    await screen.findByRole("region", { name: "Audio models offered" });

    fireEvent.change(
      screen.getByLabelText("Filter the models the provider offers"),
      { target: { value: "choir" } },
    );
    // Only the matching group is left, so "Add all" cannot sweep in models
    // nobody filtered for.
    expect(
      screen.queryByRole("region", { name: "Image models offered" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Add all audio models offered" }),
    );

    expect(
      (screen.getByLabelText("Model 3 identifier") as HTMLInputElement).value,
    ).toBe("choir-1");
    expect(
      (screen.getByLabelText("Model 3 capability") as HTMLSelectElement).value,
    ).toBe("audio");
    expect(writesTo("/api/v1/providers/channels")).toHaveLength(0);
  });

  it("reports a refused write and shows the state that refused it", async () => {
    refuseNextWrite = {
      status: 409,
      code: "METADATA_CONFLICT",
      message: "the configuration changed underneath this edit",
    };
    await openSettings();
    const readsBefore = readsOf("/api/v1/providers");

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save channel" }));

    expect(
      await screen.findByText("the configuration changed underneath this edit"),
    ).toBeTruthy();
    // The view was re-read, so the form is not left holding a stale revision.
    expect(readsOf("/api/v1/providers")).toBeGreaterThan(readsBefore);
  });

  it("says how strongly the stored keys are protected", async () => {
    await openSettings();
    await screen.findByText("Example Inc");

    // The file tier is the weaker one, so the warning belongs where a key is
    // typed, not only in the deployment docs.
    const note = screen.getByTestId("secret-storage-note");
    expect(note.textContent).toContain("master.key");
    expect(note.textContent).toContain("MOKA_METADATA_KEY");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByLabelText("API key");
    expect(screen.getByTestId("secret-storage-note").textContent).toContain(
      "master.key",
    );
  });

  it("explains a missing master key instead of only reporting it", async () => {
    refuseNextWrite = {
      status: 503,
      code: "CONFIG_METADATA_KEY_MISSING",
      message: "no master key protects stored credentials",
    };
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("API key"), {
      target: { value: KEY },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save channel" }));

    expect(
      await screen.findByText("no master key protects stored credentials"),
    ).toBeTruthy();
    const guidance = await screen.findByTestId("error-guidance");
    expect(guidance.textContent).toContain("--generate-key");
    expect(guidance.textContent).toContain("MOKA_METADATA_KEY");
  });

  it("reports a channel that refuses the probe inside the dialog", async () => {
    await openSettings();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Test the connection to Example Inc",
      }),
    );
    expect(await screen.findByText("Reached in 42 ms")).toBeTruthy();
  });

  it("closes on escape", async () => {
    await openSettings();
    await screen.findByText("Example Inc");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
