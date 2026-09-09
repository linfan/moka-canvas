import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./client";
import { generateApi } from "./generate";

interface Sent {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

let sent: Sent[] = [];

function stub(answer: (call: Sent) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Sent = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      sent.push(call);
      return Promise.resolve(answer(call));
    }),
  );
}

/** A stream delivered in exactly the chunks named, so a frame can be split
 * across two of them the way a real connection splits it. */
function stream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  sent = [];
  vi.unstubAllGlobals();
});

describe("generation client", () => {
  it("shows a streamed answer in pieces and hands back the whole thing", async () => {
    // The first delta is split across two chunks and the second across three,
    // so a reader that assumed a frame arrives whole would lose text.
    stub(() =>
      stream([
        'event: delta\ndata: {"text":"Hel',
        'lo"}\n\nevent: del',
        'ta\ndata: {"text":", wor',
        'ld"}\n\nevent: done\ndata: {"status":"succeeded","text":"Hello, world","outputs":[]}\n\n',
      ]),
    );

    const seen: string[] = [];
    const answer = await generateApi.textStream(
      { capability: "text", prompt: "say something" },
      (piece) => seen.push(piece),
    );

    expect(seen).toEqual(["Hello", ", world"]);
    expect(answer.status).toBe("succeeded");
    expect(answer.text).toBe("Hello, world");
    expect(answer.outputs).toEqual([]);
  });

  it("asks for a stream by parameter rather than by a separate field", async () => {
    stub(() =>
      stream(['event: done\ndata: {"status":"succeeded","outputs":[]}\n\n']),
    );

    await generateApi.textStream({
      capability: "text",
      prompt: "say something",
      params: { temperature: 0.4 },
    });

    expect(sent[0].url).toBe("/api/v1/generate/text");
    expect(sent[0].body?.params).toEqual({ temperature: 0.4, stream: true });
  });

  it("raises the failure a stream reports in its closing frame", async () => {
    // A stream has already sent its status line, so there is no second one to
    // carry a problem body; the closing frame is where the failure arrives.
    stub(() =>
      stream([
        'event: delta\ndata: {"text":"A "}\n\n',
        'event: done\ndata: {"error":{"code":"PROVIDER_UNAVAILABLE","message":"the channel went away","retryable":true}}\n\n',
      ]),
    );

    const seen: string[] = [];
    const failure = await generateApi
      .textStream({ capability: "text", prompt: "say something" }, (piece) =>
        seen.push(piece),
      )
      .catch((error: unknown) => error);

    // What arrived before the failure was still shown.
    expect(seen).toEqual(["A "]);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((failure as ApiError).details).toEqual({ retryable: true });
  });

  it("reports a stream that ended before the answer did", async () => {
    stub(() => stream(['event: delta\ndata: {"text":"A "}\n\n']));

    await expect(
      generateApi.textStream({ capability: "text", prompt: "say something" }),
    ).rejects.toThrow(/ended before the answer/);
  });

  it("sends the other capabilities as one document each", async () => {
    const answer = { status: "succeeded", outputs: [] };
    stub(() => json(answer));

    await generateApi.image({ capability: "image", prompt: "a red cube" });
    await generateApi.audio({ capability: "audio", prompt: "read this aloud" });
    await generateApi.video({ capability: "video", prompt: "a slow pan" });

    expect(sent.map((call) => call.url)).toEqual([
      "/api/v1/generate/image",
      "/api/v1/generate/audio",
      "/api/v1/generate/video",
    ]);
    expect(sent.every((call) => call.method === "POST")).toBe(true);
  });

  it("polls a job at the address its own handle names", async () => {
    stub(() =>
      json({
        status: "pending",
        outputs: [],
        task: {
          id: "a/handle",
          capability: "video",
          model: "a-channel::a-video-model",
          createdAt: "2026-01-01T00:00:00Z",
          retryAfterMs: 2500,
        },
      }),
    );

    const answer = await generateApi.pollTask("a/handle");

    // Encoded, because a handle this server issued is opaque and may carry
    // characters a path would otherwise read as a separator.
    expect(sent[0].url).toBe("/api/v1/generate/tasks/a%2Fhandle");
    expect(sent[0].method).toBe("GET");
    expect(answer.task?.retryAfterMs).toBe(2500);
  });
});
