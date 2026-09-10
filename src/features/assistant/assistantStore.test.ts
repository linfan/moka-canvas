import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MokaFile,
  NodeId,
  RunRecord,
  RunStatus,
  SessionId,
} from "../../shared/domain";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useRunStore } from "../editor/stores/runStore";
import { useAssistantStore } from "./assistantStore";

/** A stream that can be fed a frame at a time, the way one arrives. */
function openStream() {
  const encoder = new TextEncoder();
  let control: ReadableStreamDefaultController<Uint8Array> | null = null;
  let over = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
    },
  });
  return {
    body,
    push: (frame: string) => {
      if (!over) control?.enqueue(encoder.encode(frame));
    },
    finish: () => {
      over = true;
      control?.close();
    },
    /** What a stopped fetch does to the read waiting on it. */
    cut: () => {
      if (over) return;
      over = true;
      control?.error(new DOMException("Aborted", "AbortError"));
    },
  };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A fetch that answers with a stream the test is still holding.
 *
 * Honouring the signal matters: a stub that ignored it could not be stopped,
 * and a turn that cannot be stopped cannot be shown to keep what had arrived.
 */
function stubStream() {
  const held = openStream();
  const fetchMock = vi.fn<typeof fetch>((_input, init) => {
    init?.signal?.addEventListener("abort", held.cut);
    return Promise.resolve(
      new Response(held.body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { ...held, calls: fetchMock };
}

/** An answer that arrives whole and closes at once. */
function stubAnswer(said: string, closing?: Record<string, unknown>) {
  const held = stubStream();
  held.push(frame("delta", { text: said }));
  held.push(
    frame("done", {
      status: "succeeded",
      outputs: [],
      text: said,
      ...closing,
    }),
  );
  held.finish();
  return held;
}

function hydrate(moka?: MokaFile) {
  const document = moka ?? buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: document,
    selfCheck: { ok: true, issues: [] },
  });
  return document;
}

function board(moka: MokaFile) {
  return moka.canvas[0];
}

function sessionsOf() {
  const moka = useProjectStore.getState().moka;
  return moka?.canvas[0].sessions ?? [];
}

/**
 * The server a turn asked of a card goes over.
 *
 * Four calls, in an order that matters: the save that carries the card to disk,
 * the run built from it, the record read once it ends, and the document read that
 * brings what the run made. The last returns what the store is already holding,
 * which is what lets a test see whether a line written after the run landed on
 * the document the run changed or on the reading that was there before it.
 */
function stubRunServer(
  options: {
    status?: RunStatus;
    made?: number;
    stepError?: string;
    /** Keeps the record unreadable until the test says, so a wait can be stopped. */
    holdRecord?: boolean;
  } = {},
) {
  const T = "2026-01-01T00:00:00.000Z";
  const runId = "r-asked";
  const order: string[] = [];
  const started: { nodeIds: NodeId[]; askedBy: SessionId | null } = {
    nodeIds: [],
    askedBy: null,
  };
  let land = () => {};
  let held: Promise<void> = Promise.resolve();
  const settled = options.status ?? "succeeded";

  const record = (status: RunStatus): RunRecord => ({
    id: runId,
    projectId: "p-1",
    canvasId: board(useProjectStore.getState().moka!).id,
    requestedNodeIds: started.nodeIds,
    status,
    executorKey: "stub",
    graphHash: "h-1",
    parameters: {},
    assistantSessionId: started.askedBy ?? undefined,
    steps: started.nodeIds.map((nodeId) => ({
      nodeId,
      status,
      ...(options.stepError ? { error: options.stepError } : {}),
      ...(status === "succeeded" && (options.made ?? 0) > 0
        ? {
            outputAssetIds: Array.from(
              { length: options.made ?? 0 },
              (_, at) => `asset-made-${at}`,
            ),
          }
        : {}),
    })),
    cancelRequested: status === "cancelled",
    createdAt: T,
    updatedAt: T,
  });

  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined
        ? {}
        : (JSON.parse(init.body as string) as Record<string, unknown>);

    if (method === "POST" && path.endsWith("/projects/current/commands")) {
      order.push("commands");
      return json({ revision: 2, updatedAt: T });
    }
    if (method === "POST" && path.endsWith("/current/runs")) {
      order.push("start");
      started.nodeIds = body.nodeIds as NodeId[];
      started.askedBy = (body.assistantSessionId as SessionId) ?? null;
      if (options.holdRecord) {
        held = new Promise<void>((resolve) => {
          land = resolve;
        });
      }
      return json(record("queued"));
    }
    if (method === "POST" && path.endsWith("/cancel")) {
      order.push("cancel");
      return json(record("cancelled"));
    }
    if (method === "GET" && /\/current\/runs\/[^/]+$/.test(path)) {
      order.push("record");
      await held;
      return json(record(settled));
    }
    if (method === "GET" && path.endsWith("/projects/current")) {
      order.push("current");
      return json({
        root: "/tmp/moka-test",
        moka: useProjectStore.getState().moka,
        selfCheck: { ok: true, issues: [] },
      });
    }
    throw new Error(`Nothing was stubbed for ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { order, started, runId, release: () => land() };
}

function cardOf(title: string) {
  const canvas = board(useProjectStore.getState().moka!);
  const found = canvas.nodes.find((node) => node.title === title);
  if (!found) throw new Error(`No card called ${title} on the canvas`);
  return found;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useRunStore.getState().reset();
  useAssistantStore.setState({
    intent: "answer",
    draft: "",
    asking: null,
    saying: "",
    busy: false,
  });
});

afterEach(() => {
  useRunStore.getState().reset();
  useProjectStore.getState().close();
  vi.unstubAllGlobals();
});

describe("one turn", () => {
  it("writes itself down once, as one thing to undo", async () => {
    const moka = hydrate();
    const stream = stubAnswer("It floats over the lake.");
    useAssistantStore.getState().setDraft("What is happening here?");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    const held = sessionsOf();
    expect(held).toHaveLength(1);
    expect(held[0].messages.map((line) => line.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(held[0].messages[1].text).toBe("It floats over the lake.");
    // One turn, however many pieces it was shown in.
    expect(useProjectStore.getState().pending).toHaveLength(1);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(stream.calls).toHaveBeenCalledTimes(1);
  });

  it("is named after what was first asked of it", async () => {
    const moka = hydrate();
    stubAnswer("So it does.");
    useAssistantStore.getState().setDraft("  What   is the lantern doing?  ");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    expect(sessionsOf()[0].title).toBe("What is the lantern doing?");
  });

  it("carries on in the conversation that was last talked in", async () => {
    const moka = hydrate();
    stubAnswer("First.");
    useAssistantStore.getState().setDraft("What is happening here?");
    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    // Read back out of the document, the way the panel does: the canvas handed
    // over before the first turn is one the first turn has already changed.
    stubAnswer("Second.");
    useAssistantStore.getState().setDraft("And the lake?");
    await useAssistantStore
      .getState()
      .ask({ canvas: board(useProjectStore.getState().moka!), chosen: [] });

    const held = sessionsOf();
    expect(held).toHaveLength(1);
    expect(held[0].messages.map((line) => line.text)).toEqual([
      "What is happening here?",
      "First.",
      "And the lake?",
      "Second.",
    ]);
    expect(useProjectStore.getState().pending).toHaveLength(2);
  });

  it("reaches nothing in the document while an answer is arriving", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(frame("delta", { text: "It floats" }));
    await flush();

    expect(sessionsOf()).toEqual([]);
    expect(useProjectStore.getState().pending).toEqual([]);
    // Shown, but not yet a line.
    expect(useAssistantStore.getState().saying).toBe("It floats");
    expect(useAssistantStore.getState().busy).toBe(true);

    stream.push(
      frame("done", {
        status: "succeeded",
        outputs: [],
        text: "It floats over.",
      }),
    );
    stream.finish();
    await going;

    expect(sessionsOf()[0].messages[1].text).toBe("It floats over.");
    expect(useAssistantStore.getState().saying).toBe("");
  });

  it("keeps what had arrived when it is stopped, and says so", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(frame("delta", { text: "It floats over" }));
    await flush();
    useAssistantStore.getState().stop();
    await going;

    const held = sessionsOf()[0];
    expect(held.messages[1].role).toBe("assistant");
    expect(held.messages[1].text).toBe("It floats over");
    expect(useAssistantStore.getState().busy).toBe(false);
  });

  it("records a turn stopped before anything came as one to ask again", async () => {
    const moka = hydrate();
    stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    await flush();
    useAssistantStore.getState().stop();
    await going;

    const held = sessionsOf()[0];
    expect(held.messages[1].role).toBe("error");
    expect(held.messages[1].failure).toEqual({
      code: "GENERATION_CANCELLED",
      retryable: true,
    });
  });

  it("keeps a refusal as a line rather than losing the question", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(
      frame("done", {
        error: {
          code: "PROVIDER_RATE_LIMIT",
          message: "Too many asks at once.",
          retryable: true,
        },
      }),
    );
    stream.finish();
    await going;

    const held = sessionsOf()[0];
    expect(held.messages.map((line) => line.role)).toEqual(["user", "error"]);
    expect(held.messages[1].text).toBe("Too many asks at once.");
    expect(held.messages[1].failure).toEqual({
      code: "PROVIDER_RATE_LIMIT",
      retryable: true,
    });
    // A question that was asked is still a question that was asked.
    expect(useProjectStore.getState().pending).toHaveLength(1);
  });

  it("takes the whole answer rather than the pieces it was shown as", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    stream.push(frame("delta", { text: "It floats " }));
    stream.push(frame("delta", { text: "over." }));
    stream.push(
      frame("done", {
        status: "succeeded",
        outputs: [],
        text: "It floats over the lake.",
      }),
    );
    stream.finish();
    await going;

    expect(sessionsOf()[0].messages[1].text).toBe("It floats over the lake.");
  });
});

describe("what is sent", () => {
  it("sends what the chosen card says, and names the card it came from", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const stream = stubAnswer("So it does.");
    useAssistantStore.getState().setDraft("Is the brief about water?");

    await useAssistantStore.getState().ask({
      canvas: board(moka),
      chosen: [ids.text],
    });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      prompt: string;
      capability: string;
    };
    expect(sent.capability).toBe("text");
    expect(sent.prompt).toContain("[Brief]");
    expect(sent.prompt).toContain(
      "A lantern floats over a quiet lake at dusk.",
    );
    expect(sessionsOf()[0].messages[0].references).toEqual([
      { nodeId: ids.text, title: "Brief", kind: "text" },
    ]);
  });

  it("sends a picture by the asset it holds rather than by its bytes", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const stream = stubAnswer("A lantern.");
    useAssistantStore.getState().setDraft("What is in this one?");

    await useAssistantStore.getState().ask({
      canvas: board(moka),
      chosen: [ids.image],
    });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      inputs: { role: string; assetId: string }[];
    };
    expect(sent.inputs).toEqual([
      { role: "reference", assetId: ids.assetImage },
    ]);
  });

  it("asks for a rewrite by saying so, and for nothing else back", async () => {
    const moka = hydrate();
    const stream = stubAnswer("A lantern drifts.");
    useAssistantStore.getState().setIntent("rewrite");
    useAssistantStore.getState().setDraft("Shorter.");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    const sent = JSON.parse(stream.calls.mock.calls[0][1]!.body as string) as {
      system: string;
    };
    expect(sent.system).toContain("Return only that text");
  });
});

describe("what is not sent", () => {
  it("asks nothing when nothing has been typed", async () => {
    const moka = hydrate();
    const stream = stubAnswer("Nobody asked.");
    useAssistantStore.getState().setDraft("   ");

    await useAssistantStore.getState().ask({ canvas: board(moka), chosen: [] });

    expect(stream.calls).not.toHaveBeenCalled();
    expect(sessionsOf()).toEqual([]);
    expect(useProjectStore.getState().pending).toEqual([]);
  });

  it("sends one ask at a time", async () => {
    const moka = hydrate();
    const stream = stubStream();
    useAssistantStore.getState().setDraft("What is happening here?");

    const first = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });
    useAssistantStore.getState().setDraft("And then?");
    const second = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [] });

    await second;
    // The second was not sent into the middle of the first: it would have been
    // written down as an answer to a question that had not been answered yet.
    expect(stream.calls).toHaveBeenCalledTimes(1);
    expect(useAssistantStore.getState().busy).toBe(true);

    stream.push(
      frame("done", { status: "succeeded", outputs: [], text: "It floats." }),
    );
    stream.finish();
    await first;
    expect(sessionsOf()[0].messages).toHaveLength(2);
  });
});

describe("a turn asked of a card", () => {
  it("puts the card on the canvas and records what the run made", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const asked = "A wider shot of the lake";
    const server = stubRunServer({ made: 1 });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft(asked);

    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });

    const canvas = board(useProjectStore.getState().moka!);
    const card = cardOf(asked);
    expect(card.kind).toBe("image");
    expect(
      (card.data as { generation: { prompt: string } }).generation.prompt,
    ).toBe(asked);
    // What the ask was about reaches the generation over the graph, which is
    // why the card is wired before it is run.
    const wires = canvas.edges.filter((edge) => edge.target.nodeId === card.id);
    expect(wires.map((edge) => edge.source.nodeId)).toEqual([ids.text]);

    const held = sessionsOf()[0];
    expect(held.title).toBe(asked);
    expect(held.messages.map((line) => line.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(held.messages[1].text).toBe("Made 1 image");
    expect(held.messages[1].toolCalls).toEqual([
      { runId: server.runId, nodeId: card.id, summary: "Made 1 image" },
    ]);

    // The run is built from the document on disk, so the card has to be saved
    // before it is asked to drive anything — and what the run made arrives by
    // that document being read back, which the line has to wait for.
    expect(server.order).toEqual(["commands", "start", "record", "current"]);
    expect(server.started.nodeIds).toEqual([card.id]);
    // Filed with the conversation that asked, which is whose the answer is.
    expect(server.started.askedBy).toBe(held.id);
    // The card and the conversation are separate things to undo: taking back
    // what was said should not quietly delete a picture that was paid for.
    expect(useHistoryStore.getState().undoStack).toHaveLength(2);
  });

  it("leaves a card that reached nothing out of what the turn was about", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    stubRunServer({ made: 1 });
    useAssistantStore.getState().setIntent("audio");
    useAssistantStore.getState().setDraft("Read it aloud");

    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.image] });

    // A sound card takes words, so the picture named contributed nothing to what
    // came back, and the line does not claim it did.
    expect(cardOf("Read it aloud").kind).toBe("audio");
    const canvas = board(useProjectStore.getState().moka!);
    expect(canvas.edges).toHaveLength(board(moka).edges.length);
    expect(sessionsOf()[0].messages[0].references).toBeUndefined();
    expect(sessionsOf()[0].messages[1].text).toBe("Made 1 sound");
  });

  it("keeps a card whose run did not finish as one to ask again from", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const asked = "A wider shot of the lake";
    stubRunServer({
      status: "failed",
      stepError: "No model would take the ask.",
    });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft(asked);

    await useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });

    // The card stays where it landed: it is the asking again, and it was paid
    // for by the run that did not come back.
    expect(cardOf(asked).kind).toBe("image");
    const line = sessionsOf()[0].messages[1];
    expect(line.role).toBe("error");
    expect(line.text).toBe("No model would take the ask.");
    expect(line.failure).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(line.toolCalls?.[0].summary).toBe("Made nothing");
  });

  it("asks the run to give up rather than only stopping the waiting", async () => {
    const moka = hydrate();
    const ids = goldenNodeIds();
    const server = stubRunServer({
      status: "cancelled",
      holdRecord: true,
    });
    useAssistantStore.getState().setIntent("image");
    useAssistantStore.getState().setDraft("A wider shot");

    const going = useAssistantStore
      .getState()
      .ask({ canvas: board(moka), chosen: [ids.text] });
    await flush();
    useAssistantStore.getState().stop();
    await going;
    server.release();
    await flush();

    // Aborting the ask alone would leave the generation being paid for behind a
    // panel that had stopped looking at it.
    expect(server.order).toContain("cancel");
    const line = sessionsOf()[0].messages[1];
    expect(line.role).toBe("error");
    expect(line.text).toBe("Stopped. The card is on the canvas to ask again.");
    expect(line.failure).toEqual({
      code: "GENERATION_CANCELLED",
      retryable: true,
    });
  });
});
