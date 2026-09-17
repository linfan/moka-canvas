import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

/**
 * Where the stand-in provider listens.
 *
 * A fixed port rather than one chosen as it binds: the server under test is
 * booted by the runner before any test could say where a channel should point,
 * and the address ends up typed into a dialog by a browser.
 */
export const PROVIDER_PORT = Number(process.env.MOKA_E2E_PROVIDER_PORT ?? 8972);
/** Where the stand-in's own bookkeeping routes are, beside the ones it serves. */
export const PROVIDER_ORIGIN = `http://127.0.0.1:${PROVIDER_PORT}`;
export const PROVIDER_ADDRESS = `${PROVIDER_ORIGIN}/v1`;

/** The two models on offer, one per capability the suite drives. */
export const PAINTER = "painter";
export const STORYTELLER = "storyteller";

/**
 * What the stand-in says, whole and in the pieces it arrives in.
 *
 * MOKA_E2E_TEXT swaps in another sentence — the website screenshot capture is
 * the only caller — and the default the tests assert against is untouched by it.
 */
export const SENTENCE =
  process.env.MOKA_E2E_TEXT ?? "A lantern drifts over a quiet lake.";
const PIECES = (() => {
  if (!process.env.MOKA_E2E_TEXT) {
    return ["A lantern ", "drifts over ", "a quiet lake."];
  }
  const third = Math.ceil(SENTENCE.length / 3);
  return [
    SENTENCE.slice(0, third),
    SENTENCE.slice(third, third * 2),
    SENTENCE.slice(third * 2),
  ];
})();

/**
 * One 1x1 transparent PNG, which is all an ingest path needs to be real.
 *
 * MOKA_E2E_PICTURE points at a picture the stand-in should paint with instead —
 * the website screenshot capture is the only caller, and the default the tests
 * run against is untouched by it.
 */
const PICTURE = (() => {
  const custom = process.env.MOKA_E2E_PICTURE;
  if (!custom) {
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  }
  return readFileSync(custom).toString("base64");
})();

/** What the stand-in was asked for, holding nothing a credential could be in. */
export interface ProviderCall {
  path: string;
  model: string;
  prompt: string;
  count: number;
  /** Whether a request arrived carrying a credential, never what it was. */
  credentialed: boolean;
}

export interface MockProvider {
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((whole, failed) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => whole(Buffer.concat(chunks).toString("utf8")));
    request.on("error", failed);
  });
}

/** The last thing said to a chat endpoint, which is where its prompt travels. */
function lastMessage(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const content = (messages[messages.length - 1] as { content?: unknown })
    ?.content;
  return typeof content === "string" ? content : "";
}

/** Writes an answer as a server-sent stream, a piece at a time. */
async function streamText(response: ServerResponse, answers: boolean) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const write = (frame: unknown) =>
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  for (const piece of PIECES) {
    write(
      answers
        ? { type: "response.output_text.delta", delta: piece }
        : { choices: [{ delta: { content: piece } }] },
    );
    // Held apart so the stream is one a listener can hear arriving rather than
    // a single write that happens to be chunked.
    await sleep(40);
  }
  write(
    answers
      ? {
          type: "response.completed",
          response: {
            output_text: SENTENCE,
            usage: { input_tokens: 4, output_tokens: 6 },
          },
        }
      : {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        },
  );
  write("[DONE]");
  response.end();
}

/**
 * A provider that answers without being one.
 *
 * What the suite has to prove is the whole path: a node's spec, a run, a call
 * out, an answer filed as an asset, and the panel that shows it. The part a
 * real provider contributes to that is only "an answer arrives in this shape",
 * so serving the shape locally leaves everything else the real thing.
 */
export async function startMockProvider(): Promise<MockProvider> {
  const calls: ProviderCall[] = [];

  const server = createServer((request, response) => {
    void answer(request, response);
  });

  async function answer(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(
      request.url ?? "/",
      `http://127.0.0.1:${PROVIDER_PORT}`,
    ).pathname;
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
      });
      response.end(payload);
    };
    const missing = () =>
      send(404, {
        error: { message: `the stand-in has no route for ${path}` },
      });

    if (path === "/__calls" && request.method === "GET") {
      return send(200, { calls });
    }
    if (path === "/__reset" && request.method === "POST") {
      calls.length = 0;
      return send(200, { ok: true });
    }
    if (request.method !== "POST") return missing();

    const raw = await bodyOf(request);
    let body: Record<string, unknown> = {};
    try {
      body =
        raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return send(400, { error: { message: "the request was not JSON" } });
    }
    const prompt = String(body.prompt ?? "") || lastMessage(body);
    calls.push({
      path,
      model: String(body.model ?? ""),
      prompt,
      count: Number(body.n ?? 1),
      credentialed: Boolean(request.headers.authorization),
    });

    // A marker word in a prompt is a direction to the stand-in rather than part
    // of it: refuse, so that a run which gave up exists to be looked at.
    // MOKA_E2E_REFUSAL_STATUS and MOKA_E2E_REFUSAL_MESSAGE swap in another
    // refusal — the website screenshot capture is the only caller — and the
    // defaults the tests assert against are untouched by them.
    if (prompt.includes("[refuse]")) {
      return send(Number(process.env.MOKA_E2E_REFUSAL_STATUS ?? 500), {
        error: {
          message:
            process.env.MOKA_E2E_REFUSAL_MESSAGE ??
            "the stand-in will not paint that",
        },
      });
    }

    if (path === "/v1/images/generations") {
      const count = Math.max(1, Number(body.n ?? 1));
      return send(200, {
        created: 1700000000,
        data: Array.from({ length: count }, () => ({
          b64_json: PICTURE,
          revised_prompt: String(body.prompt ?? ""),
        })),
      });
    }
    if (path === "/v1/chat/completions") {
      return streamText(response, false);
    }
    if (path === "/v1/responses") {
      return streamText(response, true);
    }
    return missing();
  }

  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(PROVIDER_PORT, "127.0.0.1", listening);
  });

  return {
    stop: () =>
      new Promise<void>((stopped) => {
        server.closeAllConnections();
        server.close(() => stopped());
      }),
  };
}
